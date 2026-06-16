param(
    [Parameter(Mandatory = $true)]
    [string]$BackupZip,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataDirectory = "",
    [int]$Port = 3116,
    [switch]$RestartApp
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $DataDirectory = Join-Path $ProjectRoot "data"
}

if (-not (Test-Path -LiteralPath $BackupZip)) {
    throw "Backup zip not found: $BackupZip"
}

if (-not (Test-Path -LiteralPath $DataDirectory)) {
    throw "Data directory not found: $DataDirectory"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$extractRoot = Join-Path $env:TEMP "company-board-restore-$timestamp"
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

Expand-Archive -LiteralPath $BackupZip -DestinationPath $extractRoot -Force

$restoredData = Join-Path $extractRoot "data"
if (-not (Test-Path -LiteralPath $restoredData)) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
    throw "Backup zip does not contain a data directory."
}

$preRestoreBackup = Join-Path $ProjectRoot "scripts\\backup-data.ps1"
& powershell -ExecutionPolicy Bypass -File $preRestoreBackup -ProjectRoot $ProjectRoot | Out-Null

Get-ChildItem -LiteralPath $DataDirectory -Force | Remove-Item -Recurse -Force
Copy-Item -LiteralPath (Join-Path $restoredData "*") -Destination $DataDirectory -Recurse -Force

if ($RestartApp) {
    $startupScript = Join-Path $ProjectRoot "scripts\\windows-startup.ps1"
    if (-not (Test-Path -LiteralPath $startupScript)) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
        throw "Startup script not found: $startupScript"
    }

    & powershell -ExecutionPolicy Bypass -File $startupScript -Port $Port -ProjectRoot $ProjectRoot
}

Remove-Item -LiteralPath $extractRoot -Recurse -Force
Write-Host "Restore completed from: $BackupZip"
