$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\platform.pid'

if (-not (Test-Path $PidFile)) {
  Write-Host 'No running platform process was found.'
  exit 0
}

$PlatformPid = [int](Get-Content -Raw $PidFile)
$Process = Get-Process -Id $PlatformPid -ErrorAction SilentlyContinue
if ($Process) {
  Stop-Process -Id $PlatformPid
  $Process.WaitForExit(5000) | Out-Null
  Write-Host "Platform stopped. PID: $PlatformPid"
} else {
  Write-Host 'The recorded process has already exited.'
}
Remove-Item -LiteralPath $PidFile -Force
