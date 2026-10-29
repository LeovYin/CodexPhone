param([string]$FixtureRoot, [string]$Node)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\Common.ps1')
$entry = Join-Path $FixtureRoot 'apps\host\dist\index.js'
function Candidate($Command) { [pscustomobject]@{ Name='node.exe'; ExecutablePath=$Node; CommandLine=$Command; ProcessId=123 } }
$valid = Get-CodexPhoneBridgeProcess (Candidate ('"' + $Node + '" "' + $entry + '"'))
if (-not $valid) { throw 'Windows path not recognized' }
# PowerShell path providers may expand the runner TEMP directory's 8.3 alias.
$actual = (Resolve-Path -LiteralPath (Join-Path $valid.CodexPhoneRoot 'apps\host\dist\index.js')).ProviderPath
$expected = (Resolve-Path -LiteralPath $entry).ProviderPath
if ($actual -ne $expected) { throw "Bridge root mismatch: $actual / $expected" }
$valid = Get-CodexPhoneBridgeProcess (Candidate ('"' + $Node.Replace('\','/') + '" "' + $entry.Replace('\','/') + '"'))
if (-not $valid) { throw 'Forward slash path not recognized' }
foreach ($command in @(
  ('"' + $Node + '" --eval "' + $entry + '"'),
  ('"' + $Node + '" "' + $entry + '" --different-service'),
  ('"' + $Node + '" "' + $entry + '.backup"'),
  ('"C:\unrelated\node.exe" "' + $entry + '"')
)) { if (Get-CodexPhoneBridgeProcess (Candidate $command)) { throw 'Unrelated argv accepted' } }
$packageFile = Join-Path $FixtureRoot 'apps\host\package.json'
[IO.File]::WriteAllText($packageFile,'{"name":"another-service","dependencies":{}}')
if (Get-CodexPhoneBridgeProcess (Candidate ('"' + $Node + '" "' + $entry + '"'))) { throw 'Unrelated package accepted' }
Write-Output 'Ownership checks passed'
