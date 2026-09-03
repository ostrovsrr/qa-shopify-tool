<#
.SYNOPSIS
  Launch the read-only fleet status page (deploy/monitor/monitor.js).

.DESCRIPTION
  Same shape as Start-Instance.ps1 and, more importantly, the same hard-won
  stderr handling. A watchdog that dies the way the thing it watches used to die
  is worse than no watchdog, because the page simply stops updating and still
  looks plausible.

  Kept separate from Start-Instance.ps1 rather than folded into it: this has no
  SE, no stores and no database, and the isolation argument that governs that
  script does not apply here.
#>
[CmdletBinding()]
param(
  [string]$AppRoot    = 'C:\apps\qa-shopify-tool',
  [string]$ConfigFile = 'C:\ProgramData\qa-shopify-tool\deploy.env',
  [string]$LogDir     = 'C:\ProgramData\qa-shopify-tool\logs',
  [string]$DataDir    = 'C:\ProgramData\qa-shopify-tool\monitor',
  [int]$Port          = 3100,
  [int]$FirstPort     = 3101,
  [int]$LastPort      = 3108,
  [int]$MaxLogBytes   = 20MB
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$entry = Join-Path $AppRoot 'deploy\monitor\monitor.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "$entry not found. Run Deploy-QaTool.ps1 first." }

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'node.exe not found' }

# Bind the same way the instances do, so the page is reachable wherever they are.
$bind = '0.0.0.0'
if (Test-Path -LiteralPath $ConfigFile) {
  $cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
  if ($cfg.BindAddr) { $bind = $cfg.BindAddr }
}

$env:MONITOR_PORT       = "$Port"
$env:MONITOR_FIRST_PORT = "$FirstPort"
$env:MONITOR_LAST_PORT  = "$LastPort"
$env:MONITOR_LOG_DIR    = $LogDir
$env:MONITOR_DATA_DIR   = $DataDir
$env:BIND_ADDR          = $bind

New-Item -ItemType Directory -Force -Path $LogDir  | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$logFile = Join-Path $LogDir 'monitor.log'
if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt $MaxLogBytes)) {
  $rolled = "$logFile.1"
  if (Test-Path -LiteralPath $rolled) { Remove-Item -LiteralPath $rolled -Force }
  Move-Item -LiteralPath $logFile -Destination $rolled -Force
}

function Write-Log { param($m) "[$(Get-Date -Format o)] $m" | Out-File -FilePath $logFile -Append -Encoding utf8 }

function Test-PortHeld {
  param([int]$P)
  [bool](Get-NetTCPConnection -State Listen -LocalPort $P -ErrorAction SilentlyContinue)
}

if (Test-PortHeld -P $Port) {
  Write-Log "monitor already running on port $Port; this launcher is exiting"
  exit 0
}

Set-Location (Join-Path $AppRoot 'deploy\monitor')

$backoff    = 2
$maxBackoff = 60

while ($true) {
  Write-Log "starting monitor on port $Port (bind $bind), watching $FirstPort-$LastPort"
  $started = Get-Date

  # stderr must not be fatal. Under $ErrorActionPreference = 'Stop', PowerShell turns
  # the first stderr line from a native exe into a terminating error, which kills this
  # script and closes node's stdout pipe, taking node with it -- and leaves nothing in
  # the log, because the logger has already gone. That cost an instance a day of
  # uptime before it was found. See Start-Instance.ps1.
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $nodeExe $entry 2>&1 | ForEach-Object { Write-Log $_ }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }

  $ranFor = (Get-Date) - $started
  Write-Log "monitor exited with $code after $([int]$ranFor.TotalSeconds)s"

  if (Test-PortHeld -P $Port) {
    Write-Log "port $Port is now held by another process; this launcher is exiting"
    exit 0
  }

  if ($ranFor.TotalSeconds -ge 60) { $backoff = 2 }
  Write-Log "restarting in ${backoff}s"
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
