param([string]$FixtureRoot, [string]$Node)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\Common.ps1')
$entry = Join-Path $FixtureRoot 'apps\host\dist\index.js'
function Candidate($Command) { [pscustomobject]@{ Name='node.exe'; ExecutablePath=$Node; CommandLine=$Command; ProcessId=123 } }
$valid = Get-CodexPhoneBridgeProcess (Candidate ('"' + $Node + '" "' + $entry + '"'))
if (-not $valid -or $valid.CodexPhoneRoot -ne $FixtureRoot) { throw 'Windows path not recognized' }
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
