param(
  [int]$BasePort = 0,
  [string]$NodePath = "C:\Program Files\nodejs\node.exe",
  [switch]$KeepArtifacts
)

$scriptPath = Join-Path $PSScriptRoot 'smoke-regression.mjs'
$args = @($scriptPath)
if ($BasePort -gt 0) {
  $args += '--base-port'
  $args += "$BasePort"
}
if ($KeepArtifacts) {
  $args += '--keep-artifacts'
}

& $NodePath @args
exit $LASTEXITCODE
