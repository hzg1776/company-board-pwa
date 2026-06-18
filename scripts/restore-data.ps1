param(
    [Parameter(Mandatory = $true)]
    [string]$BackupZip,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$RuntimeRoot = "",
    [string]$DataDirectory = "",
    [int]$Port = 3116,
    [switch]$RestartApp
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "runtime-state.ps1")
$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $DataDirectory = $runtimeLayout.DataDirectory
}

if (-not (Test-Path -LiteralPath $BackupZip)) {
    throw "Backup zip not found: $BackupZip"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$extractRoot = Join-Path $runtimeLayout.BackupDirectory ".company-board-restore-$timestamp"

try {
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -LiteralPath $BackupZip -DestinationPath $extractRoot -Force

    $restoredData = Join-Path $extractRoot "data"
    if (-not (Test-Path -LiteralPath $restoredData)) {
        throw "Backup zip does not contain a data directory."
    }

    $preRestoreBackup = Join-Path $ProjectRoot "scripts\\backup-data.ps1"
    & powershell -ExecutionPolicy Bypass -File $preRestoreBackup -ProjectRoot $ProjectRoot -RuntimeRoot $runtimeLayout.RuntimeRoot | Out-Null

    Get-ChildItem -LiteralPath $DataDirectory -Force | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $restoredData -Force | Copy-Item -Destination $DataDirectory -Recurse -Force

    if ($RestartApp) {
        $startupScript = Join-Path $ProjectRoot "scripts\\windows-startup.ps1"
        if (-not (Test-Path -LiteralPath $startupScript)) {
            throw "Startup script not found: $startupScript"
        }

        & powershell -ExecutionPolicy Bypass -File $startupScript -Port $Port -ProjectRoot $ProjectRoot -RuntimeRoot $runtimeLayout.RuntimeRoot
    }

    Write-Host "Restore completed from: $BackupZip"
} finally {
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
}
