$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'data\platform.pid'

if (Test-Path $PidFile) {
  $PlatformPid = [int](Get-Content -Raw $PidFile)
  $Process = Get-Process -Id $PlatformPid -ErrorAction SilentlyContinue
  if ($Process) {
    $Details = Get-CimInstance Win32_Process -Filter "ProcessId=$PlatformPid"
    if ($Details.CommandLine -notmatch 'server[/\\]index\.ts') { throw 'Recorded PID belongs to another process; left untouched.' }
    Stop-Process -Id $PlatformPid
    $Process.WaitForExit(5000) | Out-Null
    Write-Host "Platform stopped. PID: $PlatformPid"
  } else {
    Write-Host 'The recorded process has already exited.'
  }
  Remove-Item -LiteralPath $PidFile -Force
} else {
  Write-Host 'No running platform process was found.'
}

# Stop only the receiver launched by this project; an independently running
# receiver reused during startup has no ownership PID here.
$ReceiverPidFile = Join-Path $ProjectRoot 'data\esp-receiver.pid'
if (Test-Path $ReceiverPidFile) {
  $ReceiverPid = [int](Get-Content -Raw $ReceiverPidFile)
  $Details = Get-CimInstance Win32_Process -Filter "ProcessId=$ReceiverPid" -ErrorAction SilentlyContinue
  if ($Details -and $Details.CommandLine -match 'Soft[/\\]PC[/\\]server\.py' -and $Details.Name -match '^python') {
    Stop-Process -Id $ReceiverPid
    Write-Host "Owned ESP receiver stopped. PID: $ReceiverPid"
  } elseif ($Details) {
    throw 'Recorded receiver PID belongs to another process; left untouched.'
  }
  Remove-Item -LiteralPath $ReceiverPidFile -Force
}
