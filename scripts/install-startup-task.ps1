[CmdletBinding()]
param(
  [string]$TaskName = "CompanyBoardPWA Startup",
  [string]$ProjectRoot,
  [int]$Port = 3116,
  [string]$CloudflaredServiceName = "Cloudflared",
  [string]$CloudflaredConfigPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ProjectRoot) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  $ProjectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

$startupScript = Join-Path $ProjectRoot "scripts\windows-startup.ps1"
if (-not (Test-Path $startupScript)) {
  throw "Startup script not found: $startupScript"
}

if (-not $CloudflaredConfigPath) {
  $CloudflaredConfigPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-BoardTaskAction {
  param(
    [string]$ScriptPath,
    [string]$Root,
    [int]$Port,
    [string]$PublicBaseUrl,
    [string]$ConfigPath
  )

  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -Port $Port -ProjectRoot `"$Root`" -PublicBaseUrl `"$PublicBaseUrl`" -CloudflaredConfigPath `"$ConfigPath`""
  return New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
}

function Get-CloudflaredPublicBaseUrl {
  param([string]$ConfigPath)

  if (-not (Test-Path $ConfigPath)) {
    throw "Cloudflared config not found: $ConfigPath"
  }

  $configText = Get-Content -LiteralPath $ConfigPath -Raw
  $matches = [regex]::Matches($configText, '(?m)^\s*hostname:\s*(.+)$')
  if (-not $matches.Count) {
    throw "Cloudflared config is missing hostname entries: $ConfigPath"
  }

  $hostnames = @(
    foreach ($match in $matches) {
      $host = $match.Groups[1].Value.Trim()
      if ($host) {
        $host
      }
    }
  ) | Select-Object -Unique

  if (-not $hostnames.Count) {
    throw "Cloudflared config did not contain any usable hostnames: $ConfigPath"
  }

  $preferredHost = $hostnames | Where-Object { $_ -notmatch '^www\.' } | Select-Object -First 1
  if (-not $preferredHost) {
    $preferredHost = $hostnames | Select-Object -First 1
  }

  return "https://$preferredHost"
}

function Configure-CloudflaredServiceRecovery {
  param([string]$ServiceName)

  $failureActions = "restart/5000/restart/5000/restart/5000"
  & sc.exe failure $ServiceName reset= 86400 actions= $failureActions | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not configure failure recovery for service '$ServiceName'."
  }

  & sc.exe failureflag $ServiceName 1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not enable failure recovery for service '$ServiceName'."
  }
}

$startupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$publicBaseUrl = Get-CloudflaredPublicBaseUrl -ConfigPath $CloudflaredConfigPath

if (Test-IsAdministrator) {
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $modeLabel = "startup as SYSTEM"
  $taskConfigPath = Join-Path $env:WINDIR "System32\config\systemprofile\.cloudflared\config.yml"
} else {
  $startupTrigger = New-ScheduledTaskTrigger -AtLogOn
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $modeLabel = "logon as $currentUser"
  $taskConfigPath = $CloudflaredConfigPath
}

$startupAction = New-BoardTaskAction -ScriptPath $startupScript -Root $ProjectRoot -Port $Port -PublicBaseUrl $publicBaseUrl -ConfigPath $taskConfigPath

Register-ScheduledTask -TaskName $TaskName -Action $startupAction -Trigger $startupTrigger -Principal $principal -Settings $startupSettings -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Registered scheduled task: $($task.TaskName)"
Write-Host "Mode: $modeLabel"
Write-Host "Launches: $startupScript"
Write-Host "Public origin: $publicBaseUrl"

if (Test-IsAdministrator) {
  $recoveryTaskName = "$TaskName Recovery"
  $recoveryAction = New-BoardTaskAction -ScriptPath $startupScript -Root $ProjectRoot -Port $Port -PublicBaseUrl $publicBaseUrl -ConfigPath $taskConfigPath
  $recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)

  Register-ScheduledTask -TaskName $recoveryTaskName -Action $recoveryAction -Trigger $recoveryTrigger -Principal $principal -Settings $startupSettings -Force | Out-Null

  $recoveryTask = Get-ScheduledTask -TaskName $recoveryTaskName
  Write-Host "Registered scheduled task: $($recoveryTask.TaskName)"
  Write-Host "Mode: self-heal every 5 minutes"
} else {
  Write-Warning "Run this script as Administrator to install the recurring recovery task that self-heals after reboot."
}

