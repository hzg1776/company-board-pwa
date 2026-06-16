param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = "",
    [string]$DataDirectory = "",
    [switch]$IncludeLogs
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ProjectRoot "backups"
}

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $DataDirectory = Join-Path $ProjectRoot "data"
}

if (-not (Test-Path -LiteralPath $DataDirectory)) {
    throw "Data directory not found: $DataDirectory"
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupName = "company-board-backup-$timestamp"
$stagingRoot = Join-Path $env:TEMP $backupName
$backupZip = Join-Path $OutputRoot "$backupName.zip"
$manifestPath = Join-Path $OutputRoot "$backupName.manifest.json"

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
$stagingData = Join-Path $stagingRoot "data"
New-Item -ItemType Directory -Force -Path $stagingData | Out-Null

Copy-Item -LiteralPath (Join-Path $DataDirectory "*") -Destination $stagingData -Recurse -Force

if ($IncludeLogs) {
    $logDir = Join-Path $ProjectRoot "logs"
    if (Test-Path -LiteralPath $logDir) {
        Copy-Item -LiteralPath $logDir -Destination (Join-Path $stagingRoot "logs") -Recurse -Force
    }
}

$manifest = [ordered]@{
    backupName = $backupName
    createdAt = (Get-Date).ToString("o")
    machineName = $env:COMPUTERNAME
    projectRoot = $ProjectRoot
    dataDirectory = $DataDirectory
    publicBaseUrl = $env:PUBLIC_BASE_URL
    includeLogs = [bool]$IncludeLogs
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingRoot "manifest.json")
Compress-Archive -LiteralPath (Join-Path $stagingRoot "*") -DestinationPath $backupZip -Force
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Host "Backup created: $backupZip"
Write-Host "Manifest written: $manifestPath"
