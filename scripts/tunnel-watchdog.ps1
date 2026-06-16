[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$PublicBaseUrl = "https://itotexpress.com",
    [int]$LocalPort = 3116,
    [string]$CloudflaredServiceName = "cloudflared",
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

$logDirectory = Join-Path $ProjectRoot "logs"
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

function Get-WatchdogState {
    if (-not (Test-Path -LiteralPath $stateFile)) {
        return @{
            lastAlertAt = $null
            lastAlertKey = $null
            lastRecoveryAt = $null
        }
    }

    try {
        $raw = Get-Content -LiteralPath $stateFile -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) {
            throw "State file is empty."
        }

        $state = $raw | ConvertFrom-Json -AsHashtable
        return @{
            lastAlertAt = $state.lastAlertAt
            lastAlertKey = $state.lastAlertKey
            lastRecoveryAt = $state.lastRecoveryAt
        }
    } catch {
        Write-WatchdogLog -Level "warn" -Message "Could not read watchdog state; resetting state. $($_.Exception.Message)"
        return @{
            lastAlertAt = $null
            lastAlertKey = $null
            lastRecoveryAt = $null
        }
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

function Restart-CloudflaredServiceSafe {
    param([string]$ServiceName)

    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($service.Status -eq "Running") {
        Restart-Service -Name $ServiceName -Force -ErrorAction Stop
        return "restart"
    }

    Start-Service -Name $ServiceName -ErrorAction Stop
    return "start"
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
$action = Restart-CloudflaredServiceSafe -ServiceName $CloudflaredServiceName
Start-Sleep -Seconds $RecoveryWaitSec
$postRecoveryResult = Test-UrlHealth -Url $publicHealthUrl -TimeoutSec $PublicTimeoutSec

if ($postRecoveryResult.ok) {
    $message = "Cloudflare tunnel self-recovery succeeded via $action of service '$CloudflaredServiceName'."
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
