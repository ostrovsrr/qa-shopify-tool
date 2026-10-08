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

  # Deploy this commit instead of the tip of origin/$Branch. This is the rollback
  # lever: when a deploy fails, the error names the commit that was running before.
  [string]$Commit     = '',

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

# 3100 is the status page, 3101+ the instances. Both must release their ports
# before a rebuild, or npm ci fails EPERM against a mapped Prisma engine and a
# stale monitor quietly keeps serving the old code.
function Get-InstancePorts {
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -ge 3100 -and $_.LocalPort -le 3199 })
}

# -- Source ------------------------------------------------------------------
Write-Step 'Source'
$target         = if ($Commit) { $Commit } else { "origin/$Branch" }
$previousCommit = $null
if (Test-Path -LiteralPath (Join-Path $AppRoot '.git')) {
  # What was running before this deploy -- named in the error if the deploy fails,
  # so rolling back is one command (-Commit) rather than an archaeology session.
  Push-Location $AppRoot
  try { $previousCommit = (& git rev-parse HEAD | Select-Object -First 1) } finally { Pop-Location }
  Write-Host "Updating $AppRoot (currently at $previousCommit)"
  Invoke-Native git @('fetch', '--prune', 'origin') $AppRoot
  Invoke-Native git @('checkout', $Branch) $AppRoot
  Invoke-Native git @('reset', '--hard', $target) $AppRoot
} else {
  Write-Host "Cloning into $AppRoot"
  $parent = Split-Path -Parent $AppRoot
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Invoke-Native git @('clone', '--branch', $Branch, $RepoUrl, $AppRoot) $parent
  if ($Commit) { Invoke-Native git @('reset', '--hard', $Commit) $AppRoot }
}
Invoke-Native git @('log', '-1', '--oneline') $AppRoot

# Read the config BEFORE taking anything down: a broken deploy.env should fail the
# deploy while the instances are still serving, not after.
$cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
if (-not $cfg.BindAddrSet) {
  # The launchers default to 127.0.0.1 when BIND_ADDR is missing (fail closed).
  # On a box teammates reach over the network that means: up, healthy, unreachable.
  Write-Warning "BIND_ADDR is not set in $ConfigFile -- the instances will bind to 127.0.0.1 and be reachable from THIS machine only. Set it explicitly if teammates connect over the network."
}

$serverDir = Join-Path $AppRoot 'server'
$clientDir = Join-Path $AppRoot 'client'

# The repo is PUBLIC and the working tree must never hold credentials. The config
# file lives outside the checkout so the `git reset --hard` above cannot clobber it
# and a stray `git add` cannot publish it.
if (Test-Path -LiteralPath (Join-Path $serverDir '.env')) {
  Write-Warning "server\.env exists in the checkout. Instances set their own process environment and dotenv does not override it, but this file should not be here. Remove it."
}

# -- Take the instances out of the way ---------------------------------------
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

  # Kill the LAUNCHERS first, then node.
  #
  # Order is the whole point. Stop-ScheduledTask does not reliably terminate the
  # launcher either, and a surviving launcher is a supervisor: it notices its node
  # died and starts a new one within two seconds. Killing node first therefore does
  # nothing -- the launcher helpfully puts it back, mid-build, holding the Prisma
  # engine DLL again, and `npm ci` fails EPERM exactly as if nothing had been
  # stopped. Worse, npm ci deletes node_modules BEFORE it fails, so the tree is left
  # half-removed and every instance that restarts afterwards dies with
  # MODULE_NOT_FOUND. That is a real outage produced by a failed deploy, observed.
  $launchers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                 Where-Object { $_.CommandLine -like '*Start-Instance.ps1*' -or $_.CommandLine -like '*Start-Monitor.ps1*' })
  foreach ($l in $launchers) {
    Write-Host "killing supervisor PID $($l.ProcessId) so it cannot restart node mid-build"
    Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($launchers.Count -gt 0) { Start-Sleep -Seconds 2 }

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

# Everything below is wrapped: a failed CLIENT build must not leave the instances
# disabled, or a deploy that dies halfway takes the tool down until somebody
# notices and re-enables eleven tasks by hand.
#
# With ONE exception, enforced in the finally block: once the server tree has been
# touched (npm ci / prisma generate / tsc), the instances are NOT started again
# unless `prisma migrate deploy` then succeeded. Starting them would run new (or
# half-built) code against the old -- or a partially migrated -- schema: queries
# against columns that do not exist yet, silently wrong results, or writes the old
# schema cannot hold. That is worse than being down, and it looks like it works.
#
# Why not roll back automatically: a failed migration is recorded as failed in
# _prisma_migrations, and `migrate deploy` refuses to run at all (P3009) until a
# human resolves it -- so redeploying the previous commit would stop at the same
# step. And a partially applied migration leaves the schema in a state only a human
# can judge. So: stay down, say so loudly, and name the exact way back.
$serverTouched = $false
$migrated      = $false
try {

  # -- Client ----------------------------------------------------------------
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

  # -- Server ----------------------------------------------------------------
  Write-Step 'Server build'
  # From here on the server tree no longer holds the build that matched the
  # database. See the finally block.
  $serverTouched = $true
  Invoke-Native $npm @('ci') $serverDir
  # Generated code -- must exist before tsc runs.
  Invoke-Native $npx @('prisma', 'generate') $serverDir
  Invoke-Native $npm @('run', 'build') $serverDir
  if (-not (Test-Path -LiteralPath (Join-Path $serverDir 'dist\index.js'))) {
    throw 'Server build produced no dist/index.js'
  }

  # -- Migrations: ONCE ------------------------------------------------------
  #
  # `migrate deploy` applies pending migrations and CANNOT reset or drop anything.
  # NEVER `migrate dev` here: its drift check can offer a destructive reset, and
  # this database has intentional drift (validation_runs.crossReferenceData exists
  # in the DB but not in schema.prisma).
  Write-Step 'Migrations'
  $env:DATABASE_URL = $cfg.DatabaseUrl
  try {
    Invoke-Native $npx @('prisma', 'migrate', 'deploy') $serverDir
    $migrated = $true
  } finally {
    $env:DATABASE_URL = $null
  }

} finally {

  # -- Bring them back -------------------------------------------------------
  if ($serverTouched -and -not $migrated) {
    # Do NOT start them: code and schema may not match. See the comment above try.
    $rollback = if ($previousCommit) {
      "  Roll back the code:  powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-QaTool.ps1 -Commit $previousCommit"
    } else {
      '  (No previous commit recorded -- this was a fresh clone.)'
    }
    Write-Host ''
    Write-Host '=====================================================================' -ForegroundColor Red
    Write-Host ' DEPLOY FAILED after the server build started. Instances are STOPPED' -ForegroundColor Red
    Write-Host ' and their tasks DISABLED on purpose: starting them could run new code' -ForegroundColor Red
    Write-Host ' against an old or partially migrated database schema.' -ForegroundColor Red
    Write-Host '=====================================================================' -ForegroundColor Red
    Write-Host "  Running before this deploy: $previousCommit"
    Write-Host "  Attempted:                  $target"
    Write-Host '  Inspect the database:  cd server; npx.cmd prisma migrate status   (DATABASE_URL from deploy.env)'
    Write-Host '  If a migration is marked failed, fix it by hand and use `prisma migrate resolve` before any redeploy.'
    Write-Host '  Then EITHER fix forward and re-run Deploy-QaTool.ps1,'
    Write-Host $rollback
    Write-Host '  Deploy-QaTool.ps1 re-enables and starts the instances once a build AND migration succeed.'
  } elseif ($tasks.Count -eq 0) {
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
