param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z]:$')]
    [string]$UsbDrive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($UsbDrive -notmatch '^[A-Za-z]:$') {
    throw 'UsbDrive must be one drive letter followed by a colon.'
}

$driveName = $UsbDrive.Substring(0, 1).ToUpperInvariant()
$usbRoot = "$driveName`:\"

if (-not ('ProjectA.HostPrep.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ProjectA.HostPrep {
    public static class NativeMethods {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint QueryDosDevice(string deviceName, StringBuilder targetPath, int maximumLength);
    }
}
'@
}

$deviceTarget = New-Object System.Text.StringBuilder 4096
$deviceLength = [ProjectA.HostPrep.NativeMethods]::QueryDosDevice(
    $UsbDrive,
    $deviceTarget,
    $deviceTarget.Capacity
)
if ($deviceLength -eq 0) {
    throw "Drive $UsbDrive could not be resolved as a local device."
}
$devicePath = $deviceTarget.ToString()
if (
    $devicePath.StartsWith('\??\', [System.StringComparison]::OrdinalIgnoreCase) -or
    $devicePath.StartsWith('\Device\Mup', [System.StringComparison]::OrdinalIgnoreCase) -or
    $devicePath.StartsWith('\Device\LanmanRedirector', [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "Drive $UsbDrive is substituted or network-backed and is not permitted."
}

$psDrive = Get-PSDrive -Name $driveName -ErrorAction Stop
if ($psDrive.Provider.Name -ne 'FileSystem' -or $psDrive.DisplayRoot) {
    throw "Drive $UsbDrive is not a literal local filesystem root."
}
$rootItem = Get-Item -LiteralPath $usbRoot -Force -ErrorAction Stop
if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Drive $UsbDrive has a reparse-point root and is not permitted."
}

$logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$UsbDrive'"
if (-not $logicalDisk) {
    throw "Drive $UsbDrive was not found."
}
if ([int]$logicalDisk.DriveType -ne 2) {
    throw "Drive $UsbDrive is not reported by Windows as removable media."
}
if ([string]$logicalDisk.FileSystem -ne 'FAT32') {
    throw "Drive $UsbDrive must be FAT32 for this approved handoff."
}
if ([uint64]$logicalDisk.FreeSpace -lt [uint64]104857600) {
    throw "Drive $UsbDrive has less than 100 MiB free."
}

$node = Get-Command node.exe -CommandType Application -ErrorAction Stop
$nodeVersionOutput = @(& $node.Source --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersionOutput.Count -ne 1) {
    throw 'Could not determine the Node.js version.'
}
$nodeVersion = ([string]$nodeVersionOutput[0]).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.') {
    throw 'Could not determine the Node.js version.'
}
if ([int]$Matches.major -lt 22) {
    throw 'Node.js 22 or newer is required.'
}

$phase1Root = Join-Path $usbRoot 'Project-A-Migration'
$phase2Root = Join-Path $usbRoot 'Project-A-Migration-Phase-2-Host-Prep'
if (-not (Test-Path -LiteralPath $phase1Root -PathType Container)) {
    throw 'The verified returned Project-A-Migration directory is missing.'
}
if (Test-Path -LiteralPath $phase2Root) {
    throw 'Project-A-Migration-Phase-2-Host-Prep already exists; it will not be overwritten.'
}

$builder = Join-Path $PSScriptRoot 'build-usb-host-prep.mjs'
$builderOutput = @(& $node.Source $builder --usb-root $usbRoot)
if ($LASTEXITCODE -ne 0) {
    throw 'Phase 2 host-prep bundle creation failed.'
}
if ($builderOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$builderOutput[0])) {
    throw 'The Phase 2 builder did not return exactly one JSON object.'
}
$builderJson = ([string]$builderOutput[0]).Trim()
try {
    $builderResult = $builderJson | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'The Phase 2 builder returned invalid JSON.'
}
$expectedFields = @(
    'fileCount',
    'manifestFingerprint',
    'phase1ReportFileName',
    'phase1ReportSha256',
    'phase1Unchanged',
    'rootName'
)
$actualFields = @($builderResult.PSObject.Properties.Name | Sort-Object)
if (($actualFields -join "`n") -ne ($expectedFields -join "`n")) {
    throw 'The Phase 2 builder returned an unexpected JSON schema.'
}
if (
    $builderResult.rootName -ne 'Project-A-Migration-Phase-2-Host-Prep' -or
    [int]$builderResult.fileCount -ne 6 -or
    [bool]$builderResult.phase1Unchanged -ne $true -or
    [string]$builderResult.manifestFingerprint -notmatch '^[a-f0-9]{64}$' -or
    [string]$builderResult.phase1ReportSha256 -notmatch '^[a-f0-9]{64}$'
) {
    throw 'The Phase 2 builder returned invalid verification metadata.'
}

$phase2Verifier = Join-Path $PSScriptRoot 'verify-usb-host-prep.mjs'
& $node.Source $phase2Verifier --handoff-root $phase2Root --mode outbound | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Independent Phase 2 outbound verification failed.'
}

$phase1Verifier = Join-Path $PSScriptRoot 'verify-usb-handoff.mjs'
& $node.Source $phase1Verifier --handoff-root $phase1Root --mode returned | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Returned Phase 1 re-verification failed.'
}

Write-Output $builderJson
Write-Output "Retain this full Phase 2 manifest fingerprint out of band: $($builderResult.manifestFingerprint)"
