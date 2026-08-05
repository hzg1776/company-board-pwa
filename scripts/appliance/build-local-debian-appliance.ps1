[CmdletBinding()]
param(
  [string]$WslDistribution = 'Ubuntu-24.04',
  [string]$ReleaseRef = 'HEAD',
  [string]$OutputRoot,
  [switch]$PreflightOnly,
  [switch]$BootOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $repositoryRoot 'artifacts\local-debian-appliance'
}

function Resolve-ReleaseSha {
  param(
    [string]$RepositoryRoot,
    [string]$RequestedReleaseRef
  )

  $releaseSha = (& git -C $RepositoryRoot rev-parse "$RequestedReleaseRef`^{commit}").Trim()
  if ($LASTEXITCODE -ne 0 -or $releaseSha -notmatch '^[a-f0-9]{40}$') {
    throw "ReleaseRef did not resolve to one commit: $RequestedReleaseRef"
  }
  return $releaseSha
}

function Get-OutputFreeBytes {
  param([string]$RequestedOutputRoot)

  $outputParent = [System.IO.Path]::GetFullPath($RequestedOutputRoot)
  $volumeRoot = [System.IO.Path]::GetPathRoot($outputParent)
  if ([string]::IsNullOrWhiteSpace($volumeRoot) -or $volumeRoot.Length -lt 2) {
    throw "OutputRoot must be on a Windows drive: $RequestedOutputRoot"
  }
  $drive = Get-PSDrive -Name $volumeRoot.Substring(0, 1) -ErrorAction Stop
  return [uint64]$drive.Free
}

function Invoke-WslRoot {
  param(
    [string]$Distribution,
    [string[]]$Arguments
  )

  $result = & wsl.exe --distribution $Distribution --user root -- @Arguments
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($Arguments -join ' ')" }
  return $result
}

function Assert-ExistingOutputParentsAreNotReparsePoints {
  param([string]$RequestedOutputRoot)

  $current = [System.IO.Path]::GetFullPath($RequestedOutputRoot)
  while (-not [string]::IsNullOrWhiteSpace($current)) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -Force -LiteralPath $current -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "OutputRoot parent must not be a reparse point: $current"
      }
    }
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent -or $parent.FullName -eq $current) { break }
    $current = $parent.FullName
  }
}

function New-LocalApplianceBuildId {
  param([string]$ReleaseSha)
  return "$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')-$($ReleaseSha.Substring(0, 12))"
}

function Export-ReleaseTar {
  param(
    [string]$RepositoryRoot,
    [string]$ReleaseSha,
    [string]$ReleaseTar
  )

  & git -C $RepositoryRoot archive --format=tar --output=$ReleaseTar $ReleaseSha
  if ($LASTEXITCODE -ne 0) { throw 'Git release export failed.' }
}

function ConvertTo-WslAbsolutePath {
  param(
    [string]$WindowsPath,
    [string]$Distribution,
    [scriptblock]$InvokeWslRoot
  )

  $wslPath = ([string](& $InvokeWslRoot $Distribution @('wslpath', '-a', $WindowsPath))).Trim()
  if ([string]::IsNullOrWhiteSpace($wslPath) -or -not $wslPath.StartsWith('/')) {
    throw "WSL did not return an absolute path for: $WindowsPath"
  }
  return $wslPath
}

function Invoke-LocalDebianAppliance {
  param(
    [string]$WslDistribution,
    [string]$ReleaseRef,
    [string]$OutputRoot,
    [switch]$PreflightOnly,
    [switch]$BootOnly,
    [Parameter(Mandatory)]
    [string]$RepositoryRoot,
    [scriptblock]$ResolveReleaseSha = ${function:Resolve-ReleaseSha},
    [scriptblock]$GetFreeBytes = ${function:Get-OutputFreeBytes},
    [scriptblock]$InvokeWslRoot = ${function:Invoke-WslRoot},
    [scriptblock]$GetBuildId = ${function:New-LocalApplianceBuildId},
    [scriptblock]$ExportRelease = ${function:Export-ReleaseTar}
  )

  $releaseSha = ([string](& $ResolveReleaseSha $RepositoryRoot $ReleaseRef)).Trim()
  if ($releaseSha -notmatch '^[a-f0-9]{40}$') {
    throw "ReleaseRef did not resolve to one commit: $ReleaseRef"
  }
  $freeBytes = [uint64](& $GetFreeBytes $OutputRoot)
  if ($freeBytes -lt 20GB) { throw 'At least 20 GiB of free output space is required.' }

  & $InvokeWslRoot $WslDistribution @('test', '-c', '/dev/kvm') | Out-Null
  if ($PreflightOnly) {
    [ordered]@{
      ok = $true
      distribution = $WslDistribution
      kvm = 'available'
      freeBytes = $freeBytes
      releaseSha = $releaseSha
    } | ConvertTo-Json -Compress
    return
  }

  Assert-ExistingOutputParentsAreNotReparsePoints $OutputRoot
  $buildId = ([string](& $GetBuildId $releaseSha)).Trim()
  if ($buildId -notmatch '^\d{8}T\d{6}Z-[a-f0-9]{12}$') { throw "Generated build ID was invalid: $buildId" }
  $outputParent = [System.IO.Path]::GetFullPath($OutputRoot)
  $buildRoot = Join-Path $outputParent $buildId
  if (Test-Path -LiteralPath $buildRoot) { throw "Build directory already exists: $buildRoot" }
  New-Item -ItemType Directory -Path $buildRoot -ErrorAction Stop | Out-Null

  $releaseTar = Join-Path $buildRoot 'project-a-release.tar'
  & $ExportRelease $RepositoryRoot $releaseSha $releaseTar

  $buildPrivateKey = Join-Path $buildRoot 'build_ssh_ed25519'
  $buildPublicKey = "$buildPrivateKey.pub"
  $buildPrivateKeyWsl = ConvertTo-WslAbsolutePath $buildPrivateKey $WslDistribution $InvokeWslRoot
  & $InvokeWslRoot $WslDistribution @('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', $buildPrivateKeyWsl) | Out-Null
  if (-not (Test-Path -LiteralPath $buildPrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $buildPublicKey -PathType Leaf)) {
    throw 'WSL did not create the ephemeral build SSH keypair.'
  }

  $controller = Join-Path $RepositoryRoot 'scripts\appliance\build-local-debian-appliance.sh'
  $controllerWsl = ConvertTo-WslAbsolutePath $controller $WslDistribution $InvokeWslRoot
  $repositoryWsl = ConvertTo-WslAbsolutePath $RepositoryRoot $WslDistribution $InvokeWslRoot
  $buildRootWsl = ConvertTo-WslAbsolutePath $buildRoot $WslDistribution $InvokeWslRoot
  $releaseTarWsl = ConvertTo-WslAbsolutePath $releaseTar $WslDistribution $InvokeWslRoot
  $buildPublicKeyWsl = ConvertTo-WslAbsolutePath $buildPublicKey $WslDistribution $InvokeWslRoot
  $controllerArguments = @(
    'bash', $controllerWsl,
    '--repository', $repositoryWsl,
    '--build-root', $buildRootWsl,
    '--release-tar', $releaseTarWsl,
    '--release-sha', $releaseSha,
    '--build-id', $buildId,
    '--build-public-key', $buildPublicKeyWsl
  )
  if ($BootOnly) { $controllerArguments += '--boot-only' }
  & $InvokeWslRoot $WslDistribution $controllerArguments | Out-Null
}

Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot
