[CmdletBinding()]
param([switch]$ConfirmNoTargetWrites)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ConfirmNoTargetWrites) {
  throw 'Rollback is blocked unless you confirm Debian received no user writes.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this command in an Administrator PowerShell window.'
}
$statePath = 'C:\ProgramData\Palziv\migration-cutover\WINDOWS-SOURCE-STATE.json'
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($state.schemaVersion -ne 1) { throw 'The Windows source-state record is invalid.' }

if ($state.cloudflaredWasRunning) {
  Start-Service -Name $state.cloudflaredServiceName
}
foreach ($task in $state.tasks) {
  if ($task.enabled) {
    Enable-ScheduledTask -TaskName $task.name | Out-Null
    Start-ScheduledTask -TaskName $task.name
  }
}
Start-Sleep -Seconds 3
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3116 -ErrorAction SilentlyContinue)) {
  throw 'Windows rollback did not restore the Project-A listener.'
}
Write-Host 'WINDOWS ROLLBACK COMPLETE: Windows is the source again. Keep Debian app and tunnel stopped.'
