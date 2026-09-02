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

  [switch]$SkipFirewall
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
  $repeatTrigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
                      -RepetitionInterval (New-TimeSpan -Minutes 5) `
                      -RepetitionDuration ([TimeSpan]::MaxValue)
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

  Register-ScheduledTask `
    -TaskName $taskName `
    -TaskPath $TaskPath `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "QA Shopify Tool -- $instance on port $port. Stores are scoped to $instance only; see Start-Instance.ps1." | Out-Null

  Write-Host "registered $taskName -> port $port"
}

# ── Firewall ────────────────────────────────────────────────────────────────
if (-not $SkipFirewall) {
  $ruleName = 'QA Shopify Tool (instances)'
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

  $portRange = "$([int]($ports | Measure-Object -Minimum).Minimum)-$([int]($ports | Measure-Object -Maximum).Maximum)"
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
}

Write-Host "`nStarting instances now (they would otherwise wait for the next boot)..."
foreach ($instance in $cfg.Instances) {
  Start-ScheduledTask -TaskName "qa-shopify-$($instance.ToLower())" -TaskPath $TaskPath
}
Write-Host 'Done.'
