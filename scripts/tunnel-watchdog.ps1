[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$RuntimeRoot,
    [string]$PublicBaseUrl = "https://itotexpress.com",
    [int]$LocalPort = 3116,
    [string]$CloudflaredServiceName = "cloudflared",
    [string]$CloudflaredConfigPath = "",
    [string]$TrustedProxyAddresses = "",
    [string]$AlertWebhookUrl = "",
    [int]$PublicTimeoutSec = 15,
    [int]$LocalTimeoutSec = 5,
    [int]$RecoveryWaitSec = 8,
    [int]$AlertCooldownMinutes = 15
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ProjectRoot) {
    $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
    $ProjectRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

. (Join-Path $PSScriptRoot "runtime-state.ps1")

$runtimeLayout = Initialize-BoardRuntimeLayout -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot
$logDirectory = $runtimeLayout.LogDirectory
if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

$logFile = Join-Path $logDirectory "tunnel-watchdog.log"
$stateFile = Join-Path $logDirectory "tunnel-watchdog.state.json"

function Write-WatchdogLog {
    param(
        [string]$Level,
        [string]$Message
    )

    $line = "{0} [{1}] {2}" -f (Get-Date).ToString("o"), $Level.ToUpperInvariant(), $Message
    Add-Content -LiteralPath $logFile -Value $line
    Write-Host $line
}

function New-WatchdogState {
    return @{
        lastAlertAt = $null
        lastAlertKey = $null
        lastRecoveryAt = $null
    }
}

function Read-WatchdogStateValue {
    param(
        [object]$State,
        [string]$PropertyName
    )

    if ($null -eq $State) {
        return $null
    }

    if ($State -is [System.Collections.IDictionary]) {
        if ($State.Contains($PropertyName)) {
            return $State[$PropertyName]
        }

        return $null
    }

    $property = $State.PSObject.Properties[$PropertyName]
    if ($null -ne $property) {
        return $property.Value
    }

    return $null
}

function Get-WatchdogState {
    if (-not (Test-Path -LiteralPath $stateFile)) {
        return New-WatchdogState
    }

    try {
        $raw = Get-Content -LiteralPath $stateFile -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) {
            throw "State file is empty."
        }

        $state = $raw | ConvertFrom-Json
        return @{
            lastAlertAt = Read-WatchdogStateValue -State $state -PropertyName "lastAlertAt"
            lastAlertKey = Read-WatchdogStateValue -State $state -PropertyName "lastAlertKey"
            lastRecoveryAt = Read-WatchdogStateValue -State $state -PropertyName "lastRecoveryAt"
        }
    } catch {
        Write-WatchdogLog -Level "warn" -Message "Could not read watchdog state; resetting state. $($_.Exception.Message)"
        return New-WatchdogState
    }
}

function Save-WatchdogState {
    param([hashtable]$State)

    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile
}

function Test-UrlHealth {
    param(
        [string]$Url,
        [int]$TimeoutSec
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return @{
            ok = ([int]$response.StatusCode -eq 200)
            statusCode = [int]$response.StatusCode
            detail = "HTTP $([int]$response.StatusCode)"
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        return @{
            ok = $false
            statusCode = $statusCode
            detail = $_.Exception.Message
        }
    }
}

function Write-AlertEvent {
    param(
        [ValidateSet("INFORMATION", "WARNING", "ERROR")]
        [string]$Type,
        [int]$EventId,
        [string]$Message
    )

    try {
        & eventcreate /L APPLICATION /T $Type /SO "CompanyBoardPWA" /ID $EventId /D $Message | Out-Null
    } catch {
        Write-WatchdogLog -Level "warn" -Message "Could not write Windows event log entry. $($_.Exception.Message)"
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

    throw "cloudflared was not found."
}

function Get-CloudflaredTunnelId {
    param([string]$ConfigPath)

    if (-not $ConfigPath -or -not (Test-Path -LiteralPath $ConfigPath)) {
        return $null
    }

    $configText = Get-Content -LiteralPath $ConfigPath -Raw
    $match = [regex]::Match($configText, '(?m)^\s*tunnel:\s*(.+)$')
    if (-not $match.Success) {
        return $null
    }

    return $match.Groups[1].Value.Trim()
}

function Resolve-CloudflaredConfigPath {
    param([string]$ExplicitConfigPath)

    foreach ($candidate in (Get-CloudflaredConfigCandidates -ExplicitConfigPath $ExplicitConfigPath)) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    return $null
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
            Write-WatchdogLog -Level "warn" -Message "Stopped direct cloudflared process $($process.ProcessId) before promoting the service."
        } catch {
            Write-WatchdogLog -Level "warn" -Message "Could not stop direct cloudflared process $($process.ProcessId). $($_.Exception.Message)"
        }
    }
}

