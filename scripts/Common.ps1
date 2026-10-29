# Shared by source checkouts and the portable distribution. No global configuration changes.
if ($env:CODEXPHONE_UTF8 -eq '1') {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
}
function Resolve-CodexPhoneNode([string]$Root) {
  $bundled = Join-Path $Root 'runtime\node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) { throw 'Node.js is unavailable. Use the portable release (includes Node.js), or install Node.js 24 LTS.' }
  return $command.Source
}

function Get-CodexPhoneSha256([string]$FilePath) {
  $stream = [IO.File]::OpenRead($FilePath)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-CodexPhoneBridgeProcess($Candidate) {
  if (-not $Candidate -or $Candidate.Name -ne 'node.exe' -or -not $Candidate.ExecutablePath) { return $null }
  # Match actual argv positions. A path appearing inside another argument is not ownership evidence.
  $pattern = '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))\s*$'
  $match = [regex]::Match($Candidate.CommandLine, $pattern)
  if (-not $match.Success) { return $null }
  try {
    $exe = [IO.Path]::GetFullPath($match.Groups['exe'].Value)
    if ($exe -ne [IO.Path]::GetFullPath($Candidate.ExecutablePath)) { return $null }
    $entry = [IO.Path]::GetFullPath($match.Groups['entry'].Value.Replace('/', '\'))
    if ($entry -notmatch '[\\]apps[\\]host[\\]dist[\\]index\.js$' -or -not (Test-Path -LiteralPath $entry)) { return $null }
    $root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $entry)))
    $package = Get-Content -LiteralPath (Join-Path $root 'apps\host\package.json') -Raw | ConvertFrom-Json
    if ($package.name -ne '@codexphone/host' -or $package.dependencies.'@codexphone/shared' -ne 'workspace:*') { return $null }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'scripts\shared-cli-proxy.mjs'))) { return $null }
    return $Candidate | Add-Member -NotePropertyName CodexPhoneRoot -NotePropertyValue $root -PassThru
  } catch { return $null }
}

function Find-CodexPhoneBridge([int]$Port) {
  $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($owner in $owners) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
    $verified = Get-CodexPhoneBridgeProcess $candidate
    if (-not $verified) { throw "Port $Port belongs to an unrelated or unverifiable process; no process was stopped." }
    $verified
  }
}

function Get-CodexPhoneAddresses([int]$Port) {
  $addresses = @("http://127.0.0.1:$Port")
  try {
    $tailscale = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
      $_.InterfaceAlias -like '*Tailscale*' -and $_.AddressState -eq 'Preferred'
    } | Select-Object -ExpandProperty IPAddress -Unique)
    foreach ($address in $tailscale) { $addresses += "http://${address}:$Port" }
  } catch { }
  return $addresses
}
