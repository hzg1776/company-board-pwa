[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [string]$RuntimeDataDirectory = 'C:\ProgramData\Palziv\runtime\data',
  [Parameter(Mandatory = $true)][string]$ProductionEnvironmentFile,
  [Parameter(Mandatory = $true)][string]$CloudflaredCredentialFile,
  [Parameter(Mandatory = $true)][string]$CloudflaredConfigFile,
  [Parameter(Mandatory = $true)][string]$AgeExecutable,
  [string[]]$ProjectATaskNames = @(
    'CompanyBoardPWA Startup',
    'CompanyBoardPWA Startup Recovery',
    'CompanyBoardPWA Startup Tunnel Watchdog'
  ),
  [string]$CloudflaredServiceName = 'cloudflared',
  [switch]$AuthorizeCutover
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $AuthorizeCutover) {
  throw 'Explicit cutover authorization is required. Do not run this during Phase 1.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this command in an Administrator PowerShell window.'
}

function Resolve-SafeFile([string]$Path, [string]$Label) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path." }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a regular non-reparse file."
  }
  return $item.FullName
}

function Resolve-SafeDirectory([string]$Path, [string]$Label) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path." }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must be a real non-reparse directory."
  }
  return $item.FullName
}

$resolvedBundle = Resolve-SafeDirectory $BundleRoot 'USB bundle'
$resolvedData = Resolve-SafeDirectory $RuntimeDataDirectory 'Runtime data directory'
$resolvedEnvironment = Resolve-SafeFile $ProductionEnvironmentFile 'Production environment file'
$resolvedCredential = Resolve-SafeFile $CloudflaredCredentialFile 'Cloudflared credential file'
$resolvedConfig = Resolve-SafeFile $CloudflaredConfigFile 'Cloudflared config file'
$resolvedAge = Resolve-SafeFile $AgeExecutable 'age executable'
foreach ($name in @('analytics.json', 'board.json', 'push.json', 'security.json')) {
  [void](Resolve-SafeFile (Join-Path $resolvedData $name) "Runtime file $name")
}
[void](Get-Content -Raw -LiteralPath (Join-Path $resolvedBundle 'FROM-DEBIAN\STAGE-SUCCESS.json') | ConvertFrom-Json)

$taskStates = @()
foreach ($taskName in $ProjectATaskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $taskStates += [ordered]@{ name = $task.TaskName; enabled = ($task.State -ne 'Disabled') }
  }
}
$service = Get-Service -Name $CloudflaredServiceName -ErrorAction Stop
$sourceStateRoot = 'C:\ProgramData\Palziv\migration-cutover'
New-Item -ItemType Directory -Path $sourceStateRoot -Force | Out-Null
$sourceState = [ordered]@{
  schemaVersion = 1
  tasks = $taskStates
  cloudflaredServiceName = $service.Name
  cloudflaredWasRunning = ($service.Status -eq 'Running')
  recordedAt = [DateTime]::UtcNow.ToString('o')
}
$statePath = Join-Path $sourceStateRoot 'WINDOWS-SOURCE-STATE.json'
$sourceState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8

foreach ($task in $taskStates) {
  Disable-ScheduledTask -TaskName $task.name | Out-Null
  Stop-ScheduledTask -TaskName $task.name -ErrorAction SilentlyContinue
}
Stop-Service -Name $CloudflaredServiceName -Force
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3116 -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if ($process.ProcessName -ne 'node') {
    throw "Port 3116 is owned by unexpected process $($process.ProcessName). Windows remains frozen."
  }
  Stop-Process -Id $process.Id -Force
}
if (Get-NetTCPConnection -State Listen -LocalPort 3116 -ErrorAction SilentlyContinue) {
  throw 'Windows listener on port 3116 did not stop. Windows remains frozen.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$releaseSha = (& git -C $repositoryRoot rev-parse HEAD).Trim()
& node (Join-Path $PSScriptRoot 'prepare-two-phase-cutover.mjs') `
  --bundle-root $resolvedBundle `
  --runtime-data-dir $resolvedData `
  --production-env $resolvedEnvironment `
  --cloudflared-credential $resolvedCredential `
  --cloudflared-config $resolvedConfig `
  --age-executable $resolvedAge `
  --release-sha $releaseSha `
  --authorize-cutover
if ($LASTEXITCODE -ne 0) {
  throw 'Encrypted cutover preparation failed. Windows remains frozen; use ROLLBACK-WINDOWS.ps1 only if Debian received no writes.'
}
Write-Host 'CUTOVER PAYLOAD READY: Windows is frozen. Move the USB to Debian and run Phase 2.'

