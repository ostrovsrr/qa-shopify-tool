<#
.SYNOPSIS
  Build (or update) the QA tool on a native Windows host, and run migrations once.

.DESCRIPTION
  Idempotent. First run clones and builds; later runs pull, rebuild, migrate, and
  start the instances again. This is the ONLY place `prisma migrate deploy` runs --
  the instances themselves just execute `node dist/index.js`.

  It does NOT install PostgreSQL and does NOT create the config file.
  See Install-Prerequisites.ps1 and deploy/windows/README.md.

  Everything is down for the duration of the rebuild. That is forced, not laziness:
  Windows will not replace a DLL that a live process has mapped, so the instances
  must be out of the way before `npm ci` touches the Prisma engine.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-QaTool.ps1
#>
[CmdletBinding()]
param(
  [string]$AppRoot    = 'C:\apps\qa-shopify-tool',
  [string]$RepoUrl    = 'https://github.com/ostrovsrr/qa-shopify-tool.git',
  [string]$Branch     = 'main',
  [string]$ConfigFile = 'C:\ProgramData\qa-shopify-tool\deploy.env',
  [string]$TaskPath   = '\QA Shopify Tool\',
  [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Write-Step { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# npm.ps1 is blocked by this machine's ExecutionPolicy (PSSecurityException).
# npm.cmd is not a PowerShell script and is unaffected. Do not "fix" this by
# loosening the machine's ExecutionPolicy.
$npm = 'npm.cmd'
$npx = 'npx.cmd'

function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments, [string]$WorkDir)
  Push-Location $WorkDir
  try {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Get-InstancePorts {
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 3101 -and $_.LocalPort -le 3199 })
}

# ── Source ──────────────────────────────────────────────────────────────────
Write-Step 'Source'
if (Test-Path -LiteralPath (Join-Path $AppRoot '.git')) {
  Write-Host "Updating $AppRoot"
  Invoke-Native git @('fetch', '--prune', 'origin') $AppRoot
  Invoke-Native git @('checkout', $Branch) $AppRoot
  Invoke-Native git @('reset', '--hard', "origin/$Branch") $AppRoot
} else {
  Write-Host "Cloning into $AppRoot"
  $parent = Split-Path -Parent $AppRoot
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Invoke-Native git @('clone', '--branch', $Branch, $RepoUrl, $AppRoot) $parent
}
Invoke-Native git @('log', '-1', '--oneline') $AppRoot

$serverDir = Join-Path $AppRoot 'server'
$clientDir = Join-Path $AppRoot 'client'

# The repo is PUBLIC and the working tree must never hold credentials. The config
# file lives outside the checkout so the `git reset --hard` above cannot clobber it
# and a stray `git add` cannot publish it.
if (Test-Path -LiteralPath (Join-Path $serverDir '.env')) {
  Write-Warning "server\.env exists in the checkout. Instances set their own process environment and dotenv does not override it, but this file should not be here. Remove it."
}

# ── Take the instances out of the way ───────────────────────────────────────
#
# DISABLE, not merely stop. Each task carries a 5-minute repeating trigger (the
# recovery safety net in Register-Instances.ps1), and a tick landing mid-build
# starts an instance that re-maps the Prisma engine -- `prisma generate` then dies
# with EPERM renaming query_engine-windows.dll.node. Stopping does not stop the
# trigger; disabling does.
#
# And Stop-ScheduledTask does not reliably take node with it: Start-Instance.ps1
# supervises node as a child, and the orphan keeps both the port and the DLL.
$tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue)

if ($tasks.Count -gt 0) {
  Write-Step 'Taking instances down for the rebuild'
  foreach ($t in $tasks) {
    Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask    -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
    Write-Host "disabled + stopped $($t.TaskName)"
  }

  # Short grace period for a clean exit. An orphan never releases on its own, so
  # waiting longer than this before killing it buys nothing.
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and (Get-InstancePorts).Count -gt 0) { Start-Sleep -Seconds 2 }

  foreach ($c in Get-InstancePorts) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Write-Host "killing orphaned node PID $($proc.Id) still holding port $($c.LocalPort)"
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 3

  $live = Get-InstancePorts
  if ($live.Count -gt 0) {
    Write-Warning "Ports still listening: $(($live.LocalPort | Sort-Object -Unique) -join ', '). The build will probably fail with EPERM."
  } else {
    Write-Host 'all instance ports released'
  }
}

# Everything below is wrapped: a failed build must not leave the instances
# disabled, or a deploy that dies halfway takes the tool down until somebody
# notices and re-enables seven tasks by hand.
try {

  # ── Client ────────────────────────────────────────────────────────────────
  #
  # Built BEFORE the instances start: server/src/index.ts mounts express.static
  # only when client/dist exists AT BOOT. A missing bundle is not an error -- the
  # instances would quietly serve the API and 404 the UI.
  Write-Step 'Client build'
  Invoke-Native $npm @('ci') $clientDir
  Invoke-Native $npm @('run', 'build') $clientDir
  if (-not (Test-Path -LiteralPath (Join-Path $clientDir 'dist\index.html'))) {
    throw 'Client build produced no dist/index.html'
  }

  # ── Server ────────────────────────────────────────────────────────────────
  Write-Step 'Server build'
  Invoke-Native $npm @('ci') $serverDir
  # Generated code -- must exist before tsc runs.
  Invoke-Native $npx @('prisma', 'generate') $serverDir
  Invoke-Native $npm @('run', 'build') $serverDir
  if (-not (Test-Path -LiteralPath (Join-Path $serverDir 'dist\index.js'))) {
    throw 'Server build produced no dist/index.js'
  }

  # ── Migrations: ONCE ──────────────────────────────────────────────────────
  #
  # `migrate deploy` applies pending migrations and CANNOT reset or drop anything.
  # NEVER `migrate dev` here: its drift check can offer a destructive reset, and
  # this database has intentional drift (validation_runs.crossReferenceData exists
  # in the DB but not in schema.prisma).
  Write-Step 'Migrations'
  $cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
  $env:DATABASE_URL = $cfg.DatabaseUrl
  try {
    Invoke-Native $npx @('prisma', 'migrate', 'deploy') $serverDir
  } finally {
    $env:DATABASE_URL = $null
  }

} finally {

  # ── Bring them back ───────────────────────────────────────────────────────
  if ($tasks.Count -eq 0) {
    Write-Warning 'No instance tasks registered. Run Register-Instances.ps1.'
  } elseif ($SkipRestart) {
    Write-Warning '-SkipRestart: instances are stopped and STILL DISABLED. Re-enable them with Register-Instances.ps1, or Enable-ScheduledTask.'
  } else {
    Write-Step 'Starting instances'
    foreach ($t in $tasks) {
      Enable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue | Out-Null
      Start-ScheduledTask  -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      Write-Host "started $($t.TaskName)"
    }
  }
}

Write-Step 'Done'
