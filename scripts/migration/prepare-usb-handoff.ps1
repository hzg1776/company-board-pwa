[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^[A-Za-z]:$')]
    [string]$UsbDrive = 'D:'
)

$ErrorActionPreference = 'Stop'

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
if ([uint64]$logicalDisk.FreeSpace -lt 100MB) {
    throw "Drive $UsbDrive has less than 100 MB free."
}

$node = Get-Command node.exe -ErrorAction Stop
$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(?<major>\d+)\.') {
    throw "Could not determine the Node.js version."
}
if ([int]$Matches.major -lt 22) {
    throw "Node.js 22 or newer is required."
}

$builder = Join-Path $PSScriptRoot 'build-usb-handoff.mjs'
& $node.Source $builder --usb-root "$UsbDrive\"
if ($LASTEXITCODE -ne 0) {
    throw "USB handoff creation failed."
}
