[CmdletBinding()]
param(
  [string]$SetupToken = "it-bootstrap-2026",
  [string]$ItUrl = "http://localhost:3000/palzivalerts/it",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-ListeningProcessIdsForPort {
  param([int]$Port)

  return @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$projectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$localSecretsDir = Join-Path $projectRoot "local-secrets"
$bootstrapTokenFile = Join-Path $localSecretsDir "bootstrap-token.txt"

if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  throw "Could not find package.json in $projectRoot."
}

Write-Step "Project root"
Write-Host $projectRoot

Push-Location $projectRoot

if (-not (Test-Path -LiteralPath $localSecretsDir)) {
  New-Item -ItemType Directory -Force -Path $localSecretsDir | Out-Null
}

[System.IO.File]::WriteAllText(
  $bootstrapTokenFile,
  ($SetupToken + [Environment]::NewLine),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Step "Wrote local bootstrap token"
Write-Host $bootstrapTokenFile

$serverJsPath = (Join-Path $projectRoot "server.js")
$existingPids = Get-ListeningProcessIdsForPort -Port 3000

foreach ($processId in $existingPids) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $process) {
    continue
  }

  if ([string]$process.CommandLine -match [regex]::Escape($serverJsPath) -or [string]$process.CommandLine -match 'node\.exe"\s+server\.js') {
    Write-Step "Stopping existing local app on port 3000 (PID $processId)"
    Stop-Process -Id $processId -Force
  }
}

if (-not $SkipInstall) {
  Write-Step "Installing dependencies"
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "npm install failed."
  }
}

$escapedProjectRoot = $projectRoot.Replace('"', '\"')
$escapedSetupToken = $SetupToken.Replace('"', '\"')
$cmdLine = "cd /d `"$escapedProjectRoot`" && set ADMIN_SETUP_TOKEN=$escapedSetupToken && npm start"

Write-Step "Starting app server in a new window"
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $cmdLine -WorkingDirectory $projectRoot

Write-Step "Opening IT setup page"
Start-Sleep -Seconds 3
Start-Process $ItUrl

Pop-Location

Write-Host ""
Write-Host "Use these values on the page:" -ForegroundColor Green
Write-Host "Deployment setup secret: $SetupToken"
Write-Host "Create username: it1"
Write-Host "Create password: ItPassword123!"
