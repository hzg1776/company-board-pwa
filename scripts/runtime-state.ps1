Set-StrictMode -Version Latest

function Resolve-BoardPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)

  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  return [System.IO.Path]::GetFullPath($expanded)
}

function Test-BoardPathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$ParentPath,
    [Parameter(Mandatory = $true)][string]$ChildPath
  )

  $resolvedParent = Resolve-BoardPath -PathValue $ParentPath
  $resolvedChild = Resolve-BoardPath -PathValue $ChildPath
  $relative = [System.IO.Path]::GetRelativePath($resolvedParent, $resolvedChild)
  return $relative -eq "." -or (-not $relative.StartsWith("..")) -and (-not [System.IO.Path]::IsPathRooted($relative))
}

function Get-DefaultBoardRuntimeRoot {
  if (-not $env:ProgramData) {
    throw "ProgramData is not available on this machine."
  }

  return Join-Path $env:ProgramData "Palziv\\runtime"
}

function Get-BoardRuntimeLayout {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$RuntimeRoot = ""
  )

  $resolvedProjectRoot = Resolve-BoardPath -PathValue $ProjectRoot
  $resolvedRuntimeRoot = if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    ""
  } else {
    Resolve-BoardPath -PathValue $RuntimeRoot
  }

  if (-not $resolvedRuntimeRoot) {
    return [pscustomobject]@{
      ProjectRoot     = $resolvedProjectRoot
      RuntimeRoot     = ""
      DataDirectory   = Join-Path $resolvedProjectRoot "data"
      LogDirectory    = Join-Path $resolvedProjectRoot "logs"
      BackupDirectory = Join-Path $resolvedProjectRoot "backups"
      IsExternal      = $false
    }
  }

  return [pscustomobject]@{
    ProjectRoot     = $resolvedProjectRoot
    RuntimeRoot     = $resolvedRuntimeRoot
    DataDirectory   = Join-Path $resolvedRuntimeRoot "data"
    LogDirectory    = Join-Path $resolvedRuntimeRoot "logs"
    BackupDirectory = Join-Path $resolvedRuntimeRoot "backups"
    IsExternal      = $true
  }
}

function Initialize-BoardRuntimeLayout {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$RuntimeRoot = ""
  )

  $layout = Get-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot

  foreach ($pathValue in @($layout.DataDirectory, $layout.LogDirectory, $layout.BackupDirectory)) {
    if (-not (Test-Path -LiteralPath $pathValue)) {
      New-Item -ItemType Directory -Force -Path $pathValue | Out-Null
    }
  }

  return $layout
}

function Sync-BoardRuntimeData {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$TargetDirectory,
    [switch]$OverwriteExisting
  )

  if (-not (Test-Path -LiteralPath $SourceDirectory)) {
    return
  }

  if (-not (Test-Path -LiteralPath $TargetDirectory)) {
    New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
  }

  $fileNames = @("board.json", "push.json", "analytics.json", "security.json")

  foreach ($fileName in $fileNames) {
    $sourcePath = Join-Path $SourceDirectory $fileName
    $targetPath = Join-Path $TargetDirectory $fileName

    if (-not (Test-Path -LiteralPath $sourcePath)) {
      continue
    }

    if ((-not $OverwriteExisting) -and (Test-Path -LiteralPath $targetPath)) {
      continue
    }

    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  }
}

function Protect-BoardRuntimeLayoutAcl {
  param(
    [Parameter(Mandatory = $true)]$Layout,
    [Parameter(Mandatory = $true)][string[]]$AllowedAccounts
  )

  $normalizedAccounts = @($AllowedAccounts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)

  if (-not $normalizedAccounts.Count) {
    throw "At least one runtime ACL account is required."
  }

  $ownerAccount = if ($normalizedAccounts -contains "BUILTIN\Administrators") {
    "BUILTIN\Administrators"
  } else {
    $normalizedAccounts[0]
  }
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $currentPrincipal = [System.Security.Principal.WindowsPrincipal]::new($currentIdentity)
  $canApplyRecursiveOwnership = $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

  foreach ($pathValue in @($Layout.RuntimeRoot, $Layout.DataDirectory, $Layout.LogDirectory, $Layout.BackupDirectory)) {
    if ([string]::IsNullOrWhiteSpace($pathValue)) {
      continue
    }

    if (-not (Test-Path -LiteralPath $pathValue)) {
      New-Item -ItemType Directory -Force -Path $pathValue | Out-Null
    }

    $targets = if ($canApplyRecursiveOwnership) {
      @($pathValue) + @(Get-ChildItem -LiteralPath $pathValue -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    } else {
      @($pathValue)
    }

    foreach ($targetPath in $targets) {
      $item = Get-Item -LiteralPath $targetPath -Force
      $acl = Get-Acl -LiteralPath $targetPath
      $acl.SetAccessRuleProtection($true, $false)
      if ($canApplyRecursiveOwnership -and $acl.Owner -ne $ownerAccount) {
        try {
          $acl.SetOwner([System.Security.Principal.NTAccount]::new($ownerAccount))
        } catch {
          if ($normalizedAccounts -notcontains $acl.Owner) {
            throw
          }
        }
      }

      foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
      }

      $inheritanceFlags = if ($item.PSIsContainer) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      } else {
        [System.Security.AccessControl.InheritanceFlags]::None
      }

      foreach ($account in $normalizedAccounts) {
        $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
          $account,
          [System.Security.AccessControl.FileSystemRights]::FullControl,
          $inheritanceFlags,
          [System.Security.AccessControl.PropagationFlags]::None,
          [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($accessRule)
      }

      Set-Acl -LiteralPath $targetPath -AclObject $acl
    }
  }
}
