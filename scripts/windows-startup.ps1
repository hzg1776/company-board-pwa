[CmdletBinding()]
param(
  [int]$Port = 3116,
  [string]$ProjectRoot,
  [string]$CloudflaredServiceName = "Cloudflared",
  [string]$PublicBaseUrl,
  [string]$CloudflaredConfigPath,
  [string]$TrustedProxyAddresses = "",
  [switch]$SkipCloudflared
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not $ProjectRoot) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  $ProjectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Get-CloudflaredConfigCandidates {
  param([string]$ExplicitConfigPath)

  $candidates = @()

  if ($ExplicitConfigPath) {
    $candidates += $ExplicitConfigPath
  }

  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE ".cloudflared\config.yml")
  }

  if ($env:WINDIR) {
    $candidates += (Join-Path $env:WINDIR "System32\config\systemprofile\.cloudflared\config.yml")
  }

  return $candidates |
    Where-Object { $_ } |
    Select-Object -Unique
}

function Resolve-PublicBaseUrl {
  param(
    [string]$ExplicitPublicBaseUrl,
    [string]$ExplicitConfigPath
  )

  if ($ExplicitPublicBaseUrl) {
    $trimmed = $ExplicitPublicBaseUrl.Trim().TrimEnd('/')
    $parsed = $null

    if (-not [Uri]::TryCreate($trimmed, [UriKind]::Absolute, [ref]$parsed)) {
      throw "PublicBaseUrl must be a valid absolute URL."
    }

    if ($parsed.Scheme -notin @("http", "https")) {
      throw "PublicBaseUrl must use http or https."
    }

    return $parsed.GetLeftPart([UriPartial]::Authority)
  }

  foreach ($configPath in (Get-CloudflaredConfigCandidates -ExplicitConfigPath $ExplicitConfigPath)) {
    if (-not (Test-Path $configPath)) {
      continue
    }

    $configText = Get-Content -LiteralPath $configPath -Raw
    $matches = [regex]::Matches($configText, '(?m)^\s*hostname:\s*(.+)$')
    if (-not $matches.Count) {
      continue
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
      continue
    }

    $preferredHost = $hostnames | Where-Object { $_ -notmatch '^www\.' } | Select-Object -First 1
    if (-not $preferredHost) {
      $preferredHost = $hostnames | Select-Object -First 1
    }

    return "https://$preferredHost"
  }

  throw "Could not determine PUBLIC_BASE_URL. Pass -PublicBaseUrl explicitly or provide a cloudflared config with hostname entries."
}

function Get-PortListeners {
  param([int]$TargetPort)

  return Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
}

function Test-BoardHealth {
  param([int]$TargetPort)

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$TargetPort/api/health" -TimeoutSec 5 -ErrorAction Stop
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Stop-PortListeners {
  param([int]$TargetPort)

  $listeners = Get-PortListeners -TargetPort $TargetPort
  if (-not $listeners) {
    return
  }

  $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pid in $processIds) {
    try {
      Stop-Process -Id $pid -Force -ErrorAction Stop
      Write-Host "Stopped process $pid on port $TargetPort."
    } catch {
      Write-Warning "Could not stop process $pid on port $TargetPort."
    }
  }
}

function Wait-ForPortRelease {
  param(
    [int]$TargetPort,
    [int]$TimeoutSeconds = 10
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-PortListeners -TargetPort $TargetPort)) {
      return $true
    }

    Start-Sleep -Seconds 1
  }

  return -not (Get-PortListeners -TargetPort $TargetPort)
}

function Wait-ForBoardHealth {
  param(
    [int]$TargetPort,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BoardHealth -TargetPort $TargetPort) {
      return $true
    }

    Start-Sleep -Seconds 1
  }

  return Test-BoardHealth -TargetPort $TargetPort
}

function Get-CloudflaredProcesses {
  return Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
}

function Wait-ForServiceRunning {
  param(
    [string]$ServiceName,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -eq "Running") {
      return $true
    }

    Start-Sleep -Seconds 2
  }

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  return [bool]($service -and $service.Status -eq "Running")
}

