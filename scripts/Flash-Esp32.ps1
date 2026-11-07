param(
  [ValidateSet('terminal', 'camera')]
  [string]$Target = 'terminal',
  [string]$Port = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PlatformIo = Join-Path $ProjectRoot '.venv\Scripts\platformio.exe'
$ProjectDir = if ($Target -eq 'camera') { Join-Path $ProjectRoot 'firmware\esp32-camera' } else { Join-Path $ProjectRoot 'firmware\esp32-terminal' }

if (-not (Test-Path $PlatformIo)) { throw 'Run scripts\Build-Firmware.ps1 first.' }
if ([string]::IsNullOrWhiteSpace($Port)) {
  $Ports = @(& $PlatformIo device list --json-output | ConvertFrom-Json | Where-Object { $_.port -match '^COM\d+$' })
  if ($Ports.Count -eq 0) { throw 'No serial port found. Connect ESP32 with a USB data cable and install its USB-UART driver.' }
  if ($Ports.Count -gt 1) { throw ('More than one serial port found: ' + (($Ports | ForEach-Object port) -join ', ') + '. Pass -Port COMx explicitly.') }
  $Port = $Ports[0].port
}

Write-Host "Flashing $Target firmware to $Port"
& $PlatformIo run --project-dir $ProjectDir --target upload --upload-port $Port
if ($LASTEXITCODE -ne 0) { throw 'Firmware upload failed.' }
Write-Host 'Firmware upload completed.'