function Start-CloudflaredTunnelProcess {
    param(
        [string]$Root,
        [string]$LogDirectory,
        [string]$ConfigPath
    )

    $resolvedConfigPath = Resolve-CloudflaredConfigPath -ExplicitConfigPath $ConfigPath
    if (-not $resolvedConfigPath) {
        throw "cloudflared config was not found."
    }

    $tunnelId = Get-CloudflaredTunnelId -ConfigPath $resolvedConfigPath
    if (-not $tunnelId) {
        throw "cloudflared config does not declare a tunnel id."
    }

    $cloudflaredExe = Resolve-CloudflaredExecutable
    $stdout = Join-Path $LogDirectory "cloudflared.out.log"
    $stderr = Join-Path $LogDirectory "cloudflared.err.log"

    Start-Process -FilePath $cloudflaredExe `
        -WindowStyle Hidden `
        -WorkingDirectory $Root `
        -ArgumentList @("--config", $resolvedConfigPath, "tunnel", "run", $tunnelId) `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr | Out-Null

    Write-WatchdogLog -Level "warn" -Message "Started direct cloudflared tunnel process for $tunnelId."
}

function Restart-DirectCloudflaredTunnelProcess {
    param(
        [string]$Root,
        [string]$LogDirectory,
        [string]$ConfigPath
    )

    $resolvedConfigPath = Resolve-CloudflaredConfigPath -ExplicitConfigPath $ConfigPath
    if (-not $resolvedConfigPath) {
        throw "cloudflared config was not found."
    }

    foreach ($process in (Get-TrustedCloudflaredProcesses -ConfigPath $resolvedConfigPath)) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Write-WatchdogLog -Level "warn" -Message "Stopped stale cloudflared process $($process.ProcessId)."
        } catch {
            Write-WatchdogLog -Level "warn" -Message "Could not stop stale cloudflared process $($process.ProcessId). $($_.Exception.Message)"
        }
    }

    Start-CloudflaredTunnelProcess -Root $Root -LogDirectory $LogDirectory -ConfigPath $resolvedConfigPath
    return "restart direct process"
}

function Send-AlertWebhook {
    param(
        [string]$WebhookUrl,
        [string]$Severity,
        [string]$Message,
        [hashtable]$Context
    )

    if ([string]::IsNullOrWhiteSpace($WebhookUrl)) {
        return
    }

    $payload = @{
        service = "CompanyBoardPWA"
        severity = $Severity
        message = $Message
        context = $Context
        timestamp = (Get-Date).ToString("o")
    }

    try {
        Invoke-RestMethod -Uri $WebhookUrl -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 8) -TimeoutSec 15 | Out-Null
    } catch {
        Write-WatchdogLog -Level "warn" -Message "Webhook alert failed. $($_.Exception.Message)"
    }
}

function Should-SendAlert {
    param(
        [hashtable]$State,
        [string]$AlertKey,
        [int]$CooldownMinutes
    )

    if (-not $State.lastAlertAt -or -not $State.lastAlertKey) {
        return $true
    }

    $lastAlertAt = $null
    if (-not [DateTime]::TryParse($State.lastAlertAt, [ref]$lastAlertAt)) {
        return $true
    }

    if ($State.lastAlertKey -ne $AlertKey) {
        return $true
    }

    return ((Get-Date) -gt $lastAlertAt.AddMinutes($CooldownMinutes))
}