function Resolve-CloudflaredExecutable {
  try {
    $cloudflared = Get-Command cloudflared -ErrorAction Stop
    if ($cloudflared.Source) {
      return $cloudflared.Source
    }
  } catch {
    # Fall through to common install locations.
  }

  $candidates = @(
    "C:\Program Files\cloudflared\cloudflared.exe",
    "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "cloudflared was not found. Install Cloudflare Tunnel before registering its service."
}

function Sync-CloudflaredServiceConfig {
  param(
    [string]$SourcePath,
    [string]$TargetDirectory,
    [int]$TargetPort
  )

  if (-not (Test-Path $SourcePath)) {
    throw "Cloudflared config not found: $SourcePath"
  }

  $sourceContent = Get-Content -LiteralPath $SourcePath -Raw
  $credentialsMatch = [regex]::Match($sourceContent, '(?m)^\s*credentials-file:\s*(.+)$')

  if (-not $credentialsMatch.Success) {
    throw "Cloudflared config is missing a credentials-file entry: $SourcePath"
  }

  $sourceCredentialsPath = [Environment]::ExpandEnvironmentVariables($credentialsMatch.Groups[1].Value.Trim())

  if (-not (Test-Path $sourceCredentialsPath)) {
    throw "Cloudflared credentials file not found: $sourceCredentialsPath"
  }

  if (-not (Test-Path $TargetDirectory)) {
    New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
  }

  $targetCredentialsPath = Join-Path $TargetDirectory (Split-Path -Leaf $sourceCredentialsPath)
  Copy-Item -LiteralPath $sourceCredentialsPath -Destination $targetCredentialsPath -Force

  $targetContent = $sourceContent
  $targetContent = [regex]::Replace($targetContent, '(?m)^\s*credentials-file:\s*.+$', "credentials-file: $targetCredentialsPath")
  $targetContent = [regex]::Replace($targetContent, '(?m)(^\s*service:\s*http://localhost:)\d+', { param($match) $match.Groups[1].Value + $TargetPort })

  $targetConfigPath = Join-Path $TargetDirectory "config.yml"
  [System.IO.File]::WriteAllText($targetConfigPath, $targetContent, [System.Text.UTF8Encoding]::new($false))

  $sourceCertPath = Join-Path (Split-Path -Parent $SourcePath) "cert.pem"
  if (Test-Path $sourceCertPath) {
    Copy-Item -LiteralPath $sourceCertPath -Destination (Join-Path $TargetDirectory "cert.pem") -Force
  }

  Write-Host "Synced Cloudflared config to $targetConfigPath"
  Write-Host "Cloudflared origin now targets localhost:$TargetPort"
}

function Ensure-CloudflaredService {
  param(
    [string]$ServiceName,
    [string]$ConfigPath,
    [int]$TargetPort
  )

  $cloudflaredExe = Resolve-CloudflaredExecutable
  $systemProfileConfig = Join-Path $env:WINDIR "System32\config\systemprofile\.cloudflared"
  Sync-CloudflaredServiceConfig -SourcePath $ConfigPath -TargetDirectory $systemProfileConfig -TargetPort $TargetPort

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

  if (-not $service) {
    Write-Host "Installing Cloudflared as a Windows service..."
    & $cloudflaredExe service install | Out-Null
    Start-Sleep -Seconds 2
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
  }

  Set-Service -Name $ServiceName -StartupType Automatic
  Configure-CloudflaredServiceRecovery -ServiceName $ServiceName

  if ($service.Status -eq "Running") {
    Restart-Service -Name $ServiceName
  } else {
    Start-Service -Name $ServiceName
  }

  Start-Sleep -Seconds 2
  $service = Get-Service -Name $ServiceName

  Write-Host "cloudflared service status: $($service.Status)"
}

Write-Host ""
Write-Host "==> Start cloudflared tunnel" -ForegroundColor Cyan
Ensure-CloudflaredService -ServiceName $CloudflaredServiceName -ConfigPath $CloudflaredConfigPath -TargetPort $Port
