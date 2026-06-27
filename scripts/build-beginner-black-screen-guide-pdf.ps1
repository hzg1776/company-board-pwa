param(
  [string]$BaseUrl = "http://127.0.0.1:3222"
)
$ErrorActionPreference = "Stop"

$root = "C:\Users\admin\Documents\Codex\Project-A"
$mdPath = Join-Path $root "docs\BEGINNER_BLACK_SCREEN_GUIDE.md"
$outDir = Join-Path $root "docs\manual-artifacts\black-screen-guide"
$shotDir = Join-Path $outDir "screenshots"
$htmlPath = Join-Path $outDir "Beginner_Black_Screen_Guide.html"
$pdfPath = Join-Path $outDir "Beginner_Black_Screen_Guide.pdf"
$resolvedBaseUrl = $BaseUrl.TrimEnd("/")

New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$routes = @(
  @{ name = "01-main-page"; label = "Step 1: Open the main app page"; url = "$resolvedBaseUrl/palzivalerts" },
  @{ name = "02-diagnostics-page"; label = "Step 2: Open the diagnostics page"; url = "$resolvedBaseUrl/api/health/diagnostics" },
  @{ name = "03-diagnostics-confirmation"; label = "Step 3 and Step 4: Confirm the server is up and inspect recent client errors"; url = "$resolvedBaseUrl/api/health/diagnostics" }
)

foreach ($route in $routes) {
  $out = Join-Path $shotDir ("$($route.name).png")
  npx playwright screenshot --device="Desktop Chrome HiDPI" --wait-for-timeout=1200 $route.url $out
}

$markdownHtml = ((& npx -y marked --gfm $mdPath) | Out-String).TrimEnd()

$stepShots = @(
  @{ title = "Step 1"; body = "Open the normal app page first and confirm the usual launcher buttons are visible."; file = "01-main-page.png" },
  @{ title = "Step 2"; body = "Open the diagnostics address when the page looks black, blank, or partly loaded."; file = "02-diagnostics-page.png" },
  @{ title = "Step 3"; body = "Check for `" + '"ok": true' + "` near the top of the diagnostics page."; file = "03-diagnostics-confirmation.png" },
  @{ title = "Step 4"; body = "Look for recent client events such as `blank-screen`, `runtime-error`, or `unhandled-rejection`."; file = "03-diagnostics-confirmation.png" },
  @{ title = "Step 5"; body = "Take one screenshot of the diagnostics page and send it with the time and device you used."; file = "03-diagnostics-confirmation.png" }
)

$stepHtml = "<div class='step-sections'>"
foreach ($step in $stepShots) {
  $rel = "screenshots/" + $step.file
  $stepHtml += @"
  <section class="step-card">
    <h2>$($step.title)</h2>
    <p>$($step.body)</p>
    <img src="$rel" alt="$($step.title)" />
  </section>
"@
}
$stepHtml += "</div>"

$header = @"
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Beginner Black Screen Guide</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; line-height: 1.5; }
  h1, h2, h3 { color: #0f172a; page-break-after: avoid; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 20px; margin-top: 22px; }
  p, li { font-size: 12px; }
  .cover { border-left: 6px solid #1d4ed8; padding-left: 14px; margin-bottom: 22px; }
  .meta { color: #475569; font-size: 11px; }
  .summary { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 14px; margin: 16px 0 22px; }
  .step-card { page-break-inside: avoid; margin: 18px 0 26px; }
  img { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 10px; }
  code { background: #f8fafc; padding: 2px 4px; border-radius: 4px; }
  ul { padding-left: 18px; }
</style>
</head>
<body>
  <div class="cover">
    <h1>Beginner Black Screen Guide</h1>
    <p class="meta">Generated: @@@DATE@@</p>
    <p>This quick PDF shows exactly what to do when the app looks black, blank, or partly loaded.</p>
  </div>
  <div class="summary">
    <strong>What this guide helps you do</strong>
    <ul>
      <li>Check whether the app is up</li>
      <li>Check whether the browser had a client-side problem</li>
      <li>Send a useful screenshot for support</li>
    </ul>
  </div>
"@

$header = $header.Replace("@@@DATE@@", (Get-Date).ToString("MMMM dd, yyyy HH:mm:ss"))
$footer = "</body></html>"
$manualHtml = ($header + "`n" + $markdownHtml + "`n" + $stepHtml + "`n" + $footer).TrimEnd()
Set-Content -Encoding UTF8 -Path $htmlPath -Value $manualHtml

npx playwright pdf "file:///$($htmlPath -replace '\\','/')" $pdfPath --viewport-size "1440,2200" --wait-for-timeout 1200
Write-Host "Generated PDF: $pdfPath"
