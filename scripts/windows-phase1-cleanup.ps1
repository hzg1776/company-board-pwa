[CmdletBinding()]
param(
  [int]$Port = 3116,
  [string]$ProjectRoot,
  [string]$RuntimeRoot = "",
  [switch]$ResetLockFile,
  [switch]$ForcePortRecovery
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

. (Join-Path $PSScriptRoot "runtime-state.ps1")

function Get-PortListeners {
  param([int]$TargetPort)

  return Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

function Is-BoardAppProcess {
  param(
    [int]$ProcessId,
    [string]$Root
  )

  $serverPath = (Join-Path $Root "server.js")
  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId

  if (-not $commandLine) {
    return $false
  }

  return $commandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-PortListener {
  param(
    [int]$TargetPort,
    [string]$Root,
    [switch]$AllowForeignListeners
  )

  $listeners = Get-PortListeners -TargetPort $TargetPort
  if (-not $listeners) {
    Write-Host "No listener found on port $TargetPort."
    return
  }

  $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  $foreignOwners = @()

  foreach ($processId in $pids) {
    if (-not (Is-BoardAppProcess -ProcessId $processId -Root $Root)) {
      $processName = try {
        (Get-Process -Id $processId -ErrorAction Stop).ProcessName
      } catch {
        "pid:$processId"
      }
      $foreignOwners += "$processName [$processId]"
    }
  }

  if ($foreignOwners.Count -and -not $AllowForeignListeners) {
    throw "Port ${TargetPort} is owned by non-board process(es): $($foreignOwners -join ', '). Resolve the conflict manually or rerun with -ForcePortRecovery."
  }

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

$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot
$dataFile = Join-Path $runtimeLayout.DataDirectory "board.json"
if (-not (Test-Path $dataFile)) {
  throw "Live data file not found: $dataFile"
}

Write-Step "Back up live board data"
$backupDir = $runtimeLayout.BackupDirectory
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = Join-Path $backupDir "board-$stamp.json"
Copy-Item -Path $dataFile -Destination $backupFile -Force
Write-Host "Backup created: $backupFile"

Write-Step "Stop anything holding the app port"
Stop-PortListener -TargetPort $Port -Root $ProjectRoot -AllowForeignListeners:$ForcePortRecovery

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
