<#
.SYNOPSIS
  Launch one SE instance of the QA tool.

.DESCRIPTION
  This is the native-Windows equivalent of one `se*` service in
  deploy/docker-compose.yml, and it carries the same isolation mechanism:
  the instance is given SHOPIFY_TEST_STORES for ITS SE ONLY.

  getShopifyClient() throws ShopifyConfigError for any storeId it has no config
  for (server/src/services/shopifyClient.ts), so an instance cannot touch a store
  whose credentials are not in its own environment. There is no check to bypass
  and no header to spoof, because the token is not in the process.

  That is the whole boundary. If you ever "simplify" this by giving every
  instance the full store list, you have deleted the only isolation this
  deployment has -- there is NO authentication in front of it.

  Run by the scheduled tasks created by Register-Instances.ps1. Safe to run by
  hand for debugging.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^SE[1-9][0-9]*$')]
  [string]$Instance,

  [string]$AppRoot    = 'C:\apps\qa-shopify-tool',
  [string]$ConfigFile = 'C:\ProgramData\qa-shopify-tool\deploy.env',
  [string]$LogDir     = 'C:\ProgramData\qa-shopify-tool\logs',

  # 20 MB, then roll to .1. Nothing else prunes these files: a crash loop writing
  # unbounded logs onto the system drive is its own outage.
  [int]$MaxLogBytes = 20MB
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ── Parse the shared env file ───────────────────────────────────────────────
#
# Values may be single- or double-quoted and MAY SPAN LINES: the store lists are
# pretty-printed JSON in deploy/.env.example, and a naive line-at-a-time parser
# silently truncates them to their first line, producing a store list that parses
# as invalid JSON at boot. Hence the explicit open-quote scan.
function Read-DotEnv {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Config file not found: $Path (copy deploy/.env there -- it is never in the git checkout)"
  }

  $map   = @{}
  $lines = [System.IO.File]::ReadAllLines($Path)
  $i     = 0

  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    $i++

    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }

    $key  = $Matches[1]
    $rest = $Matches[2]

    $quote = $null
    if ($rest.Length -gt 0 -and ($rest[0] -eq "'" -or $rest[0] -eq '"')) { $quote = $rest[0] }

    if ($null -eq $quote) {
      # Unquoted: strip a trailing inline comment, then trim.
      $map[$key] = ($rest -replace '\s+#.*$', '').Trim()
      continue
    }

    $body = $rest.Substring(1)
    if ($body.EndsWith($quote)) {
      $map[$key] = $body.Substring(0, $body.Length - 1)
      continue
    }

    # Quote left open: keep consuming lines until it closes.
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append($body)
    $closed = $false
    while ($i -lt $lines.Count) {
      $next = $lines[$i]
      $i++
      if ($next.EndsWith($quote)) {
        [void]$sb.Append("`n").Append($next.Substring(0, $next.Length - 1))
        $closed = $true
        break
      }
      [void]$sb.Append("`n").Append($next)
    }
    if (-not $closed) { throw "Unterminated $quote quote for $key in $Path" }
    $map[$key] = $sb.ToString()
  }

  return $map
}

$cfg = Read-DotEnv -Path $ConfigFile

# ── Resolve this instance's stores ──────────────────────────────────────────
$storesKey = "SHOPIFY_STORES_$Instance"
$stores    = $cfg[$storesKey]
if ([string]::IsNullOrWhiteSpace($stores)) {
  throw "$storesKey is missing or empty in $ConfigFile. Refusing to start $Instance with no stores."
}

# Fail here rather than 40 lines into Node with a stack trace.
try { $null = $stores | ConvertFrom-Json } catch { throw "$storesKey is not valid JSON: $($_.Exception.Message)" }

# Port: SE1 -> 3101 ... SE7 -> 3107. Deliberately not 3001, which is the dev API
# port -- see deploy/.env.example.
$n    = [int]($Instance -replace '^SE', '')
$port = 3100 + $n

$pgPassword = $cfg['POSTGRES_PASSWORD']
if ([string]::IsNullOrWhiteSpace($pgPassword)) { throw "POSTGRES_PASSWORD is missing in $ConfigFile" }

$dbUrl = $cfg['DATABASE_URL']
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  $escaped = [uri]::EscapeDataString($pgPassword)
  $dbUrl   = "postgresql://postgres:$escaped@127.0.0.1:5432/shopify_csv_qa"
}

