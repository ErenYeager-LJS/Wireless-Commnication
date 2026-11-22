param([string]$InstallRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Continue'
Write-Host '=== Project ==='
Write-Host $InstallRoot
foreach($Name in @('deploy/private/cloud.json','deploy/private/server-cert.pem','deploy/private/server-key.pem','data/runtime.json','.venv/Scripts/python.exe','runtime/server/index.js','dist/index.html')) {
  [pscustomobject]@{File=$Name;Exists=(Test-Path -LiteralPath (Join-Path $InstallRoot $Name))} | Format-Table -AutoSize
}
Write-Host '=== Startup task ==='
$Task=Get-ScheduledTask -TaskName 'WirelessCommunicationCloud' -ErrorAction SilentlyContinue
if($Task) {
  $Task | Select-Object TaskName,State | Format-Table -AutoSize
  Get-ScheduledTaskInfo -TaskName 'WirelessCommunicationCloud' | Select-Object LastRunTime,LastTaskResult | Format-List
} else { Write-Host 'NOT INSTALLED: run Install-Cloud.ps1 as Administrator and check its final result.' }
Write-Host '=== Listening ports ==='
$Ports=@(443,8443,8080)
if(Test-Path -LiteralPath "$InstallRoot/deploy/private/cloud.json") {
  try { $Settings=Get-Content -LiteralPath "$InstallRoot/deploy/private/cloud.json" -Raw -Encoding UTF8 | ConvertFrom-Json; $Ports=@($Settings.web_port,$Settings.device_port,8080) } catch { Write-Host 'Cannot read cloud configuration.' }
}
$Listeners=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $Ports }
if($Listeners){$Listeners | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize}else{Write-Host 'NO cloud listening ports found.'}
Write-Host '=== Service health ==='
if(Test-Path -LiteralPath "$InstallRoot/data/health.json"){ Get-Content -LiteralPath "$InstallRoot/data/health.json" -Encoding UTF8 }else{ Write-Host 'No supervisor health report yet.' }
foreach($Name in @('supervisor','web','receiver')) {
  Write-Host "=== $Name log (last 15 lines) ==="
  $LogFile="$InstallRoot/logs/$Name.log"
  if(Test-Path -LiteralPath $LogFile){Get-Content -LiteralPath $LogFile -Tail 15 -Encoding UTF8}else{Write-Host 'No log file.'}
}
Write-Host 'Do not share private configuration, keys or LOGIN-PRIVATE.txt. Share only this diagnostic output.'