function Recover-CloudflaredTunnel {
    param(
        [string]$ServiceName,
        [string]$ConfigPath
    )

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        try {
            Stop-TrustedCloudflaredProcesses -ConfigPath $ConfigPath

            if ($service.Status -eq "Running") {
                Restart-Service -Name $ServiceName -Force -ErrorAction Stop
                $action = "restart service"
            } else {
                Start-Service -Name $ServiceName -ErrorAction Stop
                $action = "start service"
            }

            Start-Sleep -Seconds 2
            $service = Get-Service -Name $ServiceName -ErrorAction Stop
            if ($service.Status -eq "Running") {
                return $action
            }

            Write-WatchdogLog -Level "warn" -Message "cloudflared service '$ServiceName' did not remain running. Falling back to a direct tunnel process."
        } catch {
            Write-WatchdogLog -Level "warn" -Message "cloudflared service '$ServiceName' recovery failed. Falling back to a direct tunnel process. $($_.Exception.Message)"
        }
    } else {
        Write-WatchdogLog -Level "warn" -Message "cloudflared service '$ServiceName' was not found. Falling back to a direct tunnel process."
    }

    return Restart-DirectCloudflaredTunnelProcess -Root $ProjectRoot -LogDirectory $logDirectory -ConfigPath $ConfigPath
}

$publicHealthUrl = ($PublicBaseUrl.TrimEnd('/')) + "/api/health"
$localHealthUrl = "http://127.0.0.1:$LocalPort/api/health"
$state = Get-WatchdogState
$publicResult = Test-UrlHealth -Url $publicHealthUrl -TimeoutSec $PublicTimeoutSec
$localResult = Test-UrlHealth -Url $localHealthUrl -TimeoutSec $LocalTimeoutSec

if ($publicResult.ok) {
    Write-WatchdogLog -Level "info" -Message "Public health ok."
    return
}

if (-not $localResult.ok) {
    $message = "Public health failed and local origin is also unhealthy. Public=$($publicResult.detail); Local=$($localResult.detail)"
    Write-WatchdogLog -Level "error" -Message $message

    if (Should-SendAlert -State $state -AlertKey "origin-down" -CooldownMinutes $AlertCooldownMinutes) {
        Write-AlertEvent -Type "ERROR" -EventId 2001 -Message $message
        Send-AlertWebhook -WebhookUrl $AlertWebhookUrl -Severity "critical" -Message $message -Context @{
            publicHealthUrl = $publicHealthUrl
            localHealthUrl = $localHealthUrl
        }

        $state.lastAlertAt = (Get-Date).ToString("o")
        $state.lastAlertKey = "origin-down"
        Save-WatchdogState -State $state
    }

    return
}

$preRecoveryMessage = "Public health failed while local origin is healthy. Attempting Cloudflare tunnel recovery. Public=$($publicResult.detail); Local=$($localResult.detail)"
Write-WatchdogLog -Level "warn" -Message $preRecoveryMessage
$action = Recover-CloudflaredTunnel -ServiceName $CloudflaredServiceName -ConfigPath $CloudflaredConfigPath
Start-Sleep -Seconds $RecoveryWaitSec
$postRecoveryResult = Test-UrlHealth -Url $publicHealthUrl -TimeoutSec $PublicTimeoutSec

if ($postRecoveryResult.ok) {
    $message = "Cloudflare tunnel self-recovery succeeded via $action."
    Write-WatchdogLog -Level "info" -Message $message
    Write-AlertEvent -Type "WARNING" -EventId 2002 -Message $message

    $state.lastRecoveryAt = (Get-Date).ToString("o")
    $state.lastAlertAt = $null
    $state.lastAlertKey = $null
    Save-WatchdogState -State $state
    return
}

$failureMessage = "Cloudflare tunnel self-recovery failed. Public health still failing after $action. Public=$($postRecoveryResult.detail); Local=$($localResult.detail)"
Write-WatchdogLog -Level "error" -Message $failureMessage

if (Should-SendAlert -State $state -AlertKey "tunnel-recovery-failed" -CooldownMinutes $AlertCooldownMinutes) {
    Write-AlertEvent -Type "ERROR" -EventId 2003 -Message $failureMessage
    Send-AlertWebhook -WebhookUrl $AlertWebhookUrl -Severity "critical" -Message $failureMessage -Context @{
        publicHealthUrl = $publicHealthUrl
        localHealthUrl = $localHealthUrl
        serviceName = $CloudflaredServiceName
    }

    $state.lastAlertAt = (Get-Date).ToString("o")
    $state.lastAlertKey = "tunnel-recovery-failed"
    Save-WatchdogState -State $state
}
