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
    [string[]]$Arguments,
    [string]$WslExecutable = 'wsl.exe'
  )

  $result = & $WslExecutable --distribution $Distribution --user root --exec @Arguments
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

function Resolve-ArtifactOutputRoot {
  param(
    [string]$RequestedOutputRoot,
    [string]$RepositoryRoot
  )

  if ($RequestedOutputRoot -notmatch '^[A-Za-z]:[\\/]') {
    throw "OutputRoot must be an absolute strict descendant of repository artifacts: $RequestedOutputRoot"
  }
  $artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot 'artifacts'))
  $outputRoot = [System.IO.Path]::GetFullPath($RequestedOutputRoot)
  $artifactPrefix = "$($artifactRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))$([System.IO.Path]::DirectorySeparatorChar)"
  if (-not $outputRoot.StartsWith($artifactPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must be a strict descendant of repository artifacts: $outputRoot"
  }
  Assert-ExistingOutputParentsAreNotReparsePoints $outputRoot
  return $outputRoot
}

function New-LocalApplianceBuildId {
  param([string]$ReleaseSha)
  $utcTimestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  return "$utcTimestamp-$($ReleaseSha.Substring(0, 12))"
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
    [scriptblock]$InvokeWslRoot,
    [string]$WslExecutable
  )

  $nativeWslInput = $WindowsPath.Replace('\', '/')
  $wslPath = ([string](& $InvokeWslRoot -Distribution $Distribution -Arguments @('wslpath', '-a', $nativeWslInput) -WslExecutable $WslExecutable)).Trim()
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
    [string]$WslExecutable = 'wsl.exe',
    [scriptblock]$GetBuildId = ${function:New-LocalApplianceBuildId},
    [scriptblock]$ExportRelease = ${function:Export-ReleaseTar}
  )

  $OutputRoot = Resolve-ArtifactOutputRoot $OutputRoot $RepositoryRoot
  $releaseSha = ([string](& $ResolveReleaseSha $RepositoryRoot $ReleaseRef)).Trim()
  if ($releaseSha -notmatch '^[a-f0-9]{40}$') {
    throw "ReleaseRef did not resolve to one commit: $ReleaseRef"
  }
  $freeBytes = [uint64](& $GetFreeBytes $OutputRoot)
  if ($freeBytes -lt 20GB) { throw 'At least 20 GiB of free output space is required.' }

  & $InvokeWslRoot -Distribution $WslDistribution -Arguments @('test', '-c', '/dev/kvm') -WslExecutable $WslExecutable | Out-Null
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
  $buildPrivateKeyWsl = ConvertTo-WslAbsolutePath $buildPrivateKey $WslDistribution $InvokeWslRoot $WslExecutable
  $sshKeygenCommand = 'eval $''exec ssh-keygen -q -t ed25519 -N \x22\x22 -f \x22\x241\x22'''
  & $InvokeWslRoot -Distribution $WslDistribution -Arguments @('bash', '-c', $sshKeygenCommand, 'build-key', $buildPrivateKeyWsl) -WslExecutable $WslExecutable | Out-Null
  if (-not (Test-Path -LiteralPath $buildPrivateKey -PathType Leaf) -or -not (Test-Path -LiteralPath $buildPublicKey -PathType Leaf)) {
    throw 'WSL did not create the ephemeral build SSH keypair.'
  }

  $controller = Join-Path $RepositoryRoot 'scripts\appliance\build-local-debian-appliance.sh'
  $controllerWsl = ConvertTo-WslAbsolutePath $controller $WslDistribution $InvokeWslRoot $WslExecutable
  $repositoryWsl = ConvertTo-WslAbsolutePath $RepositoryRoot $WslDistribution $InvokeWslRoot $WslExecutable
  $buildRootWsl = ConvertTo-WslAbsolutePath $buildRoot $WslDistribution $InvokeWslRoot $WslExecutable
  $releaseTarWsl = ConvertTo-WslAbsolutePath $releaseTar $WslDistribution $InvokeWslRoot $WslExecutable
  $buildPublicKeyWsl = ConvertTo-WslAbsolutePath $buildPublicKey $WslDistribution $InvokeWslRoot $WslExecutable
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
  $controllerLines = @(& $InvokeWslRoot -Distribution $WslDistribution -Arguments $controllerArguments -WslExecutable $WslExecutable)
  if ($BootOnly) {
    $controllerOutput = ($controllerLines -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($controllerOutput) -or $controllerOutput.Length -gt 512) {
      throw 'Boot-only controller result was missing or exceeded its bounded contract.'
    }
    try {
      $controllerResult = $controllerOutput | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw 'Boot-only controller result was not valid JSON.'
    }
    $expectedProperties = @('buildId', 'classification', 'ok', 'releaseSha', 'sshPort')
    $actualProperties = @($controllerResult.PSObject.Properties.Name | Sort-Object)
    if (($actualProperties -join ',') -ne ($expectedProperties -join ',')) {
      throw 'Boot-only controller result did not match the bounded schema.'
    }
    $sshPortIsInteger = ($controllerResult.sshPort -is [int]) -or ($controllerResult.sshPort -is [long])
    if ($controllerResult.ok -isnot [bool] -or
        $controllerResult.classification -isnot [string] -or
        $controllerResult.buildId -isnot [string] -or
        $controllerResult.releaseSha -isnot [string] -or
        -not $sshPortIsInteger) {
      throw 'Boot-only controller result did not match the bounded schema.'
    }
    if ($controllerResult.ok -ne $true -or
        $controllerResult.classification -ne 'boot-only' -or
        $controllerResult.buildId -ne $buildId -or
        $controllerResult.releaseSha -ne $releaseSha -or
        $controllerResult.sshPort -lt 22000 -or
        $controllerResult.sshPort -gt 42000) {
      throw 'Boot-only controller result did not match this build.'
    }
    $controllerResult | ConvertTo-Json -Compress
  }
}

Invoke-LocalDebianAppliance -WslDistribution $WslDistribution -ReleaseRef $ReleaseRef -OutputRoot $OutputRoot -PreflightOnly:$PreflightOnly -BootOnly:$BootOnly -RepositoryRoot $repositoryRoot
