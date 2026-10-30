param([int]$Port = 4321)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
$entry = Join-Path $taskRoot 'apps\host\dist\account-service.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Account service is not built; build the workspace first.' }
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count) {
  foreach ($owner in $owners) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
    if ($candidate.Name -ne 'node.exe' -or $candidate.CommandLine -notmatch '[\\/]apps[\\/]host[\\/]dist[\\/]account-service\.js"?\s*$') { throw 'Account service port is occupied by an unrelated process. No process was stopped.' }
  }
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
  if ($health.product -ne 'CodexPhone Accounts') { throw 'Account service identity could not be verified.' }
  Write-Output 'Account service is already running. Accounts and database were preserved.'
  return
}
$logs = Join-Path $taskRoot '.codexphone'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$node = Resolve-CodexPhoneNode $taskRoot
$env:CODEXPHONE_ACCOUNTS_PORT = "$Port"
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'accounts.log') -RedirectStandardError (Join-Path $logs 'accounts-error.log') -PassThru
for ($attempt=0; $attempt -lt 40; $attempt++) {
  if ($process.HasExited) { throw 'Account service exited. Open diagnostic logs for details.' }
  try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1; if ($health.product -eq 'CodexPhone Accounts') { Write-Output 'Account service ready. SQLite database is stored in your user profile.'; return } } catch { }
  Start-Sleep -Milliseconds 250
}
throw 'Account service did not become ready. Check port and diagnostic logs.'
