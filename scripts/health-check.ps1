param(
    [string]$BaseUrl = "https://itotexpress.com",
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = "Stop"
$targets = @(
    "/api/health",
    "/palzivalerts/",
    "/palzivalerts/employee",
    "/palzivalerts/hr",
    "/palzivalerts/webmaster",
    "/palzivalerts/it"
)

$results = @()

foreach ($path in $targets) {
    $url = "$BaseUrl$path"
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $TimeoutSec
        $results += [pscustomobject]@{
            Path = $path
            StatusCode = [int]$response.StatusCode
            Ok = ([int]$response.StatusCode -eq 200)
        }
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        $results += [pscustomobject]@{
            Path = $path
            StatusCode = $statusCode
            Ok = $false
        }
    }
}

$results | Format-Table -AutoSize

if ($results.Where({ -not $_.Ok }).Count -gt 0) {
    throw "One or more health checks failed."
}
