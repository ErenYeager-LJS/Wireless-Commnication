param([string]$InstallRoot=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
& "$PSScriptRoot/Stop-Cloud.ps1" -InstallRoot $InstallRoot
Unregister-ScheduledTask -TaskName 'WirelessCommunicationCloud' -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -Name 'WirelessCloud-Web','WirelessCloud-Video','WirelessCloud-Control' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Task and project firewall rules removed. Sources, logs, private configuration and venv retained.'
