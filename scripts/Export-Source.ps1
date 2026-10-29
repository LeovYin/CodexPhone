param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Source export destination already exists; no files were overwritten.' }
if ($destinationPath.TrimEnd('\') -eq $taskRoot.TrimEnd('\')) { throw 'Source export must use a separate directory.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-files.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($relative in @($manifest.files) + @($manifest.directories)) {
  $source = Join-Path $taskRoot $relative
  $target = Join-Path $destinationPath $relative
  if (-not (Test-Path -LiteralPath $source)) { throw "Required public source missing: $relative" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse
}
& node.exe (Join-Path $PSScriptRoot 'Verify-Source.mjs') $destinationPath
if ($LASTEXITCODE -ne 0) { throw 'Source export privacy verification failed' }
Write-Output "Source export ready: $destinationPath"
