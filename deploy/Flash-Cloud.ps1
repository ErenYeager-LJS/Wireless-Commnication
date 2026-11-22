param([Parameter(Mandatory=$true)][ValidateSet('CAM','Repeater')][string]$Project,[Parameter(Mandatory=$true)][string]$Port,[string]$PythonExe='python')
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path "$PSScriptRoot/buffer/temp" | Out-Null
$env:TEMP="$PSScriptRoot/buffer/temp"; $env:TMP=$env:TEMP
$Dir=Join-Path $PSScriptRoot $Project
$Manifest=Get-Content -LiteralPath "$Dir/manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$EsptoolArgs=@('-m','esptool','--chip',$Manifest.chip,'--port',$Port,'--baud','230400','write_flash')
foreach($Setting in $Manifest.flash_settings.PSObject.Properties) { $EsptoolArgs+=@('--'+$Setting.Name,$Setting.Value) }
foreach($Entry in $Manifest.files) {
  $File=Join-Path $Dir $Entry.file
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.sha256) { throw 'Firmware SHA256 mismatch' }
  $EsptoolArgs+=@($Entry.offset,$File)
}
& $PythonExe @EsptoolArgs
if ($LASTEXITCODE -ne 0) { throw 'Flashing failed' }
