<#
.SYNOPSIS
  Read deploy.env and return the resolved deployment config.

.DESCRIPTION
  The ONE parser of deploy.env. Used by Deploy-QaTool.ps1, Register-Instances.ps1,
  Install-Prerequisites.ps1, Start-Instance.ps1 and Start-Monitor.ps1, so the
  DATABASE_URL used for migrations, the URL every instance connects with, the
  instance list used for task registration and the bind address are all derived
  from exactly one place. Start-Instance.ps1 used to carry its own copy; the two
  drifted (a deploy.env with only DATABASE_URL passed Deploy and Register, then
  every launcher threw "POSTGRES_PASSWORD is missing"). Do not fork this again.

  Quoted values:
    - may be single- or double-quoted;
    - may be followed by trailing whitespace and/or a ` # comment`;
    - MAY SPAN LINES -- the store lists can be pretty-printed JSON. A line-at-a-time
      parser truncates them silently.

  A quote closes only where it is followed by nothing but whitespace or a comment.
  When the value looks like JSON (starts with [ or {), a close is accepted only if
  the text up to it parses as JSON: a double-quoted, pretty-printed JSON value has
  inner lines that end in `"`, and closing there would truncate the store list and
  swallow the next keys. If no JSON-valid close exists before end of file, the first
  structural close is used, so one SE's malformed JSON fails THAT SE's launcher with
  "not valid JSON" instead of turning the whole file into one unterminated value.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Config file not found: $Path (copy deploy/.env there -- it is never in the git checkout)"
}

# Positions in $Text where $Quote may close a value: followed only by whitespace,
# optionally then a # comment.
function Get-CloseCandidates {
  param([string]$Text, [char]$Quote)
  $out = New-Object System.Collections.Generic.List[int]
  for ($p = 0; $p -lt $Text.Length; $p++) {
    if ($Text[$p] -eq $Quote -and $Text.Substring($p + 1) -match '^\s*(#.*)?$') { $out.Add($p) }
  }
  return ,$out
}

function Test-CompleteValue {
  param([string]$Value)
  $t = $Value.Trim()
  if (-not ($t.StartsWith('[') -or $t.StartsWith('{'))) { return $true }
  try { $null = $t | ConvertFrom-Json; return $true } catch { return $false }
}

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

  # Scan for the close, starting with the remainder of the key's own line.
  $acc      = ''            # value text from the lines already consumed
  $segment  = $rest.Substring(1)
  $first    = $true
  $value    = $null
  $fallback = $null         # first structural close: @{ Value; NextLine }
  while ($true) {
    $prefix = if ($first) { '' } else { $acc + "`n" }
    foreach ($p in (Get-CloseCandidates -Text $segment -Quote $quote)) {
      $candidate = $prefix + $segment.Substring(0, $p)
      if ($null -eq $fallback) { $fallback = @{ Value = $candidate; NextLine = $i } }
      if (Test-CompleteValue -Value $candidate) { $value = $candidate; break }
    }
    if ($null -ne $value) { break }

    $acc   = $prefix + $segment
    $first = $false
    if ($i -ge $lines.Count) { break }
    $segment = $lines[$i]; $i++
  }

  if ($null -eq $value) {
    if ($null -eq $fallback) { throw "Unterminated $quote quote for $key in $Path" }
    $value = $fallback.Value
    $i     = $fallback.NextLine
  }
  $map[$key] = $value
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

# Loopback unless deploy.env says otherwise. This app has NO AUTHENTICATION, so a
# missing key must fail CLOSED (reachable from this box only), never open to every
# interface. Same default as docker-compose.yml and deploy/.env.example. A box that
# serves the LAN sets BIND_ADDR explicitly; BindAddrSet lets Register-Instances.ps1
# warn when it is not.
$bindSet = -not [string]::IsNullOrWhiteSpace($map['BIND_ADDR'])

[pscustomobject]@{
  Values      = $map
  Instances   = @($instances)
  DatabaseUrl = $dbUrl
  BindAddr    = $(if ($bindSet) { $map['BIND_ADDR'] } else { '127.0.0.1' })
  BindAddrSet = $bindSet
}
