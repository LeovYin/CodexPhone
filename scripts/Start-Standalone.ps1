$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeDir = Join-Path $taskRoot '.codexphone'
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (-not $package) { throw 'The Codex desktop package is unavailable.' }
$desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $desktop -and $_.CommandLine -notmatch '--type=' }) { throw 'Finish tasks and fully exit Codex before restoring standalone mode.' }
$entry = Join-Path $taskRoot 'apps\host\dist\index.js'
$owners = @(Find-CodexPhoneBridge 4318 | Select-Object -ExpandProperty ProcessId)
try {
  $health = Invoke-RestMethod 'http://127.0.0.1:4318/api/health' -TimeoutSec 1
  if ($health.activeTasks -gt 0) { throw 'A phone task is running. Wait for completion.' }
} catch { if ($_.Exception.Message -eq 'A phone task is running. Wait for completion.') { throw } }
foreach ($owner in $owners) { & taskkill.exe /PID $owner /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Could not stop the verified bridge.' } }
foreach ($name in @('CODEXPHONE_APP_SERVER_URL', 'CODEXPHONE_APP_SERVER', 'CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL', 'CODEX_APP_RUNTIME_CLI_PATH', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_CALL_ID', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:HOST = '0.0.0.0'; $env:PORT = '4318'
$env:CODEX_BIN = Join-Path $package.InstallLocation 'app\resources\codex.exe'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$node = Resolve-CodexPhoneNode $taskRoot
$bridge = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'host-standalone.log') -RedirectStandardError (Join-Path $runtimeDir 'host-standalone-error.log') -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 80; $attempt++) {
  try { $health = Invoke-RestMethod 'http://127.0.0.1:4318/api/health' -TimeoutSec 1; if ($health.status -eq 'ready' -and $health.transport -eq 'stdio') { $ready = $true; break } } catch { }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw 'Standalone bridge did not start. Check host-standalone-error.log.' }
Start-Process -FilePath $desktop -WorkingDirectory $taskRoot -WindowStyle Normal | Out-Null
Write-Output 'Standalone mode restored; pairing preserved. Phone and desktop now have separate backends.'
