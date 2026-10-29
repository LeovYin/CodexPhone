param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$source = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetExtension($source) -ne '.exe') { throw 'Expected a CodexPhone executable.' }
$digest = (Get-CodexPhoneSha256 $source).Substring(0, 12)
$launcherDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ("CodexPhone\launchers\" + $digest)
New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
$target = Join-Path $launcherDir 'CodexPhone.exe'
if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $source -Destination $target }
if ((Get-CodexPhoneSha256 $target) -ne (Get-CodexPhoneSha256 $source)) { throw 'Shortcut executable verification failed.' }
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexPhone.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $launcherDir
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'CodexPhone'
$shortcut.Save()
Write-Output "Desktop shortcut created: $shortcutPath"
