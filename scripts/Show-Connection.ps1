param([int]$PhonePort = 4318, [switch]$RenewPairing)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Common.ps1')
if ($RenewPairing) {
  & (Join-Path $PSScriptRoot 'Start-SharedCodex.ps1') -PhonePort $PhonePort -RenewPairing
}
$health = Invoke-RestMethod "http://127.0.0.1:$PhonePort/api/health" -TimeoutSec 3
Write-Output "CodexPhone: $($health.status) / $($health.transport); paired devices: $($health.pairedDevices)"
foreach ($address in @(Get-CodexPhoneAddresses $PhonePort)) { Write-Output "Open: $address" }
Write-Output 'Connect the phone and this computer to the same Tailscale network.'
$runtime = Join-Path $taskRoot '.codexphone\shared-runtime.json'
if (Test-Path -LiteralPath $runtime) {
  $saved = Get-Content -LiteralPath $runtime -Raw | ConvertFrom-Json
  $listener = @(Get-NetTCPConnection -LocalPort $PhonePort -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $saved.bridgePid)
  if ($listener.Count) {
    $log = Join-Path $taskRoot '.codexphone\host-shared.log'
    $pairing = $null
    if (Test-Path -LiteralPath $log) {
      foreach ($line in @(Get-Content -LiteralPath $log -Tail 300 -ErrorAction SilentlyContinue)) {
        try { $entry = $line | ConvertFrom-Json; if ($entry.pairing) { $pairing = $entry.pairing } } catch { }
      }
    }
    if ($pairing -and [DateTimeOffset]::Parse($pairing.expiresAt) -gt [DateTimeOffset]::UtcNow) {
      Write-Output ''
      Write-Output "One-time pairing code: $($pairing.code)"
      Write-Output "Expires: $($pairing.expiresAt). One use only. Do not share this code publicly."
    } else { Write-Output 'Pairing code has expired or is unavailable. Run Pair-Phone.cmd to issue another code when no phone task is active.' }
  }
}
Write-Output 'Existing phones remain paired. Manage project folders from the phone after pairing.'
