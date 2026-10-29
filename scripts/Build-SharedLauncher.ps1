param([string]$CodexExecutable, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRoot '.codexphone\launcher' }
if (-not $CodexExecutable) {
  $desktopPackage = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
  if ($desktopPackage) { $CodexExecutable = Join-Path $desktopPackage.InstallLocation 'app\resources\codex.exe' }
  if (-not $CodexExecutable -or -not (Test-Path -LiteralPath $CodexExecutable)) { $CodexExecutable = (Get-Command codex.exe -ErrorAction Stop).Source }
}
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
$nodeExecutable = Resolve-CodexPhoneNode $taskRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$prebuilt = Join-Path $taskRoot 'runtime\codexphone-cli.exe'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputExecutable = Join-Path $OutputDirectory 'codexphone-cli.exe'
# A running launcher must not be overwritten. Reuse it if the source did not change.
$source = Join-Path $PSScriptRoot 'SharedCliLauncher.cs'
if (Test-Path -LiteralPath $prebuilt) {
  if (-not (Test-Path -LiteralPath $outputExecutable)) { Copy-Item -LiteralPath $prebuilt -Destination $outputExecutable }
  elseif ((Get-FileHash -LiteralPath $prebuilt -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $outputExecutable -Algorithm SHA256).Hash) {
    try { Copy-Item -LiteralPath $prebuilt -Destination $outputExecutable -Force } catch { throw 'Exit Codex normally before updating the native adapter, then start again.' }
  }
} elseif (-not (Test-Path -LiteralPath $outputExecutable) -or (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $outputExecutable).LastWriteTimeUtc) {
  if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable. Use the portable release with the prebuilt adapter.' }
  & $compiler /nologo /target:exe /optimize+ "/out:$outputExecutable" $source
  if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the native CLI adapter.' }
}
$paths = @($nodeExecutable, (Join-Path $PSScriptRoot 'shared-cli-proxy.mjs'), $CodexExecutable)
[IO.File]::WriteAllLines((Join-Path $OutputDirectory 'launcher-paths.txt'), $paths, (New-Object Text.UTF8Encoding $false))
[pscustomobject]@{ Executable = $outputExecutable; CodexExecutable = $CodexExecutable; NodeExecutable = $nodeExecutable }
