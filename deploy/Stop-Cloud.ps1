param([string]$InstallRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path "$InstallRoot/data" -Force | Out-Null
Set-Content -LiteralPath "$InstallRoot/data/stop.flag" -Value 'stop' -Encoding ascii
for ($Attempt=0; $Attempt -lt 25; $Attempt++) {
  if (-not (Test-Path -LiteralPath "$InstallRoot/data/supervisor.pid")) { return }
  $TaskPid=[int](Get-Content -LiteralPath "$InstallRoot/data/supervisor.pid" -Raw)
  if (-not (Get-Process -Id $TaskPid -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath "$InstallRoot/data/supervisor.pid" -Force
    return
  }
  $TaskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$TaskPid"
  if ($TaskProcess.CommandLine -notmatch 'supervisor\.py') { throw 'Recorded PID belongs to another process; left untouched.' }
  Start-Sleep -Milliseconds 500
}
throw 'Supervisor did not stop within 12.5 s. Check logs before force-stopping the task.'
