param([string]$InstallRoot=(Split-Path $PSScriptRoot -Parent),[int]$WaitSeconds=30)
$ErrorActionPreference='Stop'
Remove-Item -LiteralPath "$InstallRoot/data/stop.flag" -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'WirelessCommunicationCloud'
$Configuration=Get-Content -LiteralPath "$InstallRoot/deploy/private/cloud.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$Deadline=(Get-Date).AddSeconds($WaitSeconds)
while((Get-Date) -lt $Deadline) {
  try {
    $Health=Get-Content -LiteralPath "$InstallRoot/data/health.json" -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    $Web=Get-NetTCPConnection -State Listen -LocalPort $Configuration.web_port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $Health.web.pid
    $Video=Get-NetTCPConnection -State Listen -LocalPort $Configuration.device_port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $Health.receiver.pid
    if($Web -and $Video) { Write-Host 'Cloud web and TLS video listeners are running. Run Health-Cloud.ps1 for details.';return }
  } catch { }
  Start-Sleep -Milliseconds 500
}
throw 'Task was started but the web/video listeners did not become ready. Run deploy/Health-Cloud.ps1 and inspect logs.'
