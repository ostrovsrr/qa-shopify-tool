<#
.SYNOPSIS
  One-time host preparation: PostgreSQL, the application database, power settings.

.DESCRIPTION
  Run once, elevated, before Deploy-QaTool.ps1. Idempotent -- it skips whatever is
  already in place.

  Node.js and Git are assumed present (winget OpenJS.NodeJS.LTS / Git.Git).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-Prerequisites.ps1
#>
[CmdletBinding()]
param(
  [string]$ConfigFile     = 'C:\ProgramData\qa-shopify-tool\deploy.env',
  [string]$PostgresPackage = 'PostgreSQL.PostgreSQL.17',
  [string]$PostgresVersion = '17',
  [string]$Database        = 'shopify_csv_qa'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this elevated.'
}

function Write-Step { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }

$cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
$pgPassword = $cfg.Values['POSTGRES_PASSWORD']
if ([string]::IsNullOrWhiteSpace($pgPassword)) { throw "POSTGRES_PASSWORD is not set in $ConfigFile" }

# ── Power ───────────────────────────────────────────────────────────────────
#
# This is a desktop OS. Its default power plan sleeps the machine after 30 idle
# minutes, at which point the box drops off the network and every teammate's tab
# stops working -- indistinguishable from a crash, and it happens overnight.
Write-Step 'Power settings'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
Write-Host 'AC standby and hibernate disabled.'

# ── PostgreSQL ──────────────────────────────────────────────────────────────
Write-Step 'PostgreSQL'
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($pgService) {
  Write-Host "Already installed: $($pgService.Name) ($($pgService.Status))"
} else {
  Write-Host "Installing $PostgresPackage ..."
  # Unattended: the EDB installer is interactive by default and would hang forever
  # in a non-interactive SSH session.
  #
  # The superuser password goes on the installer's command line, so it is briefly
  # visible to anything watching this box's process list. That is acceptable only
  # because it is the same password already sitting in $ConfigFile on this host.
  $override = '--mode unattended --unattendedmodeui minimal ' +
              "--superpassword `"$pgPassword`" " +
              '--serverport 5432 --disable-components stackbuilder'
  & winget install --id $PostgresPackage --exact --silent `
      --accept-package-agreements --accept-source-agreements `
      --override $override
  if ($LASTEXITCODE -ne 0) { throw "winget install failed with exit code $LASTEXITCODE" }

  $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pgService) { throw 'PostgreSQL installed but no postgresql* service appeared.' }
}

Set-Service -Name $pgService.Name -StartupType Automatic
if ($pgService.Status -ne 'Running') { Start-Service -Name $pgService.Name }


# ── Keep PostgreSQL off the network ─────────────────────────────────────────
#
# The EDB installer ships listen_addresses = '*'. On a host whose firewall
# profile is disabled -- which is the case here -- that puts the superuser
# account on the LAN with nothing in front of it. The app connects over
# 127.0.0.1, so there is no reason for it to listen anywhere else.
$pgConf = "C:\Program Files\PostgreSQL\$PostgresVersion\data\postgresql.conf"
if (Test-Path -LiteralPath $pgConf) {
  $conf = Get-Content -LiteralPath $pgConf -Raw
  if ($conf -match "(?m)^\s*listen_addresses\s*=\s*'\*'") {
    Copy-Item -LiteralPath $pgConf -Destination "$pgConf.bak-qa-deploy" -Force
    $conf = $conf -replace "(?m)^\s*listen_addresses\s*=\s*'\*'.*$", "listen_addresses = 'localhost'`t`t# qa-shopify-tool deploy: app connects over 127.0.0.1 only"
    Set-Content -LiteralPath $pgConf -Value $conf -Encoding ascii
    Write-Host 'listen_addresses set to localhost; restarting PostgreSQL'
    Restart-Service -Name $pgService.Name -Force
    Start-Sleep -Seconds 5
  } else {
    Write-Host 'listen_addresses already restricted'
  }
}

# ── Database ────────────────────────────────────────────────────────────────
Write-Step "Database '$Database'"
$psql = "C:\Program Files\PostgreSQL\$PostgresVersion\bin\psql.exe"
if (-not (Test-Path -LiteralPath $psql)) { throw "psql not found at $psql" }

$env:PGPASSWORD = $pgPassword
try {
  # Wait for the server to accept connections -- the service reports Running before
  # the postmaster is ready, and creating the database a second too early fails.
  $ready = $false
  foreach ($attempt in 1..30) {
    & $psql -U postgres -h 127.0.0.1 -p 5432 -tAc 'SELECT 1' *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw 'PostgreSQL did not accept connections within 60s.' }

  $exists = & $psql -U postgres -h 127.0.0.1 -p 5432 -tAc `
    "SELECT 1 FROM pg_database WHERE datname = '$Database'"
  if ($exists -eq '1') {
    Write-Host "Database '$Database' already exists -- left alone."
  } else {
    & $psql -U postgres -h 127.0.0.1 -p 5432 -c "CREATE DATABASE `"$Database`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CREATE DATABASE failed with exit code $LASTEXITCODE" }
    Write-Host "Created database '$Database'."
  }
} finally {
  $env:PGPASSWORD = $null
}

# PostgreSQL stays on 127.0.0.1 only. Nothing outside this box has any business
# reaching it, and no firewall rule is opened for 5432 on purpose.
Write-Step 'Done'
Write-Host 'Next: Deploy-QaTool.ps1, then Register-Instances.ps1.'
