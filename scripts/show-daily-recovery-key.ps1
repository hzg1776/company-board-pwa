param(
  [int]$DayOffset = 0
)

$seed = [Environment]::GetEnvironmentVariable("ADMIN_DAILY_RECOVERY_SEED", "Process")
if (-not $seed) {
  $seed = [Environment]::GetEnvironmentVariable("ADMIN_DAILY_RECOVERY_SEED", "User")
}
if (-not $seed) {
  $seed = [Environment]::GetEnvironmentVariable("ADMIN_DAILY_RECOVERY_SEED", "Machine")
}
if (-not $seed) {
  throw "ADMIN_DAILY_RECOVERY_SEED is not configured."
}

$eastern = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")
$localDate = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $eastern).Date.AddDays($DayOffset)
$stamp = $localDate.ToString("yyyyMMdd")
$payload = [System.Text.Encoding]::UTF8.GetBytes("palziv-admin-recovery:$stamp")
$key = [System.Text.Encoding]::UTF8.GetBytes($seed)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($key)

try {
  $digest = -join ($hmac.ComputeHash($payload) | ForEach-Object { $_.ToString("X2") })
} finally {
  $hmac.Dispose()
}

$segment = $digest.Substring(0, 12)
$blocks = @(
  $segment.Substring(0, 4),
  $segment.Substring(4, 4),
  $segment.Substring(8, 4)
)

"PALZIV-$($stamp.Substring(2))-$($blocks -join '-')"
