param(
  [ValidateSet('demo', 'real', 'esp32')]
  [string]$Mode = 'demo',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\platform.pid'
$LogFile = Join-Path $ProjectRoot 'logs\platform.log'
$TaskBuffer = Join-Path $ProjectRoot 'buffer'
New-Item -ItemType Directory -Force -Path (Join-Path $TaskBuffer 'temp'), (Join-Path $TaskBuffer 'cache\npm') | Out-Null
$env:TEMP = Join-Path $TaskBuffer 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $TaskBuffer 'cache\npm'
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Node.js 22.13+ (24 LTS recommended) is required.'
}
$NodeVersion = [version]((& node --version).TrimStart('v'))
if ($NodeVersion -lt [version]'22.13.0') { throw 'Node.js 22.13+ is required for built-in SQLite; use Node.js 24 LTS.' }

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'data'), (Join-Path $ProjectRoot 'logs') | Out-Null

if (Test-Path $PidFile) {
  $ExistingPid = [int](Get-Content -Raw $PidFile)
  if (Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue) {
    $Details = Get-CimInstance Win32_Process -Filter "ProcessId=$ExistingPid"
    if ($Details.CommandLine -notmatch 'server[/\\]index\.ts') { throw 'Recorded PID belongs to another process; left untouched.' }
    $Health = Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 2
    $ExpectedBackend = if ($Mode -eq 'esp32') { 'esp32' } else { 'mqtt' }
    if ($Health.backend -ne $ExpectedBackend -or $Health.demoMode -ne ($Mode -eq 'demo')) {
      throw 'A different platform mode is already running. Stop it with Stop-Platform.ps1 before changing modes.'
    }
    Write-Host "Platform is already running. PID: $ExistingPid"
    if (-not $NoBrowser) { Start-Process 'http://localhost:8787' }
    exit 0
  }
}

if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules'))) {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}
if (-not (Test-Path (Join-Path $ProjectRoot 'dist\index.html'))) {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}

if ($Mode -eq 'esp32') {
  & (Join-Path $PSScriptRoot 'Start-EspReceiver.ps1')
  if (-not $?) { throw 'ESP receiver failed to start.' }
}

$env:DEMO_MODE = if ($Mode -eq 'demo') { 'true' } else { 'false' }
$env:PLATFORM_BACKEND = if ($Mode -eq 'esp32') { 'esp32' } else { 'mqtt' }
$NodeArgs = @('--import', 'tsx', 'server/index.ts')
$Process = Start-Process -FilePath 'node' -ArgumentList $NodeArgs -WorkingDirectory $ProjectRoot -RedirectStandardOutput $LogFile -RedirectStandardError (Join-Path $ProjectRoot 'logs\platform-error.log') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ascii
Start-Sleep -Seconds 2

if ($Process.HasExited) { throw "Platform failed to start. Check: $LogFile" }
Write-Host "Platform started: http://localhost:8787 (mode: $Mode)"
if (-not $NoBrowser) { Start-Process 'http://localhost:8787' }
