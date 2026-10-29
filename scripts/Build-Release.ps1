param([string]$Version, [string]$NodeVersion = '24.22.2', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRoot
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$' -or $NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$releaseRoot = Join-Path $taskRoot 'releases'
$cache = Join-Path $releaseRoot '.cache'
$buildRoot = Join-Path $releaseRoot ('.build-' + [Guid]::NewGuid().ToString('N'))
$portable = Join-Path $buildRoot 'CodexPhone'
$output = Join-Path $releaseRoot $Version
if (Test-Path -LiteralPath $output) { throw "Release $Version already exists. Move it aside or select a new -Version." }
New-Item -ItemType Directory -Path $portable,$cache -Force | Out-Null
if (-not $SkipBuild) {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Workspace build failed' }
}
Write-Output 'Deploying production-only dependencies without Windows junctions...'
$workspaceState = Join-Path $taskRoot 'node_modules\.pnpm-workspace-state-v1.json'
$previousState = if (Test-Path -LiteralPath $workspaceState) { [IO.File]::ReadAllBytes($workspaceState) } else { $null }
try {
  & pnpm --config.node-linker=hoisted --filter @codexphone/host deploy --prod --legacy --offline (Join-Path $portable 'apps\host')
  if ($LASTEXITCODE -ne 0) { throw 'Production deployment failed' }
} finally {
  if ($previousState) { [IO.File]::WriteAllBytes($workspaceState, $previousState) }
}
$web = Join-Path $portable 'apps\web'
New-Item -ItemType Directory -Path $web -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'apps\web\dist') -Destination $web -Recurse
$scripts = Join-Path $portable 'scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
foreach ($name in @('Common.ps1','Build-SharedLauncher.ps1','Start-SharedCodex.ps1','Start-Standalone.ps1','Show-Connection.ps1','Check-Install.ps1','shared-cli-proxy.mjs','SharedCliLauncher.cs')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $scripts
}
foreach ($name in @('Start-CodexPhone.cmd','Pair-Phone.cmd','Check-CodexPhone.cmd','Restore-Standalone.cmd','LICENSE')) {
  Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $portable
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\USER_GUIDE.md') -Destination (Join-Path $portable 'USER_GUIDE.txt')
$runtime = Join-Path $portable 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeArchive = "node-v$NodeVersion-win-x64.zip"
$nodeZip = Join-Path $cache $nodeArchive
$shaFile = Join-Path $cache "node-v$NodeVersion-SHASUMS256.txt"
$nodeBase = "https://nodejs.org/dist/v$NodeVersion"
if (-not (Test-Path -LiteralPath $shaFile)) { Invoke-WebRequest -Uri "$nodeBase/SHASUMS256.txt" -OutFile $shaFile -UseBasicParsing -TimeoutSec 60 }
$shaLine = @(Get-Content -LiteralPath $shaFile | Where-Object { $_ -match ('\s+' + [regex]::Escape($nodeArchive) + '$') })
if ($shaLine.Count -ne 1) { throw 'Official Node.js checksum entry missing' }
$expected = ($shaLine[0] -split '\s+')[0].ToLowerInvariant()
if (-not (Test-Path -LiteralPath $nodeZip)) { Invoke-WebRequest -Uri "$nodeBase/$nodeArchive" -OutFile $nodeZip -UseBasicParsing -TimeoutSec 180 }
if ((Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node.js download checksum mismatch; remove the cached archive and retry' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$nodeExpanded = Join-Path $buildRoot 'node'
[IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $nodeExpanded)
$nodeDist = Join-Path $nodeExpanded "node-v$NodeVersion-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeDist 'node.exe') -Destination $runtime
Copy-Item -LiteralPath (Join-Path $nodeDist 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE.txt')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /codepage:65001 /target:exe /optimize+ ("/out:" + (Join-Path $runtime 'codexphone-cli.exe')) (Join-Path $PSScriptRoot 'SharedCliLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native adapter compilation failed' }
& (Join-Path $runtime 'node.exe') (Join-Path $PSScriptRoot 'Write-ReleaseMetadata.mjs') $portable "v$NodeVersion" $Version
if ($LASTEXITCODE -ne 0) { throw 'Release content verification failed' }
$payload = Join-Path $buildRoot 'payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($portable, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
$metadata = Join-Path $buildRoot 'embedded-release.json'
@{ version = $Version; payloadSha256 = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant(); integritySha256 = (Get-FileHash -LiteralPath (Join-Path $portable 'integrity.json') -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding UTF8
$versionInfo = Join-Path $buildRoot 'VersionInfo.cs'
$versionNumbers = ($Version -split '-')[0]
@"
using System.Reflection;
[assembly: AssemblyTitle("CodexPhone")]
[assembly: AssemblyProduct("CodexPhone")]
[assembly: AssemblyDescription("Self-hosted phone access to your Codex desktop")]
[assembly: AssemblyCompany("CodexPhone contributors")]
[assembly: AssemblyVersion("$versionNumbers.0")]
[assembly: AssemblyFileVersion("$versionNumbers.0")]
"@ | Set-Content -LiteralPath $versionInfo -Encoding UTF8
$executable = Join-Path $buildRoot 'CodexPhone.exe'
& $compiler /nologo /codepage:65001 /target:winexe /optimize+ /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ("/resource:" + $payload + ",codexphone.payload") ("/resource:" + $metadata + ",codexphone.release") ("/out:" + $executable) (Join-Path $PSScriptRoot 'Bootstrap.cs') $versionInfo
if ($LASTEXITCODE -ne 0) { throw 'EXE compilation failed' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $output "CodexPhone-$Version-win-x64.exe")
Copy-Item -LiteralPath $payload -Destination (Join-Path $output "CodexPhone-$Version-win-x64-portable.zip")
Copy-Item -LiteralPath (Join-Path $portable 'release.json') -Destination $output
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\RELEASE_NOTES.md') -Destination $output
Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object {
  (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ASCII
Write-Output "Release ready: $output"
Write-Output "Build directory retained for verification: $buildRoot"
