param(
  [string]$BaseUrl = ""
)
$ErrorActionPreference = 'Stop'

$root = 'C:\Users\admin\Documents\Codex\Project-A'
$outDir = Join-Path $root 'docs\manual-artifacts'
$shotDir = Join-Path $outDir 'screenshots'
$pdfPath = Join-Path $outDir 'Communications_And_Alert_Center_User_Manual.pdf'
$htmlPath = Join-Path $outDir 'Communications_And_Alert_Center_User_Manual.html'
$mdPath = Join-Path $root 'docs\USER_MANUAL.md'
$resolvedBaseUrl = if ($BaseUrl) { $BaseUrl } elseif ($env:PUBLIC_BASE_URL) { $env:PUBLIC_BASE_URL } else { 'http://localhost:3000' }
$resolvedBaseUrl = $resolvedBaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$routes = @(
    @{ name = '01-launcher';     url = "$resolvedBaseUrl/palzivalerts";            label = 'Launcher page (/palzivalerts)' },
    @{ name = '02-employee';     url = "$resolvedBaseUrl/palzivalerts/employee";   label = 'Employee login and feed view (/palzivalerts/employee)' },
    @{ name = '03-hr';           url = "$resolvedBaseUrl/palzivalerts/hr";         label = 'HR login route (/palzivalerts/hr)' },
    @{ name = '04-webmaster';    url = "$resolvedBaseUrl/palzivalerts/webmaster";  label = 'Systems login route (/palzivalerts/webmaster)' },
    @{ name = '05-it';           url = "$resolvedBaseUrl/palzivalerts/it";         label = 'IT login route (/palzivalerts/it)' }
)

foreach ($r in $routes) {
    $out = Join-Path $shotDir ("$($r.name).png")
    npx playwright screenshot --device="iPhone 13" --wait-for-timeout=1200 $r.url $out
}

$markdownHtml = ((& npx -y marked --gfm $mdPath) | Out-String).TrimEnd()

$header = @"
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Communications and Alert Center User Manual</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.45; }
  h1, h2, h3, h4 { color: #0f172a; page-break-after: avoid; }
  h1 { font-size: 28px; margin-bottom: 2px; }
  h2 { font-size: 20px; margin-top: 24px; }
  h3 { font-size: 16px; }
  p, li { font-size: 11.5px; }
  .meta { color: #334155; font-size: 11px; margin-bottom: 20px; }
  .cover { border-left: 6px solid #0f172a; padding-left: 14px; margin-bottom: 28px; }
  .toc { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 14px; margin: 14px 0 18px; border-radius: 6px; }
  ul { padding-left: 18px; }
  pre { background: #0f172a; color: #f8fafc; padding: 10px; border-radius: 6px; overflow-wrap: break-word; }
  img { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; margin: 8px 0; page-break-inside: avoid; }
  .screen img { width: 72%; max-width: 72%; display: block; }
  .caption { font-weight: 600; color: #334155; margin-top: 2px; }
  .shot-grid { display: block; }
  .section { page-break-inside: avoid; margin: 14px 0; }
  .kicker { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #64748b; font-size: 10px; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }
</style>
</head>
<body>
<div class="cover">
  <div class="kicker">Communications and Alert Center</div>
  <h1>Professional User Manual</h1>
  <div class="meta">Generated: @@@DATE@@</div>
  <p>This manual explains core workflows for employees, HR admins, Systems operators, and IT governance admins.</p>
</div>
<div class="toc">
  <strong>Quick navigation</strong>
  <ul>
    <li>Employee onboarding and feed usage</li>
    <li>HR publishing and employee management</li>
    <li>Systems monitoring and recovery tasks</li>
    <li>IT governance and recovery oversight</li>
    <li>Operational checks and troubleshooting</li>
  </ul>
</div>
<hr/>
"@

$header = $header.Replace('@@@DATE@@', (Get-Date).ToString('MMMM dd, yyyy HH:mm:ss'))

$shotBlock = @"
<div class="section">
  <h2>Appendix: Screenshots</h2>
  <p class="caption">Use these for quick recognition and training handoff.</p>
  <div class="shot-grid">
"@

foreach ($r in $routes) {
    $img = Join-Path $shotDir ("$($r.name).png")
    $rel = 'screenshots/' + (Split-Path $img -Leaf)
    $shotBlock += @"
    <div class="section screen">
      <div class="caption">$($r.label)</div>
      <img src="$rel" alt="$($r.label)" />
    </div>
"@
}
$shotBlock += @"
  </div>
</div>
</body></html>
"@

$manualHtml = ($header + "`n`n" + $markdownHtml + "`n`n" + $shotBlock).TrimEnd()
Set-Content -Encoding UTF8 -Path $htmlPath -Value $manualHtml

npx playwright pdf "file:///$($htmlPath -replace '\\','/')" $pdfPath --viewport-size "1240,1754" --wait-for-timeout 1200
Write-Host "Generated PDF: $pdfPath"
