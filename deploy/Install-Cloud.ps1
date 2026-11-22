param([string]$InstallRoot=(Split-Path $PSScriptRoot -Parent), [string]$PythonExe='', [string]$NodeExe='', [string[]]$ViewerSources=@('Any'), [string[]]$SiteSources=@('Any'), [switch]$SkipDependencies)
$ErrorActionPreference='Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator.' }
$InstallRoot=(Resolve-Path -LiteralPath $InstallRoot).Path
if ($InstallRoot -match '["\r\n]') { throw 'Invalid install path.' }
$Private=Join-Path $InstallRoot 'deploy/private'
$Configuration=Join-Path $Private 'cloud.json'
if (-not (Test-Path -LiteralPath $Configuration)) { throw 'Copy the matching private configuration kit into deploy/private first.' }
$Config=Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path "$InstallRoot/buffer/temp","$InstallRoot/buffer/cache/pip","$InstallRoot/buffer/cache/npm","$InstallRoot/data","$InstallRoot/logs" | Out-Null
$env:TEMP="$InstallRoot/buffer/temp"; $env:TMP=$env:TEMP
$env:PIP_CACHE_DIR="$InstallRoot/buffer/cache/pip"; $env:npm_config_cache="$InstallRoot/buffer/cache/npm"
$env:PYTHONUTF8='1'; $env:PYTHONDONTWRITEBYTECODE='1'
if (-not $PythonExe) { $PythonExe=(Get-Command python.exe -ErrorAction Stop).Source }
if (-not $NodeExe) { $NodeExe=(Get-Command node.exe -ErrorAction Stop).Source }
if ($PythonExe -match 'WindowsApps') { throw 'Select a real Python installation with -PythonExe.' }
& $PythonExe -c 'import sys; assert sys.version_info >= (3,12)'
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12+ required.' }
& $NodeExe (Join-Path $PSScriptRoot 'check-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.13+ required (24 LTS recommended).' }
if (-not $SkipDependencies) {
  & $PythonExe -m venv "$InstallRoot/.venv"
  if ($LASTEXITCODE -ne 0) { throw 'venv failed' }
  $VenvPython="$InstallRoot/.venv/Scripts/python.exe"
  & $VenvPython -m pip install -r "$InstallRoot/deploy/requirements-cloud.txt"
  if ($LASTEXITCODE -ne 0) { throw 'Cloud Python dependencies failed' }
  Push-Location $InstallRoot
  try { & (Join-Path (Split-Path $NodeExe) 'npm.cmd') ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location }
} else { $VenvPython="$InstallRoot/.venv/Scripts/python.exe" }
if (-not (Test-Path -LiteralPath $VenvPython)) { throw 'Missing project venv.' }
# Apply inheritable rules only to directories. Applying (OI)(CI) recursively
# while removing inheritance can leave leaf files with an empty ACL.
foreach($Directory in @($Private)+@(Get-ChildItem -LiteralPath $Private -Directory -Recurse | Select-Object -ExpandProperty FullName)) {
  & icacls.exe $Directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict private directory' }
}
foreach($File in Get-ChildItem -LiteralPath $Private -File -Recurse) {
  & icacls.exe $File.FullName /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to grant intended service access to a private file' }
}
$Runtime=@{python=$VenvPython;node=$NodeExe;root=$InstallRoot} | ConvertTo-Json
[IO.File]::WriteAllText("$InstallRoot/data/runtime.json",$Runtime,(New-Object Text.UTF8Encoding($false)))
& "$PSScriptRoot/Stop-Cloud.ps1" -InstallRoot $InstallRoot
$Action=New-ScheduledTaskAction -Execute $VenvPython -Argument "-B `"$InstallRoot/deploy/supervisor.py`" --root `"$InstallRoot`"" -WorkingDirectory $InstallRoot
$Trigger=New-ScheduledTaskTrigger -AtStartup
$Principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'WirelessCommunicationCloud' -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
foreach ($Rule in @(@{Name='WirelessCloud-Web';Port=$Config.web_port;Protocol='TCP'},@{Name='WirelessCloud-Video';Port=$Config.device_port;Protocol='TCP'},@{Name='WirelessCloud-Control';Port=$Config.control_port;Protocol='UDP'})) {
  Get-NetFirewallRule -Name $Rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $Sources=if($Rule.Name -eq 'WirelessCloud-Web'){$ViewerSources}else{$SiteSources}
  New-NetFirewallRule -Name $Rule.Name -DisplayName $Rule.Name -Direction Inbound -Action Allow -Protocol $Rule.Protocol -LocalPort $Rule.Port -RemoteAddress $Sources -Profile Any | Out-Null
}
& "$PSScriptRoot/Start-Cloud.ps1" -InstallRoot $InstallRoot
Write-Host 'Installed SYSTEM startup task. Cloud-provider firewall rules still need configuration. Read deploy/云端部署说明.md.'
