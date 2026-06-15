[CmdletBinding()]
param(
  [int]$Port = 3116,
  [string]$ProjectRoot,
  [switch]$ResetLockFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not $ProjectRoot) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  $ProjectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

function Stop-PortListener {
  param([int]$TargetPort)

  $listeners = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
  if (-not $listeners) {
    Write-Host "No listener found on port $TargetPort."
    return
  }

  $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pid in $pids) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Stopped process(es) on port ${TargetPort}: $($pids -join ', ')"
}

Write-Step "Confirm project root"
if (-not (Test-Path $ProjectRoot)) {
  throw "Project root not found: $ProjectRoot"
}
Write-Host "Project root: $ProjectRoot"

$dataFile = Join-Path $ProjectRoot "data\board.json"
if (-not (Test-Path $dataFile)) {
  throw "Live data file not found: $dataFile"
}

Write-Step "Back up live board data"
$backupDir = Join-Path $ProjectRoot "data\backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = Join-Path $backupDir "board-$stamp.json"
Copy-Item -Path $dataFile -Destination $backupFile -Force
Write-Host "Backup created: $backupFile"

Write-Step "Stop anything holding the app port"
Stop-PortListener -TargetPort $Port

Write-Step "Remove disposable runtime artifacts"
$nodeModules = Join-Path $ProjectRoot "node_modules"
if (Test-Path $nodeModules) {
  Remove-Item -Recurse -Force $nodeModules
  Write-Host "Removed node_modules"
} else {
  Write-Host "node_modules already absent."
}

if ($ResetLockFile) {
  $lockFile = Join-Path $ProjectRoot "package-lock.json"
  if (Test-Path $lockFile) {
    Remove-Item -Force $lockFile
    Write-Host "Removed package-lock.json because -ResetLockFile was used."
  }
}

Write-Step "Clear npm cache"
npm cache clean --force

Write-Step "Reinstall dependencies"
Set-Location $ProjectRoot
npm install

Write-Step "Run test suite"
npm test

Write-Step "Next manual checks"
Write-Host "1. Start the app with: `$env:PORT = '$Port'; npm start"
Write-Host "2. Confirm http://localhost:$Port/palzivalerts loads."
Write-Host "3. If you changed static assets, purge Cloudflare cache manually in the dashboard."
