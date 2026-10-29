param([int]$AppServerPort = 0, [int]$PhonePort = 4318, [string]$RuntimeDirectory, [switch]$CheckOnly, [switch]$WaitForDesktopExit, [switch]$RenewPairing)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
$runtimeDir = if ($RuntimeDirectory) { [IO.Path]::GetFullPath($RuntimeDirectory) } else { Join-Path $taskRoot '.codexphone' }
$backendRuntimeFile = Join-Path $runtimeDir 'backend-runtime.json'
$runtimeFile = Join-Path $runtimeDir 'shared-runtime.json'
$backendRoot = $taskRoot
$desktopPackage = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (-not $desktopPackage) { throw 'Cannot find the installed OpenAI.Codex desktop package.' }
$desktopExecutable = Join-Path $desktopPackage.InstallLocation 'app\ChatGPT.exe'
$bridgeEntry = Join-Path $taskRoot 'apps\host\dist\index.js'
if (-not (Test-Path -LiteralPath $bridgeEntry)) { throw 'Run pnpm build first.' }
if (($AppServerPort -ne 0 -and $AppServerPort -lt 1024) -or $AppServerPort -gt 65535 -or $PhonePort -lt 1024 -or $PhonePort -gt 65535 -or $AppServerPort -eq $PhonePort) { throw 'Invalid or conflicting port numbers.' }
$automaticPort = $AppServerPort -eq 0
if ($automaticPort) {
  $AppServerPort = 4501
  if (Test-Path -LiteralPath $backendRuntimeFile) {
    try {
      $recorded = Get-Content -LiteralPath $backendRuntimeFile -Raw | ConvertFrom-Json
      $recordedUrl = [Uri]$recorded.address
      if ($recordedUrl.Host -eq '127.0.0.1' -and $recordedUrl.Port -ge 1024 -and $recordedUrl.Port -ne $PhonePort) { $AppServerPort = $recordedUrl.Port }
    } catch { }
  }
}
$sharedAddress = "ws://127.0.0.1:$AppServerPort"
$nodeExecutable = Resolve-CodexPhoneNode $taskRoot

