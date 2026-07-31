param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z]:$')]
    [string]$UsbDrive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-HostPrepDosDeviceTarget {
    param(
        [Parameter(Mandatory = $true)][string]$Drive,
        [Parameter(Mandatory = $true)][string]$Target
    )
    if (
        $Target.StartsWith('\??\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $Target.StartsWith('\Device\Mup', [System.StringComparison]::OrdinalIgnoreCase) -or
        $Target.StartsWith('\Device\LanmanRedirector', [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "Drive $Drive is substituted or network-backed and is not permitted."
    }
}

function Get-HostPrepDeviceSnapshot {
    param([Parameter(Mandatory = $true)][string]$Drive)

    $driveName = $Drive.Substring(0, 1).ToUpperInvariant()
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
        $Drive,
        $deviceTarget,
        $deviceTarget.Capacity
    )
    if ($deviceLength -eq 0) {
        throw "Drive $Drive could not be resolved as a local device."
    }
    $devicePath = $deviceTarget.ToString()
    Assert-HostPrepDosDeviceTarget -Drive $Drive -Target $devicePath

    $psDrive = Get-PSDrive -Name $driveName -ErrorAction Stop
    if ($psDrive.Provider.Name -ne 'FileSystem' -or $psDrive.DisplayRoot) {
        throw "Drive $Drive is not a literal local filesystem root."
    }
    $rootItem = Get-Item -LiteralPath $usbRoot -Force -ErrorAction Stop
    $rootIsReparse = (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    if ($rootIsReparse) {
        throw "Drive $Drive has a reparse-point root and is not permitted."
    }

    $logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$Drive'")
    if ($logicalDisks.Count -ne 1) {
        throw "Drive $Drive was not found as exactly one logical disk."
    }
    $logicalDisk = $logicalDisks[0]
    $volumes = @(Get-CimInstance Win32_Volume -Filter "DriveLetter='$Drive'")
    if ($volumes.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$volumes[0].DeviceID)) {
        throw "Drive $Drive was not found as exactly one Windows volume."
    }

    [pscustomobject]@{
        Drive = $Drive
        DosDeviceTarget = $devicePath
        PsProviderName = [string]$psDrive.Provider.Name
        PsDisplayRoot = $psDrive.DisplayRoot
        RootIsReparse = $rootIsReparse
        LogicalDeviceId = [string]$logicalDisk.DeviceID
        DriveType = [int]$logicalDisk.DriveType
        FileSystem = [string]$logicalDisk.FileSystem
        FreeSpace = [uint64]$logicalDisk.FreeSpace
        VolumeSerialNumber = [string]$logicalDisk.VolumeSerialNumber
        VolumeDeviceId = [string]$volumes[0].DeviceID
    }
}

function Assert-HostPrepSnapshotSafe {
    param(
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string]$ExpectedDrive
    )
    Assert-HostPrepDosDeviceTarget -Drive $ExpectedDrive -Target ([string]$Snapshot.DosDeviceTarget)
    if (
        [string]$Snapshot.Drive -ne $ExpectedDrive -or
        [string]$Snapshot.LogicalDeviceId -ne $ExpectedDrive -or
        [string]$Snapshot.PsProviderName -ne 'FileSystem' -or
        $Snapshot.PsDisplayRoot -or
        [bool]$Snapshot.RootIsReparse
    ) {
        throw "Drive $ExpectedDrive is not a literal local filesystem root."
    }
    if ([int]$Snapshot.DriveType -ne 2) {
        throw "Drive $ExpectedDrive is not reported by Windows as removable media."
    }
    if ([string]$Snapshot.FileSystem -ne 'FAT32') {
        throw "Drive $ExpectedDrive must be FAT32 for this approved handoff."
    }
    if ([uint64]$Snapshot.FreeSpace -lt [uint64]104857600) {
        throw "Drive $ExpectedDrive has less than 100 MiB free."
    }
    if (
        [string]::IsNullOrWhiteSpace([string]$Snapshot.VolumeSerialNumber) -or
        [string]::IsNullOrWhiteSpace([string]$Snapshot.VolumeDeviceId)
    ) {
        throw "Drive $ExpectedDrive does not have a stable volume identity."
    }
}

function Assert-HostPrepDeviceUnchanged {
    param(
        [Parameter(Mandatory = $true)]$Approved,
        [Parameter(Mandatory = $true)]$Current,
        [Parameter(Mandatory = $true)][string]$ExpectedDrive
    )
    Assert-HostPrepSnapshotSafe -Snapshot $Current -ExpectedDrive $ExpectedDrive
    foreach ($propertyName in @(
        'Drive',
        'DosDeviceTarget',
        'LogicalDeviceId',
        'VolumeSerialNumber',
        'VolumeDeviceId'
    )) {
        if (-not [string]::Equals(
            [string]$Approved.$propertyName,
            [string]$Current.$propertyName,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Drive $ExpectedDrive device or volume identity changed during host preparation."
        }
    }
}

function Invoke-HostPrepNode {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $lines = @(& $NodePath @Arguments)
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Lines = $lines
    }
}

function Invoke-HostPrepWorkflow {
    param(
        [Parameter(Mandatory = $true)][string]$UsbDrive,
        [scriptblock]$GetDeviceSnapshot = { param([string]$Drive) Get-HostPrepDeviceSnapshot -Drive $Drive },
        [scriptblock]$InvokeNode = { param([string]$NodePath, [string[]]$Arguments) Invoke-HostPrepNode -NodePath $NodePath -Arguments $Arguments }
    )

    if ($UsbDrive -notmatch '^[A-Za-z]:$') {
        throw 'UsbDrive must be one drive letter followed by a colon.'
    }
    $driveName = $UsbDrive.Substring(0, 1).ToUpperInvariant()
    $usbRoot = "$driveName`:\"
    $approvedDevice = & $GetDeviceSnapshot $UsbDrive
    Assert-HostPrepSnapshotSafe -Snapshot $approvedDevice -ExpectedDrive $UsbDrive

    $nodeCandidates = @(Get-Command node.exe -CommandType Application -All -ErrorAction Stop)
    $node = $nodeCandidates[0]
    $nodeVersionResult = & $InvokeNode $node.Source @('--version')
    if ($nodeVersionResult.ExitCode -ne 0 -or $nodeVersionResult.Lines.Count -ne 1) {
        throw 'Could not determine the Node.js version.'
    }
    $nodeVersion = ([string]$nodeVersionResult.Lines[0]).Trim()
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

    $currentDevice = & $GetDeviceSnapshot $UsbDrive
    Assert-HostPrepDeviceUnchanged -Approved $approvedDevice -Current $currentDevice -ExpectedDrive $UsbDrive

    $builder = Join-Path $PSScriptRoot 'build-usb-host-prep.mjs'
    $builderResultRaw = & $InvokeNode $node.Source @($builder, '--usb-root', $usbRoot)
    if ($builderResultRaw.ExitCode -ne 0) {
        throw 'Phase 2 host-prep bundle creation failed.'
    }
    $builderOutput = @($builderResultRaw.Lines)
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

    $currentDevice = & $GetDeviceSnapshot $UsbDrive
    Assert-HostPrepDeviceUnchanged -Approved $approvedDevice -Current $currentDevice -ExpectedDrive $UsbDrive
    $phase2Verifier = Join-Path $PSScriptRoot 'verify-usb-host-prep.mjs'
    $phase2Verification = & $InvokeNode $node.Source @($phase2Verifier, '--handoff-root', $phase2Root, '--mode', 'outbound')
    if ($phase2Verification.ExitCode -ne 0) {
        throw 'Independent Phase 2 outbound verification failed.'
    }

    $currentDevice = & $GetDeviceSnapshot $UsbDrive
    Assert-HostPrepDeviceUnchanged -Approved $approvedDevice -Current $currentDevice -ExpectedDrive $UsbDrive
    $phase1Verifier = Join-Path $PSScriptRoot 'verify-usb-handoff.mjs'
    $phase1Verification = & $InvokeNode $node.Source @($phase1Verifier, '--handoff-root', $phase1Root, '--mode', 'returned')
    if ($phase1Verification.ExitCode -ne 0) {
        throw 'Returned Phase 1 re-verification failed.'
    }

    $currentDevice = & $GetDeviceSnapshot $UsbDrive
    Assert-HostPrepDeviceUnchanged -Approved $approvedDevice -Current $currentDevice -ExpectedDrive $UsbDrive
    Write-Output $builderJson
    Write-Output "Retain this full Phase 2 manifest fingerprint out of band: $($builderResult.manifestFingerprint)"
}

Invoke-HostPrepWorkflow -UsbDrive $UsbDrive
