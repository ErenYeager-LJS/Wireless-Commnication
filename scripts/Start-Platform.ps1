param(
  [ValidateSet('demo', 'real')]
  [string]$Mode = 'demo',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\platform.pid'
$LogFile = Join-Path $ProjectRoot 'logs\platform.log'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Node.js 20 or newer is required.'
}

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'data'), (Join-Path $ProjectRoot 'logs') | Out-Null

if (Test-Path $PidFile) {
  $ExistingPid = [int](Get-Content -Raw $PidFile)
  if (Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue) {
    Write-Host "Platform is already running. PID: $ExistingPid"
    if (-not $NoBrowser) { Start-Process 'http://localhost:8787' }
    exit 0
  }
}

if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) { npm install }
if (-not (Test-Path (Join-Path $ProjectRoot 'dist\index.html'))) { npm run build }

$env:DEMO_MODE = if ($Mode -eq 'demo') { 'true' } else { 'false' }
$NodeArgs = @((Join-Path $ProjectRoot 'node_modules\tsx\dist\cli.mjs'), (Join-Path $ProjectRoot 'server\index.ts'))
$Process = Start-Process -FilePath 'node' -ArgumentList $NodeArgs -WorkingDirectory $ProjectRoot -RedirectStandardOutput $LogFile -RedirectStandardError (Join-Path $ProjectRoot 'logs\platform-error.log') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ascii
Start-Sleep -Seconds 2

if ($Process.HasExited) { throw "Platform failed to start. Check: $LogFile" }
Write-Host "Platform started: http://localhost:8787 (mode: $Mode)"
if (-not $NoBrowser) { Start-Process 'http://localhost:8787' }
