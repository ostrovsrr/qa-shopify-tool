<#
.SYNOPSIS
  Register one always-on scheduled task per SE instance, and open the firewall.

.DESCRIPTION
  The native-Windows stand-in for the `se*` services in docker-compose.yml.

  Scheduled tasks rather than Windows services, on purpose: node.exe is not a
  service-aware binary, so `sc.exe create` produces a service that fails its start
  handshake ("did not respond in a timely fashion"). A wrapper such as NSSM or
  WinSW would work but means downloading a third-party binary onto a shared box.
  An AtStartup task running as SYSTEM boots with no user logged in -- which is the
  actual requirement -- and needs no stored password and nothing downloaded.

  Idempotent: re-running replaces the tasks and the firewall rule.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Register-Instances.ps1
#>
[CmdletBinding()]
param(
  [string]$AppRoot    = 'C:\apps\qa-shopify-tool',
  [string]$ConfigFile = 'C:\ProgramData\qa-shopify-tool\deploy.env',
  [string]$TaskPath   = '\QA Shopify Tool\',

  # Who may reach the instance ports.
  #
  # THIS APP HAS NO AUTHENTICATION. Anyone who can reach a port gets that SE's
  # full API, including the routes that delete records by tag across an entire
  # Shopify store. Keep this as tight as the team can stand.
  [string[]]$AllowFrom = @('10.20.30.0/24'),

  # The read-only status page. Not an SE instance: it holds no store credentials
  # and talks to nothing but the other instances health endpoints.
  [int]$MonitorPort = 3100,

  [switch]$SkipFirewall,
  [switch]$SkipMonitor,
  [switch]$SkipPostgresWatchdog
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this elevated.'
}

$launcher = Join-Path $PSScriptRoot 'Start-Instance.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }

$cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
if ($cfg.Instances.Count -eq 0) { throw "No SHOPIFY_STORES_SE* entries with values in $ConfigFile" }

Write-Host "Instances found in config: $($cfg.Instances -join ', ')"
if ($cfg.BindAddr -eq '0.0.0.0') {
  Write-Warning 'BIND_ADDR=0.0.0.0 -- the app itself accepts connections on every interface. The firewall rule below is then the ONLY thing limiting who reaches an app with no authentication.'
}

$ports = @()

foreach ($instance in $cfg.Instances) {
  $n    = [int]($instance -replace '^SE', '')
  $port = 3100 + $n
  $ports += $port
  $taskName = "qa-shopify-$($instance.ToLower())"

  $action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Instance {1} -AppRoot "{2}" -ConfigFile "{3}"' -f $launcher, $instance, $AppRoot, $ConfigFile)

  # SYSTEM: starts with nobody logged in, and no password to store on a shared box.
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  # Two triggers, because one is not enough:
  #
  #   AtStartup  -- comes up with the box, nobody logged in.
  #   Repeating  -- the safety net. RestartOnFailure below is set but this machine
  #                 uses the Unified Scheduling Engine, which does not honour it for
  #                 a long-running action that exits non-zero (verified: killing node
  #                 left the task dead at 0xFFFFFFFF). With MultipleInstances set to
  #                 IgnoreNew, a tick while the instance is healthy is a no-op, and a
  #                 tick after it died restarts it. Start-Instance.ps1 restarts node
  #                 in seconds; this catches the launcher itself dying.
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  # No -RepetitionDuration: an empty Duration means REPEAT INDEFINITELY.
  # Do not be tempted by [TimeSpan]::MaxValue -- it serialises to
  # P99999999DT23H59M59S and Task Scheduler rejects the whole task XML as out of
  # range, which (because the task is unregistered first) leaves the instance
  # deleted rather than merely unchanged.
  $repeatTrigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
                      -RepetitionInterval (New-TimeSpan -Minutes 5)
  $trigger = @($startupTrigger, $repeatTrigger)

  # ExecutionTimeLimit 0 = never kill it: this is a long-running server, not a job.
  # RestartCount/Interval is the supervisor a real service would give us.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

  Unregister-ScheduledTask -TaskName $taskName -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue

  # -ErrorAction Stop: this raises a NON-terminating CimException by default, so
  # without it a failed registration still fell through to the success message
  # below while the task stayed unregistered.
  Register-ScheduledTask `
    -TaskName $taskName `
    -TaskPath $TaskPath `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "QA Shopify Tool -- $instance on port $port. Stores are scoped to $instance only; see Start-Instance.ps1." `
    -ErrorAction Stop | Out-Null

  Write-Host "registered $taskName -> port $port"
}


