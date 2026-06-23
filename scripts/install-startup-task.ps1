[CmdletBinding()]
param(
  [string]$TaskName = "CompanyBoardPWA Startup",
  [string]$ProjectRoot,
  [int]$Port = 3116,
  [string]$RuntimeRoot = "",
  [string]$CloudflaredServiceName = "Cloudflared",
  [string]$CloudflaredConfigPath,
  [string]$TrustedProxyAddresses = "",
  [string]$AlertWebhookUrl = $env:OPS_ALERT_WEBHOOK_URL
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ProjectRoot) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  $ProjectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

. (Join-Path $PSScriptRoot "runtime-state.ps1")

$startupScript = Join-Path $ProjectRoot "scripts\windows-startup.ps1"
if (-not (Test-Path $startupScript)) {
  throw "Startup script not found: $startupScript"
}

$watchdogScript = Join-Path $ProjectRoot "scripts\tunnel-watchdog.ps1"
if (-not (Test-Path $watchdogScript)) {
  throw "Watchdog script not found: $watchdogScript"
}

if (-not $CloudflaredConfigPath) {
  $CloudflaredConfigPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$isAdmin = Test-IsAdministrator

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = if ($isAdmin) { Get-DefaultBoardRuntimeRoot } else { "" }
}

function New-BoardTaskAction {
  param(
    [string]$ScriptPath,
    [string]$Root,
    [int]$Port,
    [string]$RuntimeRoot,
    [string]$PublicBaseUrl,
    [string]$TrustedProxyAddresses,
    [string]$ConfigPath
  )

  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -Port $Port -ProjectRoot `"$Root`" -RuntimeRoot `"$RuntimeRoot`" -PublicBaseUrl `"$PublicBaseUrl`" -CloudflaredConfigPath `"$ConfigPath`""
  if ($TrustedProxyAddresses) {
    $arguments += " -TrustedProxyAddresses `"$TrustedProxyAddresses`""
  }
  return New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
}

function New-WatchdogTaskAction {
  param(
    [string]$ScriptPath,
    [string]$Root,
    [string]$RuntimeRoot,
    [string]$PublicBaseUrl,
    [string]$TrustedProxyAddresses,
    [int]$Port,
    [string]$ServiceName,
    [string]$ConfigPath,
    [string]$WebhookUrl
  )

  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -ProjectRoot `"$Root`" -RuntimeRoot `"$RuntimeRoot`" -PublicBaseUrl `"$PublicBaseUrl`" -LocalPort $Port -CloudflaredServiceName `"$ServiceName`""
  if ($ConfigPath) {
    $arguments += " -CloudflaredConfigPath `"$ConfigPath`""
  }
  if ($TrustedProxyAddresses) {
    $arguments += " -TrustedProxyAddresses `"$TrustedProxyAddresses`""
  }
  if ($WebhookUrl) {
    $arguments += " -AlertWebhookUrl `"$WebhookUrl`""
  }

  return New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
}

function Get-CloudflaredPublicBaseUrl {
  param([string]$ConfigPath)

  if (-not (Test-Path $ConfigPath)) {
    throw "Cloudflared config not found: $ConfigPath"
  }

  $configText = Get-Content -LiteralPath $ConfigPath -Raw
  $matches = [regex]::Matches($configText, '(?m)^\s*-\s*hostname:\s*(.+)$')
  if (-not $matches.Count) {
    throw "Cloudflared config is missing hostname entries: $ConfigPath"
  }

  $hostnames = @(
    foreach ($match in $matches) {
      $entryHost = $match.Groups[1].Value.Trim()
      if ($entryHost) {
        $entryHost
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

function Get-CloudflaredTunnelId {
  param([string]$ConfigPath)

  if (-not (Test-Path $ConfigPath)) {
    return $null
  }

  $configText = Get-Content -LiteralPath $ConfigPath -Raw
  $match = [regex]::Match($configText, '(?m)^\s*tunnel:\s*(.+)$')

  if (-not $match.Success) {
    return $null
  }

  return $match.Groups[1].Value.Trim()
}

function Get-TrustedCloudflaredProcesses {
  param([string]$ConfigPath)

  $tunnelId = Get-CloudflaredTunnelId -ConfigPath $ConfigPath
  if (-not $tunnelId) {
    return @()
  }

  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'tunnel\s+run' -and
        $_.CommandLine -match [regex]::Escape($tunnelId)
      }
  )
}

function Stop-TrustedCloudflaredProcesses {
  param([string]$ConfigPath)

  foreach ($process in (Get-TrustedCloudflaredProcesses -ConfigPath $ConfigPath)) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "Stopped direct cloudflared process $($process.ProcessId) before promoting the service."
    } catch {
      Write-Warning "Could not stop direct cloudflared process $($process.ProcessId). $($_.Exception.Message)"
    }
  }
}

function Set-CloudflaredServiceImagePath {
  param(
    [string]$ServiceName,
    [string]$ExecutablePath,
    [string]$ConfigPath
  )

  $serviceRegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
  if (-not (Test-Path $serviceRegistryPath)) {
    throw "Cloudflared service registry path was not found: $serviceRegistryPath"
  }

  $imagePath = "`"$ExecutablePath`" --config=$ConfigPath tunnel run"
  Set-ItemProperty -Path $serviceRegistryPath -Name ImagePath -Value $imagePath
  Write-Host "Updated Cloudflared service ImagePath to use $ConfigPath"
}

$startupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$publicBaseUrl = Get-CloudflaredPublicBaseUrl -ConfigPath $CloudflaredConfigPath
$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot
$resolvedTrustedProxyAddresses = if ([string]::IsNullOrWhiteSpace($TrustedProxyAddresses) -and $publicBaseUrl) {
  "loopback"
} else {
  $TrustedProxyAddresses.Trim()
}

if ((-not $isAdmin) -and $runtimeLayout.IsExternal -and $env:ProgramData -and (Test-BoardPathWithin -ParentPath $env:ProgramData -ChildPath $runtimeLayout.RuntimeRoot)) {
  throw "External runtime roots under ProgramData require Administrator privileges. Re-run this installer elevated or use a user-scoped runtime root."
}

Sync-BoardRuntimeData -SourceDirectory (Join-Path $ProjectRoot "data") -TargetDirectory $runtimeLayout.DataDirectory

if ($isAdmin) {
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $modeLabel = "startup as SYSTEM"
  $taskConfigPath = Join-Path $env:WINDIR "System32\config\systemprofile\.cloudflared\config.yml"
  Protect-BoardRuntimeLayoutAcl -Layout $runtimeLayout -AllowedAccounts @("SYSTEM", "BUILTIN\\Administrators", [Security.Principal.WindowsIdentity]::GetCurrent().Name)
} else {
  $startupTrigger = New-ScheduledTaskTrigger -AtLogOn
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $modeLabel = "logon as $currentUser"
  $taskConfigPath = $CloudflaredConfigPath
  Write-Warning "Runtime ACL hardening was skipped because this installer is not running as Administrator."
}

$startupAction = New-BoardTaskAction -ScriptPath $startupScript -Root $ProjectRoot -Port $Port -RuntimeRoot $runtimeLayout.RuntimeRoot -PublicBaseUrl $publicBaseUrl -TrustedProxyAddresses $resolvedTrustedProxyAddresses -ConfigPath $taskConfigPath

Register-ScheduledTask -TaskName $TaskName -Action $startupAction -Trigger $startupTrigger -Principal $principal -Settings $startupSettings -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Registered scheduled task: $($task.TaskName)"
Write-Host "Mode: $modeLabel"
Write-Host "Launches: $startupScript"
Write-Host "Public origin: $publicBaseUrl"
Write-Host "Runtime root: $($runtimeLayout.RuntimeRoot)"
Write-Host "Runtime data: $($runtimeLayout.DataDirectory)"

if ($isAdmin) {
  $recoveryTaskName = "$TaskName Recovery"
  $recoveryAction = New-BoardTaskAction -ScriptPath $startupScript -Root $ProjectRoot -Port $Port -RuntimeRoot $runtimeLayout.RuntimeRoot -PublicBaseUrl $publicBaseUrl -TrustedProxyAddresses $resolvedTrustedProxyAddresses -ConfigPath $taskConfigPath
  $recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)

  Register-ScheduledTask -TaskName $recoveryTaskName -Action $recoveryAction -Trigger $recoveryTrigger -Principal $principal -Settings $startupSettings -Force | Out-Null

  $recoveryTask = Get-ScheduledTask -TaskName $recoveryTaskName
  Write-Host "Registered scheduled task: $($recoveryTask.TaskName)"
  Write-Host "Mode: self-heal every 5 minutes"

  $watchdogTaskName = "$TaskName Tunnel Watchdog"
  $watchdogAction = New-WatchdogTaskAction -ScriptPath $watchdogScript -Root $ProjectRoot -RuntimeRoot $runtimeLayout.RuntimeRoot -PublicBaseUrl $publicBaseUrl -TrustedProxyAddresses $resolvedTrustedProxyAddresses -Port $Port -ServiceName $CloudflaredServiceName -ConfigPath $taskConfigPath -WebhookUrl $AlertWebhookUrl
  $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)

  Register-ScheduledTask -TaskName $watchdogTaskName -Action $watchdogAction -Trigger $watchdogTrigger -Principal $principal -Settings $startupSettings -Force | Out-Null

  $watchdogTask = Get-ScheduledTask -TaskName $watchdogTaskName
  Write-Host "Registered scheduled task: $($watchdogTask.TaskName)"
  Write-Host "Mode: tunnel watchdog every 1 minute"
} else {
  Write-Warning "Run this script as Administrator to install the recurring recovery and tunnel watchdog tasks."
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
  return $targetConfigPath
}