function Resolve-NodeExecutable {
  try {
    $node = Get-Command node -ErrorAction Stop
    if ($node.Source) {
      return $node.Source
    }
  } catch {
    # Fall through to common install locations.
  }

  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Node.js was not found. Install Node.js before enabling startup."
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

  throw "cloudflared was not found. Install Cloudflare Tunnel before enabling startup."
}

function Start-BoardApp {
  param(
    [string]$Root,
    [int]$TargetPort,
    [string]$LogDirectory,
    [string]$ResolvedPublicBaseUrl,
    [string]$ResolvedTrustedProxyAddresses
  )

  if (Test-BoardHealth -TargetPort $TargetPort) {
    Write-Host "Board app is already healthy on port ${TargetPort}."
    return
  }

  $listeners = Get-PortListeners -TargetPort $TargetPort
  if ($listeners) {
    $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    $processNames = foreach ($pid in $processIds) {
      try {
        (Get-Process -Id $pid -ErrorAction Stop).ProcessName
      } catch {
        "pid:$pid"
      }
    }

    Write-Warning "Port ${TargetPort} is occupied by: $($processNames -join ', ')."
    Write-Warning "Stopping stale listener(s) before starting the app."
    Stop-PortListeners -TargetPort $TargetPort

    if (-not (Wait-ForPortRelease -TargetPort $TargetPort)) {
      throw "Port ${TargetPort} is still in use after attempting recovery."
    }
  }

  $nodePath = Resolve-NodeExecutable
  $serverFile = Join-Path $Root "server.js"
  $previousPort = $env:PORT
  $previousPublicBaseUrl = $env:PUBLIC_BASE_URL
  $previousTrustedProxyAddresses = $env:TRUST_PROXY_ADDRESSES
  $env:PORT = "$TargetPort"
  $env:PUBLIC_BASE_URL = $ResolvedPublicBaseUrl

  if ($ResolvedTrustedProxyAddresses) {
    $env:TRUST_PROXY_ADDRESSES = $ResolvedTrustedProxyAddresses
  } else {
    Remove-Item Env:TRUST_PROXY_ADDRESSES -ErrorAction SilentlyContinue
  }

  $stdout = Join-Path $LogDirectory "board-app.out.log"
  $stderr = Join-Path $LogDirectory "board-app.err.log"

  try {
    Start-Process -FilePath $nodePath `
      -WindowStyle Hidden `
      -WorkingDirectory $Root `
      -ArgumentList @($serverFile) `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr | Out-Null

    if (-not (Wait-ForBoardHealth -TargetPort $TargetPort)) {
      throw "Board app did not become healthy on port ${TargetPort}."
    }
  } finally {
    if ($null -eq $previousPort) {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    } else {
      $env:PORT = $previousPort
    }

    if ([string]::IsNullOrEmpty($previousPublicBaseUrl)) {
      Remove-Item Env:PUBLIC_BASE_URL -ErrorAction SilentlyContinue
    } else {
      $env:PUBLIC_BASE_URL = $previousPublicBaseUrl
    }

    if ([string]::IsNullOrEmpty($previousTrustedProxyAddresses)) {
      Remove-Item Env:TRUST_PROXY_ADDRESSES -ErrorAction SilentlyContinue
    } else {
      $env:TRUST_PROXY_ADDRESSES = $previousTrustedProxyAddresses
    }
  }

  Write-Host "Started board app on port ${TargetPort}."
  Write-Host "Public origin: $ResolvedPublicBaseUrl"
  Write-Host "App logs: $stdout"
  Write-Host "App errors: $stderr"
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

function Start-CloudflaredTunnelProcess {
  param(
    [string]$Root,
    [string]$LogDirectory,
    [string]$ConfigPath
  )

  $candidateConfig = $ConfigPath
  if (-not $candidateConfig) {
    $candidateConfig = (Get-CloudflaredConfigCandidates -ExplicitConfigPath $null | Select-Object -First 1)
  }

  $tunnelId = Get-CloudflaredTunnelId -ConfigPath $candidateConfig

  if (-not $tunnelId) {
    Write-Warning "cloudflared fallback skipped because the tunnel config was not found at $candidateConfig."
    return
  }

  $cloudflaredExe = Resolve-CloudflaredExecutable
  $stdout = Join-Path $LogDirectory "cloudflared.out.log"
  $stderr = Join-Path $LogDirectory "cloudflared.err.log"

  Start-Process -FilePath $cloudflaredExe `
    -WindowStyle Hidden `
    -WorkingDirectory $Root `
    -ArgumentList @("tunnel", "run", $tunnelId) `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr | Out-Null

  Write-Host "Started direct cloudflared tunnel process for $tunnelId."
  Write-Host "Tunnel logs: $stdout"
  Write-Host "Tunnel errors: $stderr"
}

function Ensure-CloudflaredService {
  param(
    [string]$ServiceName,
    [string]$Root,
    [string]$LogDirectory,
    [string]$ConfigPath
  )

  $cloudflaredProcess = Get-CloudflaredProcesses | Select-Object -First 1
  if ($cloudflaredProcess) {
    Write-Host "cloudflared process already running (pid $($cloudflaredProcess.Id))."
    return
  }

  try {
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
  } catch {
    Write-Warning "cloudflared service '$ServiceName' was not found."
    Write-Warning "Falling back to a direct cloudflared process."
    Start-CloudflaredTunnelProcess -Root $Root -LogDirectory $LogDirectory -ConfigPath $ConfigPath
    return
  }

  if ($service.Status -ne "Running") {
    try {
      Start-Service -Name $ServiceName
    } catch {
      Write-Warning "cloudflared service '$ServiceName' could not be started."
      Write-Warning "Falling back to a direct cloudflared process."
      Start-CloudflaredTunnelProcess -Root $Root -LogDirectory $LogDirectory -ConfigPath $ConfigPath
      return
    }
  }

  if (-not (Wait-ForServiceRunning -ServiceName $ServiceName)) {
    $cloudflaredProcess = Get-CloudflaredProcesses | Select-Object -First 1
    if ($cloudflaredProcess) {
      Write-Host "cloudflared process already running (pid $($cloudflaredProcess.Id))."
      return
    }

    Write-Warning "cloudflared service '$ServiceName' is still not running."
    Write-Warning "Falling back to a direct cloudflared process."
    Start-CloudflaredTunnelProcess -Root $Root -LogDirectory $LogDirectory -ConfigPath $ConfigPath
    return
  }

  Write-Host "cloudflared service status: $($service.Status)"
}

Write-Step "Confirm project root"
if (-not (Test-Path $ProjectRoot)) {
  throw "Project root not found: $ProjectRoot"
}
Write-Host "Project root: $ProjectRoot"

Set-Location $ProjectRoot
$logDirectory = Join-Path $ProjectRoot "logs"
Ensure-Directory -Path $logDirectory
$resolvedPublicBaseUrl = Resolve-PublicBaseUrl -ExplicitPublicBaseUrl $PublicBaseUrl -ExplicitConfigPath $CloudflaredConfigPath

Write-Step "Start the board app"
Start-BoardApp -Root $ProjectRoot -TargetPort $Port -LogDirectory $logDirectory -ResolvedPublicBaseUrl $resolvedPublicBaseUrl -ResolvedTrustedProxyAddresses $TrustedProxyAddresses

if (-not $SkipCloudflared) {
  Write-Step "Start cloudflared"
  Ensure-CloudflaredService -ServiceName $CloudflaredServiceName -Root $ProjectRoot -LogDirectory $logDirectory -ConfigPath $CloudflaredConfigPath
}

Write-Step "Recovery summary"
Write-Host "Launcher: http://localhost:$Port/palzivalerts"
Write-Host "Employee feed: http://localhost:$Port/palzivalerts/employee"
Write-Host "HR board: http://localhost:$Port/palzivalerts/hr"
Write-Host "Webmaster board: http://localhost:$Port/palzivalerts/webmaster"
Write-Host "Public origin: $resolvedPublicBaseUrl"
Write-Host "If the tunnel service is installed and running, it will bridge the same local port to your public hostname."
