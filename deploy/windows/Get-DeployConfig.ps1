<#
.SYNOPSIS
  Read deploy.env and return the resolved deployment config.

.DESCRIPTION
  Shared by Deploy-QaTool.ps1 and Register-Instances.ps1 so the DATABASE_URL used
  for migrations and the instance list used for task registration are derived from
  exactly one place: the config file.

  Values may span multiple lines when quoted -- the store lists are pretty-printed
  JSON. A line-at-a-time parser truncates them silently, so this does the
  open-quote scan properly.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { throw "Config file not found: $Path" }

$map   = @{}
$lines = [System.IO.File]::ReadAllLines($Path)
$i     = 0
while ($i -lt $lines.Count) {
  $line = $lines[$i]; $i++
  if ($line -match '^\s*(#|$)') { continue }
  if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
  $key = $Matches[1]; $rest = $Matches[2]

  $quote = $null
  if ($rest.Length -gt 0 -and ($rest[0] -eq "'" -or $rest[0] -eq '"')) { $quote = $rest[0] }

  if ($null -eq $quote) { $map[$key] = ($rest -replace '\s+#.*$', '').Trim(); continue }

  $body = $rest.Substring(1)
  if ($body.EndsWith($quote)) { $map[$key] = $body.Substring(0, $body.Length - 1); continue }

  $sb = [System.Text.StringBuilder]::new(); [void]$sb.Append($body); $closed = $false
  while ($i -lt $lines.Count) {
    $next = $lines[$i]; $i++
    if ($next.EndsWith($quote)) { [void]$sb.Append("`n").Append($next.Substring(0, $next.Length - 1)); $closed = $true; break }
    [void]$sb.Append("`n").Append($next)
  }
  if (-not $closed) { throw "Unterminated $quote quote for $key in $Path" }
  $map[$key] = $sb.ToString()
}

# Which SEs actually have stores. Registering a task for an SE with no credentials
# produces an instance that boots and then throws on the first Shopify call.
$instances = $map.Keys |
  Where-Object { $_ -match '^SHOPIFY_STORES_(SE[1-9][0-9]*)$' -and -not [string]::IsNullOrWhiteSpace($map[$_]) } |
  ForEach-Object { $_ -replace '^SHOPIFY_STORES_', '' } |
  Sort-Object { [int]($_ -replace '^SE', '') }

$dbUrl = $map['DATABASE_URL']
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  $pw = $map['POSTGRES_PASSWORD']
  if ([string]::IsNullOrWhiteSpace($pw)) { throw "Neither DATABASE_URL nor POSTGRES_PASSWORD is set in $Path" }
  $dbUrl = "postgresql://postgres:$([uri]::EscapeDataString($pw))@127.0.0.1:5432/shopify_csv_qa"
}

[pscustomobject]@{
  Values      = $map
  Instances   = @($instances)
  DatabaseUrl = $dbUrl
  BindAddr    = $(if ($map['BIND_ADDR']) { $map['BIND_ADDR'] } else { '0.0.0.0' })
}
