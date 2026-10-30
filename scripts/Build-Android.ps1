param([switch]$CreateSigningKey, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$androidRoot = Join-Path $taskRoot 'apps\android'
$version = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$signingRoot = Join-Path $env:LOCALAPPDATA 'CodexPhone\signing'
$keyFile = Join-Path $signingRoot 'android-release.p12'
$passwordFile = Join-Path $signingRoot 'android-release-password.txt'
if (-not (Test-Path -LiteralPath $keyFile)) {
  if (-not $CreateSigningKey) { throw 'Release key is missing. Run once with -CreateSigningKey and back up the signing folder securely.' }
  New-Item -ItemType Directory -Path $signingRoot -Force | Out-Null
  $random = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random) } finally { $rng.Dispose() }
  $env:CODEXPHONE_ANDROID_STORE_PASSWORD = [Convert]::ToBase64String($random)
  [IO.File]::WriteAllText($passwordFile, $env:CODEXPHONE_ANDROID_STORE_PASSWORD)
  & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore $keyFile -storetype PKCS12 -alias codexphone -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=CodexPhone, O=CodexPhone contributors' -storepass:env CODEXPHONE_ANDROID_STORE_PASSWORD -keypass:env CODEXPHONE_ANDROID_STORE_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw 'Could not create Android release signing key; preserve the signing folder for inspection.' }
} else {
  if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'Signing key exists but its password file is missing. No key was replaced.' }
  $env:CODEXPHONE_ANDROID_STORE_PASSWORD = [IO.File]::ReadAllText($passwordFile).Trim()
}
$env:CODEXPHONE_ANDROID_KEYSTORE = $keyFile
try {
  Push-Location -LiteralPath $androidRoot
  try {
    $tasks = if ($SkipTests) { @(':app:assembleRelease') } else { @(':app:testDebugUnitTest', ':app:lintRelease', ':app:assembleRelease') }
    & .\gradlew.bat $tasks
    if ($LASTEXITCODE -ne 0) { throw 'Android release build or checks failed' }
  } finally { Pop-Location }
  $apk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path -LiteralPath $apk)) { throw 'Signed release APK is missing' }
  $sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
  if (-not $sdkRoot) { throw 'Set ANDROID_HOME to verify the release signature' }
  $buildTools = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
  & (Join-Path $buildTools.FullName 'apksigner.bat') verify --verbose --print-certs $apk
  if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
  $output = Join-Path $taskRoot ('releases\' + $version)
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $destination = Join-Path $output ('CodexPhone-' + $version + '-android.apk')
  Copy-Item -LiteralPath $apk -Destination $destination -Force
  Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\RELEASE_NOTES.md') -Destination $output -Force
  Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object {
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
  } | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ASCII
  Write-Output ('Signed APK ready: ' + $destination)
  Write-Output 'Keep the signing key and password outside Git. Back them up to preserve APK update compatibility.'
} finally {
  Remove-Item Env:CODEXPHONE_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
  Remove-Item Env:CODEXPHONE_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
}