# ── The status page ─────────────────────────────────────────────────────────
#
# Read-only fleet view on $MonitorPort, registered exactly like an instance so it
# comes back on boot and restarts itself. It is the answer to "is it up, and has it
# been up" -- a question a spot check cannot answer, which is how one instance spent
# a day dying and being revived without anyone noticing.
if (-not $SkipMonitor) {
  $monitorLauncher = Join-Path $PSScriptRoot 'Start-Monitor.ps1'
  if (-not (Test-Path -LiteralPath $monitorLauncher)) { throw "Launcher not found: $monitorLauncher" }

  $mAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AppRoot "{1}" -ConfigFile "{2}" -Port {3} -FirstPort {4} -LastPort {5}' -f `
                $monitorLauncher, $AppRoot, $ConfigFile, $MonitorPort, $ports[0], $ports[-1])

  $mPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $mStartup   = New-ScheduledTaskTrigger -AtStartup
  $mRepeat    = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $mSettings  = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

  Unregister-ScheduledTask -TaskName 'qa-shopify-monitor' -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask `
    -TaskName 'qa-shopify-monitor' `
    -TaskPath $TaskPath `
    -Action $mAction `
    -Trigger @($mStartup, $mRepeat) `
    -Principal $mPrincipal `
    -Settings $mSettings `
    -Description "QA Shopify Tool -- read-only fleet status page on port $MonitorPort. No control endpoints." `
    -ErrorAction Stop | Out-Null

  Write-Host "registered qa-shopify-monitor -> port $MonitorPort"
}


# ── PostgreSQL watchdog ─────────────────────────────────────────────────────
#
# The database is the dependency all instances share, and nothing restarted it.
# Windows service recovery does not help: the service runs `pg_ctl runservice`,
# which exits CLEANLY when the postmaster dies, so SCM sees a normal stop and the
# `sc failure` actions never fire. Verified by killing the postmaster -- it stayed
# down for two minutes with no SCM failure events at all.
#
# Checking state every minute works whatever the reason. One minute rather than the
# instances' five, because everything depends on this and the check is just a
# service-status query.
if (-not $SkipPostgresWatchdog) {
  $pgScript = Join-Path $PSScriptRoot 'Ensure-Postgres.ps1'
  if (-not (Test-Path -LiteralPath $pgScript)) { throw "Not found: $pgScript" }

  $wAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $pgScript)
  $wPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $wStartup   = New-ScheduledTaskTrigger -AtStartup
  $wRepeat    = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  # ExecutionTimeLimit is short on purpose: this is a one-shot check, and a hung
  # check should be killed rather than block the next tick.
  $wSettings  = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

  Unregister-ScheduledTask -TaskName 'qa-shopify-postgres-watchdog' -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName 'qa-shopify-postgres-watchdog' -TaskPath $TaskPath `
    -Action $wAction -Trigger @($wStartup, $wRepeat) -Principal $wPrincipal -Settings $wSettings `
    -Description 'QA Shopify Tool -- starts PostgreSQL if it is not running. Create postgres-watchdog.disabled to pause it for maintenance.' `
    -ErrorAction Stop | Out-Null
  Write-Host 'registered qa-shopify-postgres-watchdog (every 1 min)'
}

# ── Firewall ────────────────────────────────────────────────────────────────
if (-not $SkipFirewall) {
  $ruleName = 'QA Shopify Tool (instances)'
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

  # Include the status page port, so the one URL people bookmark is reachable by
  # exactly the same set of addresses as the instances -- no wider.
  $allPorts  = @($ports); if (-not $SkipMonitor) { $allPorts += $MonitorPort }
  $portRange = "$([int](($allPorts | Measure-Object -Minimum).Minimum))-$([int](($allPorts | Measure-Object -Maximum).Maximum))"
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $portRange `
    -RemoteAddress $AllowFrom `
    -Profile Any `
    -Description 'QA Shopify Tool SE instances. NO AUTHENTICATION behind this rule -- keep RemoteAddress tight.' | Out-Null

  Write-Host "firewall: TCP $portRange allowed from $($AllowFrom -join ', ')"

  # A rule only filters on a profile that is switched ON. This box ships with the
  # Private profile DISABLED, and on a disabled profile the RemoteAddress scoping
  # above is decoration: every port is reachable by anyone who can route to the
  # host. Say so loudly rather than leaving a false sense of restriction.
  $offProfiles = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
  if ($offProfiles.Count -gt 0) {
    Write-Warning ("Windows Firewall is DISABLED for: {0}. The RemoteAddress restriction just applied does NOT apply on those profiles -- if the active network uses one, ports {1} are reachable from anywhere that can route here, with no authentication in front of them. Enable the profile, or accept that exposure knowingly." -f (($offProfiles.Name) -join ', '), $portRange)
  }
}

Write-Host "`nStarting instances now (they would otherwise wait for the next boot)..."
foreach ($instance in $cfg.Instances) {
  Start-ScheduledTask -TaskName "qa-shopify-$($instance.ToLower())" -TaskPath $TaskPath
}
if (-not $SkipMonitor) { Start-ScheduledTask -TaskName 'qa-shopify-monitor' -TaskPath $TaskPath }
Write-Host 'Done.'