# ── Environment ─────────────────────────────────────────────────────────────
#
# Set in the PROCESS, not in a .env file. The app calls dotenv.config(), which
# does not override variables that are already set, so these win even if a stray
# server/.env exists on the box.
$env:NODE_ENV                  = 'production'
$env:PORT                      = "$port"
$env:DATABASE_URL              = $dbUrl
$env:SHOPIFY_TEST_STORES       = $stores
$env:BIND_ADDR                 = if ($cfg['BIND_ADDR']) { $cfg['BIND_ADDR'] } else { '0.0.0.0' }
$env:SHOPIFY_API_VERSION       = $cfg['SHOPIFY_API_VERSION']
$env:DATABASE_CONNECTION_LIMIT = if ($cfg['DATABASE_CONNECTION_LIMIT']) { $cfg['DATABASE_CONNECTION_LIMIT'] } else { '5' }
$env:UPLOAD_DIR                = Join-Path $env:TEMP "qa-uploads-$($Instance.ToLower())"

# RETENTION_DAYS is deliberately NOT set, and must not be set here.
#
# All seven instances share one database, so a value set for one deletes
# everyone's rows and the most aggressive value wins. It defaults to 0 (off).
# A forgotten retention variable irreversibly gutted 47 real validation runs on
# 2026-07-14. If you ever turn it on, read the retention section of
# docs/DEPLOY.md, set it identically for all seven, and set RETENTION_CONFIRMED
# only after reading the count it refuses on.
$env:RETENTION_DAYS      = $null
$env:RETENTION_CONFIRMED = $null

New-Item -ItemType Directory -Force -Path $env:UPLOAD_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir         | Out-Null

# ── Log rotation ────────────────────────────────────────────────────────────
$logFile = Join-Path $LogDir "$($Instance.ToLower()).log"
if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt $MaxLogBytes)) {
  $rolled = "$logFile.1"
  if (Test-Path -LiteralPath $rolled) { Remove-Item -LiteralPath $rolled -Force }
  Move-Item -LiteralPath $logFile -Destination $rolled -Force
}

# ── Run ─────────────────────────────────────────────────────────────────────
#
# Migrations are NOT run here. Seven processes racing `prisma migrate deploy`
# against one database is the exact problem the compose stack's dedicated
# `migrate` service exists to avoid. Deploy-QaTool.ps1 runs it once.
$serverDir = Join-Path $AppRoot 'server'
$entry     = Join-Path $serverDir 'dist\index.js'
if (-not (Test-Path -LiteralPath $entry)) {
  throw "$entry not found. Run Deploy-QaTool.ps1 first."
}

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "node.exe not found" }

Set-Location $serverDir

function Write-Log { param($m) "[$(Get-Date -Format o)] $m" | Out-File -FilePath $logFile -Append -Encoding utf8 }

# ── Supervisor loop ─────────────────────────────────────────────────────────
#
# Task Scheduler's own RestartOnFailure is NOT relied on: this box registers tasks
# with UseUnifiedSchedulingEngine, and that engine does not honour restart-on-failure
# for a long-running action that exits non-zero. Verified by killing the node process
# -- the task ended with 0xFFFFFFFF and never came back.
#
# So the restart lives here, where it is fast (seconds, not a minute) and visible in
# the log. Register-Instances.ps1 additionally puts a repeating trigger on the task,
# which catches the case where THIS process dies too.
#
# Config errors are deliberately NOT retried here -- everything above this point
# throws and exits, so a bad store list fails loudly instead of spinning.
$backoff    = 2
$maxBackoff = 60

while ($true) {
  Write-Log "starting $Instance on port $port (bind $($env:BIND_ADDR))"
  $started = Get-Date

  & $nodeExe $entry *>&1 | ForEach-Object { Write-Log $_ }
  $code = $LASTEXITCODE

  $ranFor = (Get-Date) - $started
  Write-Log "node exited with $code after $([int]$ranFor.TotalSeconds)s"

  # A process that stayed up is a crash, not a misconfiguration: reset the backoff
  # so a one-off crash restarts immediately rather than inheriting an old penalty.
  if ($ranFor.TotalSeconds -ge 60) { $backoff = 2 }

  Write-Log "restarting in ${backoff}s"
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
