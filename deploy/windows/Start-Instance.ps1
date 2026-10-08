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

# -- Read the shared env file -------------------------------------------------
#
# Get-DeployConfig.ps1 is the ONE parser of deploy.env, shared with Deploy and
# Register. This script used to carry its own copy; the copies drifted, and a config
# that Deploy and Register accepted (DATABASE_URL only, no POSTGRES_PASSWORD) made
# every launcher throw at start. A config error still throws here, before the loop.
$deployCfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
$cfg       = $deployCfg.Values

# -- Resolve this instance's stores ------------------------------------------
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

# DATABASE_URL as given, or derived from POSTGRES_PASSWORD (URL-escaped) -- the
# exact URL Deploy-QaTool.ps1 migrated with.
$dbUrl = $deployCfg.DatabaseUrl

# -- Environment -------------------------------------------------------------
#
# Set in the PROCESS, not in a .env file. The app calls dotenv.config(), which
# does not override variables that are already set, so these win even if a stray
# server/.env exists on the box.
$env:NODE_ENV                  = 'production'
$env:PORT                      = "$port"
$env:DATABASE_URL              = $dbUrl
$env:SHOPIFY_TEST_STORES       = $stores
# 127.0.0.1 unless deploy.env sets BIND_ADDR: no authentication, so fail closed.
$env:BIND_ADDR                 = $deployCfg.BindAddr
$env:SHOPIFY_API_VERSION       = $cfg['SHOPIFY_API_VERSION']
$env:DATABASE_CONNECTION_LIMIT = if ($cfg['DATABASE_CONNECTION_LIMIT']) { $cfg['DATABASE_CONNECTION_LIMIT'] } else { '5' }
# Unset = the app default (5). 1 is the kill switch: one bulk op per store.
if ($cfg['BULK_OPS_PER_STORE']) { $env:BULK_OPS_PER_STORE = $cfg['BULK_OPS_PER_STORE'] }
$env:UPLOAD_DIR                = Join-Path $env:TEMP "qa-uploads-$($Instance.ToLower())"

# Whose instance this is. Serves the default display name to the browser so nobody
# types their own name into every browser they open (GET /api/instance). Unset is
# fine -- the badge just starts empty. It is a LABEL, not a login: the client can
# still send any name, and nothing is gated on it.
$env:QA_INSTANCE_OWNER         = $cfg["QA_OWNER_$Instance"]

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

# -- Log rotation ------------------------------------------------------------
#
# Checked at start, before every restart, and at most every $RollCheckSeconds while
# node is writing (from Write-Log). Checking only at launcher start was not enough:
# this launcher is long-lived by design, so a chatty or crash-looping instance grew
# its log without bound -- exactly the case the 20 MB cap exists for.
$logFile = Join-Path $LogDir "$($Instance.ToLower()).log"
$RollCheckSeconds    = 30
$script:nextRollCheck = [DateTime]::MinValue

function Invoke-LogRoll {
  $script:nextRollCheck = (Get-Date).AddSeconds($RollCheckSeconds)
  # NEVER fatal. This runs inside the pipeline that carries node's output; an
  # exception here (say, someone tailing the log holds it open and the move fails)
  # would end that pipeline and take node down with it. A failed roll just waits
  # for the next check.
  try {
    $item = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt $MaxLogBytes) {
      $rolled = "$logFile.1"
      if (Test-Path -LiteralPath $rolled) { Remove-Item -LiteralPath $rolled -Force -ErrorAction Stop }
      Move-Item -LiteralPath $logFile -Destination $rolled -Force -ErrorAction Stop
    }
  } catch { }
}

Invoke-LogRoll

# -- Run ---------------------------------------------------------------------
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

function Write-Log {
  param($m)
  $now = Get-Date
  if ($now -ge $script:nextRollCheck) { Invoke-LogRoll }
  "[$($now.ToString('o'))] $m" | Out-File -FilePath $logFile -Append -Encoding utf8
}

function Test-PortHeld {
  param([int]$Port)
  [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# Another launcher already owns this port -- the task's repeating trigger fired while
# a healthy instance was running. Exit quietly instead of looping forever against a
# port we can never bind.
if (Test-PortHeld -Port $port) {
  Write-Log "$Instance already served on port $port by another process; this launcher is exiting"
  exit 0
}

# -- Supervisor loop ---------------------------------------------------------
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
  Invoke-LogRoll
  Write-Log "starting $Instance on port $port (bind $($env:BIND_ADDR))"
  $started = Get-Date

  # node's stderr MUST NOT be fatal.
  #
  # PowerShell wraps every stderr line from a native executable in an ErrorRecord, and
  # under $ErrorActionPreference = 'Stop' the FIRST one terminates this script. That
  # closes node's stdout pipe, so node dies with it -- and the script is already gone,
  # so nothing records why.
  #
  # The app writes to stderr for entirely survivable things: a failed hourly sweep, any
  # 500 passing through errorHandler, an audit-log hiccup. One benign line was killing
  # the instance. SE4 died within a minute of every start for exactly this reason, and
  # was only ever revived by the 5-minute trigger -- so it was down far more than it
  # was up, with an empty log.
  #
  # 'Continue' + 2>&1 keeps those lines as ordinary output, timestamped into the log,
  # where they belong.
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $nodeExe $entry 2>&1 | ForEach-Object { Write-Log $_ }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }

  $ranFor = (Get-Date) - $started
  Write-Log "node exited with $code after $([int]$ranFor.TotalSeconds)s"

  # Somebody else grabbed the port while we were down -- most likely the repeating
  # trigger started a replacement. Stand down rather than fight it for the port.
  if (Test-PortHeld -Port $port) {
    Write-Log "port $port is now held by another process; this launcher is exiting"
    exit 0
  }

  # A process that stayed up is a crash, not a misconfiguration: reset the backoff
  # so a one-off crash restarts immediately rather than inheriting an old penalty.
  if ($ranFor.TotalSeconds -ge 60) { $backoff = 2 }

  Write-Log "restarting in ${backoff}s"
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
