param(
  [string]$BaseUrl = "",
  [switch]$AuthenticatedScreenshots
)

$ErrorActionPreference = "Stop"

function Assert-NativeSuccess {
  param([string]$Operation)

  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE."
  }
}

function Convert-MarkdownToHtml {
  param([string]$Path)

  $html = ((& npx -y marked --gfm $Path) | Out-String).TrimEnd()
  Assert-NativeSuccess "Markdown conversion for $Path"
  return $html
}

function New-DocumentHeader {
  param(
    [string]$DocumentTitle,
    [string]$Summary,
    [string]$GeneratedAt,
    [string]$Revision
  )

  return @"
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>$DocumentTitle</title>
<style>
  @page { size: A4; margin: 18mm 18mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; line-height: 1.45; margin: 0; }
  h1, h2, h3, h4 { color: #0f172a; page-break-after: avoid; break-after: avoid-page; }
  h1 { font-size: 28px; margin-bottom: 2px; }
  h2 { font-size: 20px; margin-top: 24px; }
  h3 { font-size: 16px; }
  p, li, td, th { font-size: 11.5px; }
  a { color: #1d4ed8; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 7px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .cover { border-left: 6px solid #0f172a; padding-left: 14px; margin-bottom: 24px; }
  .meta { color: #475569; font-size: 10.5px; margin: 2px 0; }
  .summary { color: #334155; max-width: 90%; }
  ul, ol { padding-left: 20px; }
  pre { background: #0f172a; color: #f8fafc; padding: 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
  code { overflow-wrap: anywhere; }
  img { max-width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; margin: 8px 0; }
  .screenshot-appendix { break-before: page; page-break-before: always; }
  .screen { break-inside: avoid; page-break-inside: avoid; margin: 14px 0 22px; }
  .screen-following { break-before: page; page-break-before: always; }
  .screen img { width: 50%; display: block; }
  .caption { font-weight: 600; color: #334155; margin-top: 2px; }
  .kicker { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #64748b; font-size: 10px; }
</style>
</head>
<body>
<div class="cover">
  <div class="kicker">Communications and Alert Center</div>
  <h1>$DocumentTitle</h1>
  <div class="meta">Generated: $GeneratedAt</div>
  <div class="meta">Application revision: $Revision</div>
  <p class="summary">$Summary</p>
</div>
"@
}

function New-ScreenshotAppendix {
  param(
    [array]$Routes,
    [string]$CaptureMode
  )

  $html = '<section class="screenshot-appendix">'
  $isFirst = $true

  foreach ($route in $Routes) {
    $relativePath = "screenshots/$($route.name).png"
    $screenClass = if ($isFirst) { "screen" } else { "screen screen-following" }
    $intro = if ($isFirst) {
      "    <h2>Route Screenshots</h2><p class=`"caption`">Use these images to recognize the current entry points. Capture mode: $CaptureMode.</p>"
    } else {
      ""
    }
    $html += @"
  <div class="$screenClass">
$intro
    <div class="caption">$($route.label)</div>
    <img src="$relativePath" alt="$($route.label)" />
  </div>
"@
    $isFirst = $false
  }

  $html += "</section>"
  return ($html -replace "(?m)[ \t]+$", "")
}

function Publish-StagedFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Expected staged artifact is missing: $Source"
  }

  Move-Item -LiteralPath $Source -Destination $Destination -Force
}

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "docs\manual-artifacts"
$shotDir = Join-Path $outDir "screenshots"
$tempParent = Join-Path $root "tmp\manual-build"
$buildId = [Guid]::NewGuid().ToString("N")
$stageRoot = Join-Path $tempParent $buildId
$stageShotDir = Join-Path $stageRoot "screenshots"
$storageDir = Join-Path $stageRoot "storage-state"
$fullMdPath = Join-Path $root "docs\USER_MANUAL.md"
$quickMdPath = Join-Path $root "docs\QUICK_START_MANUAL.md"
$fullHtmlName = "Communications_And_Alert_Center_User_Manual.html"
$fullPdfName = "Communications_And_Alert_Center_User_Manual.pdf"
$quickHtmlName = "Communications_And_Alert_Center_Quick_Start.html"
$quickPdfName = "Communications_And_Alert_Center_Quick_Start.pdf"
$resolvedBaseUrl = if ($BaseUrl) { $BaseUrl } elseif ($env:PUBLIC_BASE_URL) { $env:PUBLIC_BASE_URL } else { "http://localhost:3116" }
$resolvedBaseUrl = $resolvedBaseUrl.TrimEnd("/")
$captureMode = if ($AuthenticatedScreenshots) { "authenticated" } else { "public-sign-in" }
$revision = ((& git -C $root rev-parse --short HEAD) | Out-String).Trim()
Assert-NativeSuccess "Git revision lookup"
$generatedAt = (Get-Date).ToString("MMMM dd, yyyy HH:mm:ss zzz")

$publicLabels = @{
  employee = "Employee sign-in page (/palzivalerts/employee)"
  hr = "HR sign-in page (/palzivalerts/hr)"
  webmaster = "Systems sign-in page (/palzivalerts/webmaster)"
  it = "IT sign-in page (/palzivalerts/it)"
}
$authenticatedLabels = @{
  employee = "Employee signed-in feed (/palzivalerts/employee)"
  hr = "HR Control Center signed in (/palzivalerts/hr)"
  webmaster = "Systems Command Center signed in (/palzivalerts/webmaster)"
  it = "IT Control Center signed in (/palzivalerts/it)"
}
$selectedLabels = if ($AuthenticatedScreenshots) { $authenticatedLabels } else { $publicLabels }

$routes = @(
  @{ name = "01-launcher"; role = "launcher"; url = "$resolvedBaseUrl/palzivalerts"; label = "Launcher page (/palzivalerts)" },
  @{ name = "02-employee"; role = "employee"; url = "$resolvedBaseUrl/palzivalerts/employee"; label = $selectedLabels.employee },
  @{ name = "03-hr"; role = "hr"; url = "$resolvedBaseUrl/palzivalerts/hr"; label = $selectedLabels.hr },
  @{ name = "04-webmaster"; role = "webmaster"; url = "$resolvedBaseUrl/palzivalerts/webmaster"; label = $selectedLabels.webmaster },
  @{ name = "05-it"; role = "it"; url = "$resolvedBaseUrl/palzivalerts/it"; label = $selectedLabels.it }
)

$resolvedWorkspacePrefix = [IO.Path]::GetFullPath($root).TrimEnd("\") + "\"
$resolvedStageRoot = [IO.Path]::GetFullPath($stageRoot)
if (!$resolvedStageRoot.StartsWith($resolvedWorkspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Manual build staging path escaped the workspace: $resolvedStageRoot"
}

try {
  New-Item -ItemType Directory -Force -Path $stageShotDir | Out-Null
  New-Item -ItemType Directory -Force -Path $storageDir | Out-Null
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

  $health = Invoke-RestMethod -Method Get -Uri "$resolvedBaseUrl/api/health" -TimeoutSec 15
  if ($health.ok -ne $true) {
    throw "The manual build target did not return ok=true from /api/health."
  }

  if ($AuthenticatedScreenshots) {
    $env:MANUAL_BASE_URL = $resolvedBaseUrl
    $env:MANUAL_SCREENSHOT_DIR = $storageDir
    & node (Join-Path $root "scripts\capture-manual-screenshots.mjs")
    Assert-NativeSuccess "Authenticated manual login capture"
  }

  foreach ($route in $routes) {
    $outputPath = Join-Path $stageShotDir "$($route.name).png"

    if ($AuthenticatedScreenshots -and $route.role -ne "launcher") {
      $storagePath = Join-Path $storageDir "$($route.role)-storage.json"
      if (!(Test-Path -LiteralPath $storagePath -PathType Leaf)) {
        throw "Authenticated storage state is missing for $($route.role)."
      }
      & npx playwright screenshot --browser="chromium" --channel="chrome" --viewport-size="390,844" --full-page --wait-for-timeout=1200 --load-storage $storagePath $route.url $outputPath
      Assert-NativeSuccess "Screenshot capture for $($route.role)"
    } else {
      & npx playwright screenshot --browser="chromium" --channel="chrome" --viewport-size="390,844" --full-page --wait-for-timeout=1200 $route.url $outputPath
      Assert-NativeSuccess "Screenshot capture for $($route.role)"
    }
  }

  $fullMarkdownHtml = Convert-MarkdownToHtml $fullMdPath
  $quickMarkdownHtml = Convert-MarkdownToHtml $quickMdPath
  $screenshotAppendix = New-ScreenshotAppendix -Routes $routes -CaptureMode $captureMode

  $fullHeader = New-DocumentHeader `
    -DocumentTitle "Professional User Manual" `
    -Summary "Current workflows for employees, HR admins, Systems operators, and IT governance admins." `
    -GeneratedAt $generatedAt `
    -Revision $revision
  $quickHeader = New-DocumentHeader `
    -DocumentTitle "Quick Start" `
    -Summary "A concise how-to for signing in, receiving alerts, publishing updates, and using the four role-specific areas." `
    -GeneratedAt $generatedAt `
    -Revision $revision
  $footer = "</body></html>"

  $fullHtmlPath = Join-Path $stageRoot $fullHtmlName
  $quickHtmlPath = Join-Path $stageRoot $quickHtmlName
  $fullPdfPath = Join-Path $stageRoot $fullPdfName
  $quickPdfPath = Join-Path $stageRoot $quickPdfName

  Set-Content -Encoding UTF8 -Path $fullHtmlPath -Value (($fullHeader + "`n" + $fullMarkdownHtml + "`n" + $screenshotAppendix + "`n" + $footer).TrimEnd())
  Set-Content -Encoding UTF8 -Path $quickHtmlPath -Value (($quickHeader + "`n" + $quickMarkdownHtml + "`n" + $footer).TrimEnd())

  $fullFileUrl = "file:///$($fullHtmlPath -replace '\\','/')"
  $quickFileUrl = "file:///$($quickHtmlPath -replace '\\','/')"
  & npx playwright pdf $fullFileUrl $fullPdfPath --browser="chromium" --channel="chrome" --paper-format="A4" --viewport-size="1240,1754" --wait-for-timeout=1200
  Assert-NativeSuccess "Full user manual PDF generation"
  & npx playwright pdf $quickFileUrl $quickPdfPath --browser="chromium" --channel="chrome" --paper-format="A4" --viewport-size="1240,1754" --wait-for-timeout=1200
  Assert-NativeSuccess "Quick Start PDF generation"

  foreach ($route in $routes) {
    Publish-StagedFile (Join-Path $stageShotDir "$($route.name).png") (Join-Path $shotDir "$($route.name).png")
  }
  Publish-StagedFile $fullHtmlPath (Join-Path $outDir $fullHtmlName)
  Publish-StagedFile $fullPdfPath (Join-Path $outDir $fullPdfName)
  Publish-StagedFile $quickHtmlPath (Join-Path $outDir $quickHtmlName)
  Publish-StagedFile $quickPdfPath (Join-Path $outDir $quickPdfName)

  foreach ($role in @("employee", "hr", "webmaster", "it")) {
    $legacyStoragePath = Join-Path $shotDir "$role-storage.json"
    if (Test-Path -LiteralPath $legacyStoragePath -PathType Leaf) {
      Remove-Item -LiteralPath $legacyStoragePath -Force
    }
  }

  $artifactPaths = @(
    (Join-Path $outDir $fullHtmlName),
    (Join-Path $outDir $fullPdfName),
    (Join-Path $outDir $quickHtmlName),
    (Join-Path $outDir $quickPdfName)
  ) + ($routes | ForEach-Object { Join-Path $shotDir "$($_.name).png" })

  $manifest = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    applicationRevision = $revision
    captureMode = $captureMode
    baseUrl = $resolvedBaseUrl
    sources = @(
      [ordered]@{ path = "docs/USER_MANUAL.md"; sha256 = (Get-FileHash -Algorithm SHA256 $fullMdPath).Hash },
      [ordered]@{ path = "docs/QUICK_START_MANUAL.md"; sha256 = (Get-FileHash -Algorithm SHA256 $quickMdPath).Hash }
    )
    artifacts = @($artifactPaths | ForEach-Object {
      $absoluteArtifactPath = [IO.Path]::GetFullPath($_)
      $relativeArtifactPath = $absoluteArtifactPath.Substring($resolvedWorkspacePrefix.Length).Replace("\", "/")
      [ordered]@{
        path = $relativeArtifactPath
        sha256 = (Get-FileHash -Algorithm SHA256 $_).Hash
      }
    })
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path (Join-Path $outDir "manual-build-manifest.json")

  Write-Host "Generated full manual PDF: $(Join-Path $outDir $fullPdfName)"
  Write-Host "Generated Quick Start PDF: $(Join-Path $outDir $quickPdfName)"
  Write-Host "Capture mode: $captureMode"
} finally {
  Remove-Item Env:MANUAL_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:MANUAL_SCREENSHOT_DIR -ErrorAction SilentlyContinue

  if (Test-Path -LiteralPath $stageRoot) {
    $cleanupPath = [IO.Path]::GetFullPath($stageRoot)
    if (!$cleanupPath.StartsWith($resolvedWorkspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean an unexpected staging path: $cleanupPath"
    }
    Remove-Item -LiteralPath $cleanupPath -Recurse -Force
  }
}
