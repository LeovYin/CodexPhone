$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
$node = Resolve-CodexPhoneNode $taskRoot
$version = & $node --version
Write-Output "Node.js: $version"
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if ($package) {
  Write-Output "Codex desktop: $($package.Version)"
  $cli = Join-Path $package.InstallLocation 'app\resources\codex.exe'
  if (Test-Path -LiteralPath $cli) { Write-Output "Codex CLI: $(& $cli --version)" } else { Write-Output 'ERROR: bundled Codex CLI not found.' }
} else { Write-Output 'ERROR: OpenAI.Codex Windows package not found. Install and configure Codex first.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
Write-Output "Windows native adapter compiler: $(Test-Path -LiteralPath $compiler)"
Write-Output "Host build: $(Test-Path -LiteralPath (Join-Path $taskRoot 'apps\host\dist\index.js'))"
Write-Output "Web build: $(Test-Path -LiteralPath (Join-Path $taskRoot 'apps\web\dist\index.html'))"
foreach ($address in @(Get-CodexPhoneAddresses 4318)) { Write-Output "Address: $address" }
try {
  $health = Invoke-RestMethod 'http://127.0.0.1:4318/api/health' -TimeoutSec 2
  Write-Output "Bridge: $($health.status) / $($health.transport); paired devices: $($health.pairedDevices)"
} catch { Write-Output 'Bridge: not running. Start-CodexPhone.cmd starts the shared service.' }
Write-Output 'This check does not send model prompts or print API credentials.'
