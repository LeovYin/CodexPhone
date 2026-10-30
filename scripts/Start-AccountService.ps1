param([int]$Port = 4321, [string]$AccountsHome = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
$entry = Join-Path $taskRoot 'apps\host\dist\account-service.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Account service is not built; build the workspace first.' }
$AccountsHome = if ([string]::IsNullOrWhiteSpace($AccountsHome)) { Join-Path $env:USERPROFILE '.codexphone\accounts' } else { [IO.Path]::GetFullPath($AccountsHome) }
$env:CODEXPHONE_ACCOUNTS_HOME = $AccountsHome
$expectedVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'apps\host\package.json') -Raw | ConvertFrom-Json).version
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count) {
  $verifiedOwners = @()
  foreach ($owner in $owners) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
    $match = [regex]::Match($candidate.CommandLine, '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))\s*$')
    if ($candidate.Name -ne 'node.exe' -or -not $match.Success) { throw 'Account service port is occupied by an unrelated process. No process was stopped.' }
    $oldEntry = [IO.Path]::GetFullPath($match.Groups['entry'].Value.Replace('/', '\'))
    if ($oldEntry -notmatch '[\\]apps[\\]host[\\]dist[\\]account-service\.js$' -or -not (Test-Path -LiteralPath $oldEntry)) { throw 'Account service port is occupied by an unrelated process. No process was stopped.' }
    $oldRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $oldEntry)))
    $oldPackage = Get-Content -LiteralPath (Join-Path $oldRoot 'apps\host\package.json') -Raw | ConvertFrom-Json
    if ($oldPackage.name -ne '@codexphone/host') { throw 'Account service ownership could not be verified. No process was stopped.' }
    $verifiedOwners += [pscustomobject]@{ Id = [int]$owner; Root = $oldRoot; Version = [string]$oldPackage.version }
  }
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
  if ($health.product -ne 'CodexPhone Accounts') { throw 'Account service identity could not be verified.' }
  if ($health.version -eq $expectedVersion) { Write-Output "Account service $expectedVersion is already running. Accounts and database were preserved."; return }
  if ($verifiedOwners.Count -ne 1 -or $health.version -ne $verifiedOwners[0].Version) { throw 'Account service version could not be verified. No process was stopped.' }

  Write-Output "Updating CodexPhone account service $($health.version) to $expectedVersion. The SQLite database and accounts will be preserved."
  $tokenFile = Join-Path $AccountsHome 'admin-token'
  $stoppedGracefully = $false
  if (Test-Path -LiteralPath $tokenFile) {
    try {
      $headers = @{ Authorization = 'Bearer ' + (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
      Invoke-RestMethod "http://127.0.0.1:$Port/admin/shutdown" -Method Post -Headers $headers -TimeoutSec 3 | Out-Null
      $stoppedGracefully = $true
    } catch { }
  }
  if (-not $stoppedGracefully) {
    Stop-Process -Id $verifiedOwners[0].Id -Force
  }
  $released = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (-not $remaining.Count) { $released = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $released) { throw 'The previous account service did not release its port. Its database was left in place.' }
}
$logs = Join-Path $taskRoot '.codexphone'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$node = Resolve-CodexPhoneNode $taskRoot
$env:CODEXPHONE_ACCOUNTS_PORT = "$Port"
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'accounts.log') -RedirectStandardError (Join-Path $logs 'accounts-error.log') -PassThru
for ($attempt=0; $attempt -lt 40; $attempt++) {
  if ($process.HasExited) { throw 'Account service exited. Open diagnostic logs for details.' }
  try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1; if ($health.product -eq 'CodexPhone Accounts' -and $health.version -eq $expectedVersion) { Write-Output "Account service $expectedVersion ready. SQLite accounts and database were preserved."; return } } catch { }
  Start-Sleep -Milliseconds 250
}
throw 'Account service did not become ready. Check port and diagnostic logs.'
