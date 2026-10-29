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
