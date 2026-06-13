[CmdletBinding()]
param(
  [int]$Port = 3116,
  [string]$ProjectRoot,
  [string]$CloudflaredServiceName = "cloudflared",
  [switch]$SkipCloudflared
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

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Get-PortListeners {
  param([int]$TargetPort)

  return Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
}

function Resolve-NodeExecutable {
  try {
    $node = Get-Command node -ErrorAction Stop
    if ($node.Source) {
      return $node.Source
    }
  } catch {
    # Fall through to common install locations.
  }

  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Node.js was not found. Install Node.js before enabling startup."
}

function Start-BoardApp {
  param(
    [string]$Root,
    [int]$TargetPort,
    [string]$LogDirectory
  )

  $listeners = Get-PortListeners -TargetPort $TargetPort
  if ($listeners) {
    $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    $processNames = foreach ($pid in $processIds) {
      try {
        (Get-Process -Id $pid -ErrorAction Stop).ProcessName
      } catch {
        "pid:$pid"
      }
    }

    Write-Host "Port ${TargetPort} is already in use by: $($processNames -join ', ')."
    Write-Host "Skipping app start to avoid a duplicate instance."
    return
  }

  $nodePath = Resolve-NodeExecutable
  $escapedRoot = $Root.Replace("'", "''")
  $escapedNode = $nodePath.Replace("'", "''")
  $serverFile = Join-Path $Root "server.js"
  $escapedServerFile = $serverFile.Replace("'", "''")
  $childCommand = @"
Set-Location -LiteralPath '$escapedRoot'
`$env:PORT = '$TargetPort'
& '$escapedNode' '$escapedServerFile'
"@

  $stdout = Join-Path $LogDirectory "board-app.out.log"
  $stderr = Join-Path $LogDirectory "board-app.err.log"

  Start-Process -FilePath "powershell.exe" `
    -WindowStyle Hidden `
    -WorkingDirectory $Root `
    -ArgumentList @("-NoProfile", "-Command", $childCommand) `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr | Out-Null

  Write-Host "Started npm start on port ${TargetPort}."
  Write-Host "App logs: $stdout"
  Write-Host "App errors: $stderr"
}

function Ensure-CloudflaredService {
  param([string]$ServiceName)

  try {
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
  } catch {
    Write-Warning "cloudflared service '$ServiceName' was not found."
    Write-Warning "Install the Cloudflare tunnel service first, then rerun this script."
    return
  }

  if ($service.Status -ne "Running") {
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 2
    $service = Get-Service -Name $ServiceName
  }

  Write-Host "cloudflared service status: $($service.Status)"
}

Write-Step "Confirm project root"
if (-not (Test-Path $ProjectRoot)) {
  throw "Project root not found: $ProjectRoot"
}
Write-Host "Project root: $ProjectRoot"

Set-Location $ProjectRoot
$logDirectory = Join-Path $ProjectRoot "logs"
Ensure-Directory -Path $logDirectory

Write-Step "Start the board app"
Start-BoardApp -Root $ProjectRoot -TargetPort $Port -LogDirectory $logDirectory

if (-not $SkipCloudflared) {
  Write-Step "Start cloudflared"
  Ensure-CloudflaredService -ServiceName $CloudflaredServiceName
}

Write-Step "Recovery summary"
Write-Host "Local board: http://localhost:$Port/employee"
Write-Host "Admin board: http://localhost:$Port/admin"
Write-Host "If the tunnel service is installed and running, it will bridge the same local port to itotexpress.com."
