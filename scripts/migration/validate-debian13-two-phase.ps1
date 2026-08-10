[CmdletBinding()]
param(
  [string]$WslDistribution = 'Ubuntu-24.04',
  [switch]$ReuseExistingRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$validationRoot = '/var/tmp/project-a-debian13-validation'
$repositoryWsl = '/mnt/c/Users/admin/Documents/Codex/Project-A/.worktrees/proxmox-migration'

function Invoke-Wsl {
  param([string[]]$CommandArguments)
  $output = & wsl.exe --distribution $WslDistribution --user root -- @CommandArguments
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($CommandArguments -join ' ')" }
  return $output
}

if (-not $ReuseExistingRoot) {
  Invoke-Wsl @('rm', '-rf', '--', $validationRoot) | Out-Null
  Invoke-Wsl @('debootstrap', '--variant=minbase', '--include=adduser,coreutils,util-linux,iproute2,curl,jq,age', 'trixie', $validationRoot, 'https://deb.debian.org/debian') | Out-Null
}
Invoke-Wsl @('test', '-d', $validationRoot) | Out-Null
Invoke-Wsl @('install', '-d', '-m', '0755', "$validationRoot/tmp/project-a-validation") | Out-Null
Invoke-Wsl @('cp', "$repositoryWsl/scripts/migration/1-STAGE-DEBIAN.sh", "$validationRoot/tmp/project-a-validation/1-STAGE-DEBIAN.sh") | Out-Null
Invoke-Wsl @('cp', "$repositoryWsl/scripts/migration/2-CUTOVER-DEBIAN.sh", "$validationRoot/tmp/project-a-validation/2-CUTOVER-DEBIAN.sh") | Out-Null

$osRelease = Invoke-Wsl @('chroot', $validationRoot, '/bin/cat', '/etc/os-release')
$os = (($osRelease | Where-Object { $_ -match '^ID=' }) -replace '^ID=', '' -replace '"', '').Trim()
$version = (($osRelease | Where-Object { $_ -match '^VERSION_ID=' }) -replace '^VERSION_ID=', '' -replace '"', '').Trim()
if ($os -ne 'debian' -or $version -ne '13') { throw "Expected Debian 13, found $os $version" }

$osReleaseType = (Invoke-Wsl @('stat', '-c', '%F', "$validationRoot/etc/os-release")).Trim()
$addgroupType = (Invoke-Wsl @('stat', '-c', '%F', "$validationRoot/usr/sbin/addgroup")).Trim()
$groupaddType = (Invoke-Wsl @('stat', '-c', '%F', "$validationRoot/usr/sbin/groupadd")).Trim()
if ($osReleaseType -ne 'symbolic link' -or $addgroupType -ne 'symbolic link' -or $groupaddType -ne 'regular file') {
  throw 'Debian 13 package layout did not match the required compatibility contract.'
}

Invoke-Wsl @('chroot', $validationRoot, '/bin/bash', '-n', '/tmp/project-a-validation/1-STAGE-DEBIAN.sh') | Out-Null
Invoke-Wsl @('chroot', $validationRoot, '/bin/bash', '-n', '/tmp/project-a-validation/2-CUTOVER-DEBIAN.sh') | Out-Null
Invoke-Wsl @('chroot', $validationRoot, '/usr/sbin/groupadd', '--system', 'projectavalidation') | Out-Null
Invoke-Wsl @('chroot', $validationRoot, '/usr/sbin/useradd', '--system', '--gid', 'projectavalidation', '--home-dir', '/nonexistent', '--no-create-home', '--shell', '/usr/sbin/nologin', 'projectavalidation') | Out-Null
Invoke-Wsl @('chroot', $validationRoot, '/usr/bin/id', 'projectavalidation') | Out-Null
Invoke-Wsl @('chroot', $validationRoot, '/usr/bin/age-keygen', '-o', '/tmp/project-a-validation/identity.txt') | Out-Null
$recipient = (Invoke-Wsl @('chroot', $validationRoot, '/usr/bin/age-keygen', '-y', '/tmp/project-a-validation/identity.txt')).Trim()
if ($recipient -notmatch '^age1[ac-hj-np-z02-9]{58}$') { throw 'Debian 13 age-keygen output was invalid.' }

$summary = [ordered]@{
  os = $os
  version = $version
  osReleaseType = $osReleaseType
  addgroupType = $addgroupType
  groupaddType = $groupaddType
  stageContract = 'pass'
  cutoverContract = 'pass'
  ageRecipient = 'pass'
}
$summary | ConvertTo-Json -Compress
