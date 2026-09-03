<#
.SYNOPSIS
  Start PostgreSQL if it is not running. Runs every minute from a scheduled task.

.DESCRIPTION
  The database is the one dependency all eight instances share, and nothing was
  restarting it. The instances survive a database crash perfectly well -- they stay
  alive and reconnect on their own -- but they cannot do anything useful until
  PostgreSQL is back, so a crash meant an outage lasting until a human noticed.

  Windows' own service recovery does NOT cover this. The service runs
  `pg_ctl runservice`, and when the postmaster dies pg_ctl exits CLEANLY with code 0.
  Service Control Manager sees a normal stop, not a failure, so the failure actions
  configured with `sc failure` never fire -- verified by killing the postmaster and
  watching it stay down for two minutes with no SCM events logged at all.

  So this checks STATE rather than waiting for an event, which works regardless of
  why the service stopped.

  Deliberately a one-shot check, not a supervisor loop: the trigger fires it every
  minute, so there is no long-running process to babysit and nothing to leak.

.NOTES
  Maintenance: create the disable file below and this stops interfering, so you can
  stop the database by hand without a watchdog fighting you.
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'postgresql-x64-17',
  [string]$LogDir      = 'C:\ProgramData\qa-shopify-tool\logs',
  [string]$DisableFile = 'C:\ProgramData\qa-shopify-tool\postgres-watchdog.disabled',
  [int]$MaxLogBytes    = 5MB
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'postgres-watchdog.log'

if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt $MaxLogBytes)) {
  $rolled = "$logFile.1"
  if (Test-Path -LiteralPath $rolled) { Remove-Item -LiteralPath $rolled -Force }
  Move-Item -LiteralPath $logFile -Destination $rolled -Force
}

# Only ever writes when it DOES something. A heartbeat line every minute would bury
# the one line that matters under 1,440 lines of "still fine" per day.
function Write-Log { param($m) "[$(Get-Date -Format o)] $m" | Out-File -FilePath $logFile -Append -Encoding utf8 }

try {
  $svc = Get-Service -Name $ServiceName -ErrorAction Stop
} catch {
  Write-Log "service '$ServiceName' not found: $($_.Exception.Message)"
  exit 1
}

if ($svc.Status -eq 'Running') { exit 0 }

# Somebody stopped it on purpose. Say so once per tick rather than restarting it
# out from under them mid-maintenance.
if (Test-Path -LiteralPath $DisableFile) {
  Write-Log "$ServiceName is $($svc.Status) but $DisableFile exists -- leaving it alone"
  exit 0
}

# StartPending means a start is already in flight (possibly ours, a moment ago).
if ($svc.Status -eq 'StartPending') { exit 0 }

Write-Log "$ServiceName is $($svc.Status) -- starting it"
try {
  Start-Service -Name $ServiceName -ErrorAction Stop
  $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
  Write-Log "$ServiceName is Running again"
  exit 0
} catch {
  # A database that cannot start is a human problem: log it and let the next tick
  # try again rather than pretending it worked.
  Write-Log "failed to start $ServiceName : $($_.Exception.Message)"
  exit 1
}
