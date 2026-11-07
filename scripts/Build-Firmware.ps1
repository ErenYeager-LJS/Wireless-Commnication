$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$PlatformIo = Join-Path $ProjectRoot '.venv\Scripts\platformio.exe'
$Builds = Join-Path $ProjectRoot 'firmware\builds'

if (-not (Test-Path $Python)) {
  python -m venv (Join-Path $ProjectRoot '.venv')
  & (Join-Path $ProjectRoot '.venv\Scripts\python.exe') -m pip install platformio
}

& $PlatformIo run --project-dir (Join-Path $ProjectRoot 'firmware\esp32-terminal')
if ($LASTEXITCODE -ne 0) { throw 'ESP32 terminal build failed.' }
& $PlatformIo run --project-dir (Join-Path $ProjectRoot 'firmware\esp32-camera')
if ($LASTEXITCODE -ne 0) { throw 'ESP32 camera build failed.' }

New-Item -ItemType Directory -Force -Path $Builds | Out-Null
Copy-Item (Join-Path $ProjectRoot 'firmware\esp32-terminal\.pio\build\esp32dev\firmware.bin') (Join-Path $Builds 'esp32-terminal-devkit-v1.bin') -Force
Copy-Item (Join-Path $ProjectRoot 'firmware\esp32-camera\.pio\build\esp32cam\firmware.bin') (Join-Path $Builds 'esp32-camera-ai-thinker.bin') -Force
Write-Host "Firmware builds are ready in: $Builds"