function Ensure-CloudflaredService {
  param(
    [string]$ServiceName,
    [string]$ConfigPath,
    [int]$TargetPort
  )

  $cloudflaredExe = Resolve-CloudflaredExecutable
  $systemProfileConfig = Join-Path $env:WINDIR "System32\config\systemprofile\.cloudflared"
  $serviceConfigPath = Sync-CloudflaredServiceConfig -SourcePath $ConfigPath -TargetDirectory $systemProfileConfig -TargetPort $TargetPort
  Stop-TrustedCloudflaredProcesses -ConfigPath $serviceConfigPath

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

  if (-not $service) {
    Write-Host "Installing Cloudflared as a Windows service..."
    & $cloudflaredExe service install | Out-Null
    Start-Sleep -Seconds 2
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
  }

  Set-CloudflaredServiceImagePath -ServiceName $ServiceName -ExecutablePath $cloudflaredExe -ConfigPath $serviceConfigPath
  Set-Service -Name $ServiceName -StartupType Automatic
  Configure-CloudflaredServiceRecovery -ServiceName $ServiceName

  if ($service.Status -eq "Running") {
    Restart-Service -Name $ServiceName
  } else {
    Start-Service -Name $ServiceName
  }

  Start-Sleep -Seconds 2
  $service = Get-Service -Name $ServiceName

  if ($service.Status -ne "Running") {
    throw "cloudflared service did not remain running."
  }

  Write-Host "cloudflared service status: $($service.Status)"
}

Write-Host ""
Write-Host "==> Start cloudflared tunnel" -ForegroundColor Cyan
try {
  Ensure-CloudflaredService -ServiceName $CloudflaredServiceName -ConfigPath $CloudflaredConfigPath -TargetPort $Port
} catch {
  Write-Warning "cloudflared service start failed during install. The service remains installed for inspection. Falling back to the startup task, which can launch a direct tunnel process. $($_.Exception.Message)"
  Start-ScheduledTask -TaskName $TaskName
}
