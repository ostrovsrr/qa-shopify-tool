<#
.SYNOPSIS
  Build (or update) the QA tool on a native Windows host, and run migrations once.

.DESCRIPTION
  Idempotent. First run clones and builds; later runs pull, rebuild, migrate, and
  restart the instances. This is the ONLY place `prisma migrate deploy` runs --
  the instances themselves just execute `node dist/index.js`.

  It does NOT install PostgreSQL and does NOT create the config file.
  See Install-Prerequisites.ps1 and deploy/windows/README.md.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Deploy-QaTool.ps1
#>
[CmdletBinding()]
param(
  [string]$AppRoot    = 'C:\apps\qa-shopify-tool',
  [string]$RepoUrl    = 'https://github.com/ostrovsrr/qa-shopify-tool.git',
  [string]$Branch     = 'main',
  [string]$ConfigFile = 'C:\ProgramData\qa-shopify-tool\deploy.env',
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

# ── Client ──────────────────────────────────────────────────────────────────
#
# Built BEFORE the instances start: server/src/index.ts mounts express.static only
# when client/dist exists AT BOOT. A missing bundle is not an error -- the
# instances would quietly serve the API and 404 the UI.
Write-Step 'Client build'
Invoke-Native $npm @('ci') $clientDir
Invoke-Native $npm @('run', 'build') $clientDir
if (-not (Test-Path -LiteralPath (Join-Path $clientDir 'dist\index.html'))) {
  throw 'Client build produced no dist/index.html'
}

# ── Server ──────────────────────────────────────────────────────────────────
Write-Step 'Server build'
Invoke-Native $npm @('ci') $serverDir
# Generated code -- must exist before tsc runs.
Invoke-Native $npx @('prisma', 'generate') $serverDir
Invoke-Native $npm @('run', 'build') $serverDir
if (-not (Test-Path -LiteralPath (Join-Path $serverDir 'dist\index.js'))) {
  throw 'Server build produced no dist/index.js'
}

# ── Migrations: ONCE ────────────────────────────────────────────────────────
#
# `migrate deploy` applies pending migrations and CANNOT reset or drop anything.
# NEVER `migrate dev` here: its drift check can offer a destructive reset, and this
# database has intentional drift (validation_runs.crossReferenceData exists in the
# DB but not in schema.prisma).
Write-Step 'Migrations'
$cfg = & (Join-Path $PSScriptRoot 'Get-DeployConfig.ps1') -Path $ConfigFile
$env:DATABASE_URL = $cfg.DatabaseUrl
try {
  Invoke-Native $npx @('prisma', 'migrate', 'deploy') $serverDir
} finally {
  $env:DATABASE_URL = $null
}

# ── Restart ─────────────────────────────────────────────────────────────────
if (-not $SkipRestart) {
  Write-Step 'Restarting instances'
  $tasks = @(Get-ScheduledTask -TaskPath '\QA Shopify Tool\' -ErrorAction SilentlyContinue)
  if ($tasks.Count -eq 0) {
    Write-Warning 'No instance tasks registered yet. Run Register-Instances.ps1.'
  } else {
    foreach ($t in $tasks) {
      Stop-ScheduledTask  -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
      Write-Host "restarted $($t.TaskName)"
    }
  }
}

Write-Step 'Done'