function Find-Desktop {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq $desktopExecutable -and $_.CommandLine -notmatch '--type=' -and
    (-not $env:CODEX_ELECTRON_USER_DATA_PATH -or $_.CommandLine -like "*$($env:CODEX_ELECTRON_USER_DATA_PATH)*")
  })
}
function Read-Backend([string]$BackendRoot = $backendRoot, [string]$StateFile = $backendRuntimeFile, [string]$Address = $sharedAddress) {
  $script:backendCheckReason = 'missing-state'
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try {
    $value = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $script:backendCheckReason = 'address-or-readiness'
    if ($value.address -ne $Address -or $value.status -ne 'connected' -or -not $value.guiInitialized) { return $null }
    $adapter = Get-CimInstance Win32_Process -Filter "ProcessId = $($value.adapterPid)"
    $backend = Get-CimInstance Win32_Process -Filter "ProcessId = $($value.backendPid)"
    $proxyPath = Join-Path $BackendRoot 'scripts\shared-cli-proxy.mjs'
    $script:backendCheckReason = 'backend-process-lineage'
    if ($adapter.Name -ne 'node.exe' -or $adapter.CommandLine -notlike "*$proxyPath*" -or $backend.ParentProcessId -ne $adapter.ProcessId -or $backend.Name -ne 'codex.exe') { return $null }
    $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($adapter.ParentProcessId)"
    $desktop = Get-CimInstance Win32_Process -Filter "ProcessId = $($native.ParentProcessId)"
    # Electron may spawn the CLI from its utility process rather than the main process.
    for ($depth = 0; $depth -lt 6 -and $desktop.ExecutablePath -eq $desktopExecutable -and $desktop.CommandLine -match '--type='; $depth++) {
      $desktop = Get-CimInstance Win32_Process -Filter "ProcessId = $($desktop.ParentProcessId)"
    }
    $expectedNativePath = Join-Path $BackendRoot '.codexphone\launcher\codexphone-cli.exe'
    $script:backendCheckReason = 'desktop-process-lineage'
    if ($native.ExecutablePath -ne $expectedNativePath -or $desktop.ExecutablePath -ne $desktopExecutable -or $desktop.CommandLine -match '--type=') { return $null }
    $script:backendCheckReason = 'desktop-profile'
    if ($env:CODEX_ELECTRON_USER_DATA_PATH -and $desktop.CommandLine -notlike "*$($env:CODEX_ELECTRON_USER_DATA_PATH)*") { return $null }
    $script:backendCheckReason = 'verified'
    return $value
  } catch { $script:backendCheckReason = 'state-read-error'; return $null }
}
function Find-Bridge {
  Find-CodexPhoneBridge $PhonePort
}
function Start-Bridge([bool]$Shared) {
  if ($Shared) { $env:CODEXPHONE_APP_SERVER_URL = $sharedAddress } else { Remove-Item Env:CODEXPHONE_APP_SERVER_URL -ErrorAction SilentlyContinue }
  foreach ($name in @('CODEX_CLI_PATH', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEXPHONE_APP_SERVER')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
  $env:HOST = '0.0.0.0'; $env:PORT = "$PhonePort"
  $tag = if ($Shared) { 'shared' } else { 'restored' }
  Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $bridgeEntry + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir "host-$tag.log") -RedirectStandardError (Join-Path $runtimeDir "host-$tag-error.log") -PassThru
}
function Wait-Bridge([bool]$Shared) {
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$PhonePort/api/health" -TimeoutSec 1
      if ($health.status -eq 'ready' -and (-not $Shared -or $health.transport -eq 'websocket')) { return $health }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw 'Phone bridge did not become ready. See the local host log.'
}

$launchMutex = $null
if (-not $CheckOnly) {
  $launchMutex = New-Object Threading.Mutex($false, "Local\CodexPhone-SharedLauncher-$PhonePort")
  try {
    if (-not $launchMutex.WaitOne(0)) { $launchMutex.Dispose(); Write-Output 'A CodexPhone launcher is already running or waiting for desktop exit.'; return }
  } catch [Threading.AbandonedMutexException] { }
}
try {
$runningDesktop = @(Find-Desktop)
$bridgeProcesses = @(Find-Bridge)
# A source checkout or another extracted EXE version may already own the healthy connection.
# Validate the live backend against that installation, then reuse it without stopping active work.
foreach ($bridge in $bridgeProcesses) {
  $registration = if ($bridge.CodexPhoneRoot -eq $taskRoot) { $runtimeFile } else { Join-Path $bridge.CodexPhoneRoot '.codexphone\shared-runtime.json' }
  try {
    $registered = Get-Content -LiteralPath $registration -Raw | ConvertFrom-Json
    if ($registered.bridgePid -ne $bridge.ProcessId -or $registered.phonePort -ne $PhonePort) { continue }
    $registeredAddress = [Uri]$registered.address
    if ($registeredAddress.Scheme -ne 'ws' -or $registeredAddress.Host -ne '127.0.0.1' -or $registeredAddress.UserInfo -or $registeredAddress.Port -lt 1024) { continue }
    if (-not $automaticPort -and $AppServerPort -ne $registeredAddress.Port) { continue }
    $ownerRoot = if ($registered.backendRoot) { [IO.Path]::GetFullPath($registered.backendRoot) } else { $bridge.CodexPhoneRoot }
    $ownerFile = Join-Path $ownerRoot '.codexphone\backend-runtime.json'
    if ($bridge.CodexPhoneRoot -eq $taskRoot -and $ownerRoot -eq $taskRoot) { $ownerFile = $backendRuntimeFile }
    $verifiedBackend = Read-Backend -BackendRoot $ownerRoot -StateFile $ownerFile -Address $registered.address
    if (-not $verifiedBackend -or $verifiedBackend.adapterPid -ne $registered.adapterPid -or $verifiedBackend.backendPid -ne $registered.appServerPid) { continue }
    $health = Invoke-RestMethod "http://127.0.0.1:$PhonePort/api/health" -TimeoutSec 2
    if ($health.status -ne 'ready' -or $health.transport -ne 'websocket') { continue }
    if (-not $CheckOnly -and -not $RenewPairing) {
      Write-Output 'Shared mode is already running in a verified CodexPhone installation. Existing tasks and phone pairing are preserved.'
      foreach ($address in @(Get-CodexPhoneAddresses $PhonePort)) { Write-Output "Open: $address" }
      return
    }
    $backendRoot = $ownerRoot; $backendRuntimeFile = $ownerFile
    $sharedAddress = $registered.address; $AppServerPort = $registeredAddress.Port
    break
  } catch { }
}
$existingBackend = Read-Backend
if (-not $CheckOnly -and $runningDesktop.Count -and -not $existingBackend -and (Test-Path -LiteralPath $backendRuntimeFile)) {
  # The GUI can restart its local host while applying initial feature configuration.
  for ($attempt = 0; $attempt -lt 30 -and -not $existingBackend; $attempt++) {
    Start-Sleep -Milliseconds 250
    $existingBackend = Read-Backend
  }
}
if ($CheckOnly) {
  [pscustomobject]@{ DesktopFound = $true; DesktopCurrentlyRunning = [bool]$runningDesktop.Count; SharedBackendRunning = [bool]$existingBackend; CodeBuilt = $true; WillRequireDesktopExit = [bool]($runningDesktop.Count -and -not $existingBackend); PhoneAddresses = @(Get-CodexPhoneAddresses $PhonePort); BundledNode = (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime\node.exe')); AdapterCompilerFound = (Test-Path -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')) }
  return
}
if ($runningDesktop.Count -and -not $existingBackend) {
  if (-not $WaitForDesktopExit) { throw "Finish tasks and fully exit Codex first, or use -WaitForDesktopExit. This script never force-closes the desktop. Backend check: $script:backendCheckReason" }
  Write-Output 'Waiting for Codex to exit normally. Finish tasks, then choose Quit/Exit in Codex. Do not reopen it manually; this launcher will reopen it.'
  while (@(Find-Desktop).Count) { Start-Sleep -Milliseconds 750 }
}
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$launcher = & (Join-Path $PSScriptRoot 'Build-SharedLauncher.ps1')
# Remove the launching chat's context. The GUI creates its own fresh tool pipe and identities.
foreach ($name in @('CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_CALL_ID', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'CODEX_APP_SERVER_WS_URL', 'CODEX_APP_RUNTIME_CLI_PATH')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
if (-not $env:CODEX_HOME) { $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex' }
$env:CODEXPHONE_SHARED_HOME = $env:CODEX_HOME
$env:CODEX_BIN = $launcher.CodexExecutable
$oldBridgeStopped = $false; $bridgeStarted = $null
try {
  $existingBackend = Read-Backend
  if (-not $existingBackend) {
    # A reused installation can disappear while the user exits the GUI; create our own owner next.
    $backendRoot = $taskRoot
    $backendRuntimeFile = Join-Path $runtimeDir 'backend-runtime.json'
    if ($automaticPort) {
      # A stale registry must not choose an unrelated occupied port outside our range.
      $AppServerPort = 4501
      while (Get-NetTCPConnection -LocalPort $AppServerPort -State Listen -ErrorAction SilentlyContinue) {
        $AppServerPort++
        if ($AppServerPort -eq $PhonePort) { $AppServerPort++ }
        if ($AppServerPort -gt 4600) { throw 'No free shared backend port found in the automatic range.' }
      }
      $sharedAddress = "ws://127.0.0.1:$AppServerPort"
    }
    if (Get-NetTCPConnection -LocalPort $AppServerPort -State Listen -ErrorAction SilentlyContinue) { throw 'Shared port is occupied by another process. No process was stopped.' }
    $env:CODEX_CLI_PATH = $launcher.Executable
    Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
    $env:CODEXPHONE_SHARED_PORT = "$AppServerPort"
    $env:CODEXPHONE_SHARED_RUNTIME_FILE = $backendRuntimeFile
    $env:CODEXPHONE_SHARED_SESSION = [Guid]::NewGuid().ToString('N')
    $desktopOptions = @{ FilePath = $desktopExecutable; WorkingDirectory = $taskRoot; WindowStyle = 'Normal'; PassThru = $true }
    if ($env:CODEX_ELECTRON_USER_DATA_PATH) { $desktopOptions.ArgumentList = ('"--user-data-dir=' + $env:CODEX_ELECTRON_USER_DATA_PATH + '"') }
    $desktopStarted = Start-Process @desktopOptions
    $stableAdapter = $null; $stableSince = $null; $backendStable = $false
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
      $existingBackend = Read-Backend
      if ($existingBackend) {
        if ($stableAdapter -ne $existingBackend.adapterPid) { $stableAdapter = $existingBackend.adapterPid; $stableSince = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - $stableSince).TotalSeconds -ge 15) { $backendStable = $true; break }
      } else { $stableAdapter = $null; $stableSince = $null }
      Start-Sleep -Milliseconds 250
    }
    if (-not $backendStable) { throw 'Desktop did not initialize a stable shared backend. Its window and the original phone bridge were preserved. Check .codexphone/backend-runtime.json.' }
  }
  $bridgeProcesses = @(Find-Bridge)
  $currentHealth = $null
  try { $currentHealth = Invoke-RestMethod "http://127.0.0.1:$PhonePort/api/health" -TimeoutSec 2 } catch { }
  $bridgeMatchesBackend = $false
  if (Test-Path -LiteralPath $runtimeFile) {
    try {
      $savedRuntime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
      $bridgeMatchesBackend = $savedRuntime.address -eq $sharedAddress -and $savedRuntime.adapterPid -eq $existingBackend.adapterPid -and @($bridgeProcesses | Where-Object ProcessId -eq $savedRuntime.bridgePid).Count -eq 1
    } catch { }
  }
  if (-not $RenewPairing -and $bridgeMatchesBackend -and $currentHealth -and $currentHealth.status -eq 'ready' -and $currentHealth.transport -eq 'websocket') {
    Write-Output 'Shared mode is already running. Phone pairing is preserved.'
    return
  }
  if ($currentHealth -and $currentHealth.activeTasks -gt 0) { throw 'A phone task is running. Wait for it to finish before replacing the phone bridge.' }
  foreach ($bridgeProcess in $bridgeProcesses) {
    & taskkill.exe /PID $bridgeProcess.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the previous verified phone bridge.' }
    $oldBridgeStopped = $true
  }
  $bridgeStarted = Start-Bridge $true
  $health = Wait-Bridge $true
  $desktopProcessId = if ($desktopStarted) { $desktopStarted.Id } else { @(Find-Desktop | Select-Object -First 1)[0].ProcessId }
  @{ mode = 'gui-owned-stdio-adapter'; desktopPid = $desktopProcessId; bridgePid = $bridgeStarted.Id; appServerPid = $existingBackend.backendPid; adapterPid = $existingBackend.adapterPid; backendRoot = $backendRoot; address = $sharedAddress; phonePort = $PhonePort; startedAt = [DateTime]::UtcNow.ToString('o'); guiInitialized = $true; appToolsEnvironmentPresent = $existingBackend.appToolsEnvironmentPresent } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
  Write-Output 'Shared mode ready. Phone pairing is preserved. Start Codex with Start-CodexPhone.cmd next time.'
  foreach ($address in @(Get-CodexPhoneAddresses $PhonePort)) { Write-Output "Open: $address" }
} catch {
  $failure = $_
  if ($bridgeStarted) {
    $verified = @(Find-Bridge | Where-Object ProcessId -eq $bridgeStarted.Id)
    if ($verified.Count) { & taskkill.exe /PID $bridgeStarted.Id /T /F | Out-Null }
  }
  if ($oldBridgeStopped) {
    $restored = Start-Bridge $false
    try { $null = Wait-Bridge $false; Write-Warning 'The previous standalone phone bridge has been restored. Existing pairing is preserved.' } catch { Write-Warning 'Automatic bridge recovery failed. Run Start-Standalone.ps1 from a new PowerShell.' }
  }
  throw $failure
}
} finally {
  if ($launchMutex) { $launchMutex.ReleaseMutex(); $launchMutex.Dispose() }
}
