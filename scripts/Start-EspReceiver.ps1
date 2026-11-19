param([string]$PythonExecutable = $env:ESP_PYTHON)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReceiverRoot = Join-Path $ProjectRoot 'integrations\esp-receiver'
$TaskBuffer = Join-Path $ProjectRoot 'buffer'
New-Item -ItemType Directory -Force -Path (Join-Path $TaskBuffer 'temp'), (Join-Path $TaskBuffer 'logs'), (Join-Path $TaskBuffer 'cache\pip'), (Join-Path $ProjectRoot 'data') | Out-Null
$env:TEMP = Join-Path $TaskBuffer 'temp'
$env:TMP = $env:TEMP
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'

# Reuse a compatible running receiver. Never start a second UDP discovery owner.
try {
  $Existing = Invoke-RestMethod 'http://127.0.0.1:8080/status' -TimeoutSec 2
  if ($null -eq $Existing.received) { throw 'Unrecognized service on port 8080.' }
  $Control = Invoke-RestMethod 'http://127.0.0.1:8080/control' -TimeoutSec 2
  if ($Control.transport -ne 'wifi') { throw 'Receiver lacks wireless controls.' }
  Write-Host 'Using running OV receiver on port 8080.'
  return
} catch {
  if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8080 is occupied by an incompatible service. It was left untouched.'
  }
}

if (-not $PythonExecutable) {
  $Python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $Python) { throw 'Python 3.10+ required. Install Python or set ESP_PYTHON to its executable.' }
  $PythonExecutable = $Python.Source
}
& $PythonExecutable -B -c 'import av, cv2, numpy, onnxruntime'
if ($LASTEXITCODE -ne 0) {
  & $PythonExecutable -m pip install --cache-dir (Join-Path $TaskBuffer 'cache\pip') -r (Join-Path $ReceiverRoot 'Soft\PC\requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Receiver dependencies could not be installed.' }
}
if (-not (Test-Path (Join-Path $ReceiverRoot 'receiver\models\person-yolox.onnx'))) {
  & $PythonExecutable -B (Join-Path $ReceiverRoot 'Soft\tools\setup_person_detection.py') --mirror
  if ($LASTEXITCODE -ne 0) { throw 'Person model download failed. See integrations/esp-receiver/README.md.' }
}
$Receiver = Start-Process -FilePath $PythonExecutable -ArgumentList '-B', 'Soft/PC/server.py' -WorkingDirectory $ReceiverRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $TaskBuffer 'logs\esp-receiver.out.log') -RedirectStandardError (Join-Path $TaskBuffer 'logs\esp-receiver.err.log') -PassThru
Set-Content -LiteralPath (Join-Path $ProjectRoot 'data\esp-receiver.pid') -Value $Receiver.Id -Encoding ascii
$Ready = $false
for ($Attempt = 0; $Attempt -lt 25; $Attempt++) {
  if ($Receiver.HasExited) { throw 'Receiver exited. Check buffer/logs/esp-receiver.err.log.' }
  try {
    $Status = Invoke-RestMethod 'http://127.0.0.1:8080/status' -TimeoutSec 1
    if ($null -ne $Status.received) { $Ready = $true; break }
  } catch { Start-Sleep -Milliseconds 300 }
}
if (-not $Ready) { throw 'Receiver did not become ready. Check buffer/logs/esp-receiver.err.log.' }
Write-Host "ESP receiver ready. PID: $($Receiver.Id)"
