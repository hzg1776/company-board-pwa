param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$RuntimeRoot = "",
    [string]$OutputRoot = "",
    [string]$DataDirectory = "",
    [switch]$IncludeLogs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "runtime-state.ps1")

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ([string]::IsNullOrWhiteSpace($RuntimeRoot) -and $env:ProgramData) {
    $defaultRuntimeRoot = Get-DefaultBoardRuntimeRoot
    $defaultDataDirectory = Join-Path $defaultRuntimeRoot "data"

    if ((Test-IsAdministrator) -and (Test-Path -LiteralPath $defaultDataDirectory)) {
        $RuntimeRoot = $defaultRuntimeRoot
    }
}

$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $DataDirectory = $runtimeLayout.DataDirectory
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = $runtimeLayout.BackupDirectory
}

if (-not (Test-Path -LiteralPath $DataDirectory)) {
    throw "Data directory not found: $DataDirectory"
}

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupName = "company-board-backup-$timestamp"
$stagingRoot = Join-Path $OutputRoot ".$backupName.staging"
$backupZip = Join-Path $OutputRoot "$backupName.zip"
$manifestPath = Join-Path $OutputRoot "$backupName.manifest.json"

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

try {
    New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
    $stagingData = Join-Path $stagingRoot "data"
    New-Item -ItemType Directory -Force -Path $stagingData | Out-Null

    Get-ChildItem -LiteralPath $DataDirectory -Force | Copy-Item -Destination $stagingData -Recurse -Force

    if ($IncludeLogs) {
        $logDir = $runtimeLayout.LogDirectory
        if (Test-Path -LiteralPath $logDir) {
            Copy-Item -LiteralPath $logDir -Destination (Join-Path $stagingRoot "logs") -Recurse -Force
        }
    }

    $manifest = [ordered]@{
        backupName = $backupName
        createdAt = (Get-Date).ToString("o")
        machineName = $env:COMPUTERNAME
        projectRoot = $ProjectRoot
        runtimeRoot = $runtimeLayout.RuntimeRoot
        dataDirectory = $DataDirectory
        publicBaseUrl = $env:PUBLIC_BASE_URL
        includeLogs = [bool]$IncludeLogs
    }

    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingRoot "manifest.json")
    Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $backupZip -Force
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath

    Write-Host "Backup created: $backupZip"
    Write-Host "Manifest written: $manifestPath"
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
