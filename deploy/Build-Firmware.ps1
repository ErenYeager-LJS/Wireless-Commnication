param([ValidateSet('CAM','Repeater')][string]$Project='CAM', [string]$OriginalSoft='E:/Agent_workplace/esp_image_relay_demo/Soft', [string]$SdkRoot='', [string]$BuildDirectory='')
$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
if (-not $SdkRoot) { $SdkRoot=Join-Path $OriginalSoft 'buffer/idf' }
$env:TEMP="$Root/buffer/temp"; $env:TMP=$env:TEMP
$env:PYTHONUTF8='1';$env:PYTHONDONTWRITEBYTECODE='1'
$env:IDF_TOOLS_PATH=$SdkRoot
$env:IDF_PATH=Join-Path $SdkRoot 'frameworks/esp-idf-v5.5.1'
$env:IDF_PYTHON_ENV_PATH=Join-Path $SdkRoot 'python_env/idf5.5_py3.11_env'
$env:ESP_ROM_ELF_DIR=Join-Path $SdkRoot 'tools/esp-rom-elfs/20241011'
$env:IDF_COMPONENT_MANAGER='0';$env:ESP_IDF_VERSION='5.5'
$env:CCACHE_DIR="$Root/buffer/cache/ccache"
$env:PATH="$SdkRoot/tools/ninja/1.12.1;$SdkRoot/tools/riscv32-esp-elf/esp-14.2.0_20241119/riscv32-esp-elf/bin;$SdkRoot/tools/xtensa-esp-elf/esp-14.2.0_20241119/xtensa-esp-elf/bin;$SdkRoot/tools/ccache/4.11.2/ccache-4.11.2-windows-x86_64;$SdkRoot/tools/cmake/3.30.2/bin;$SdkRoot/python_env/idf5.5_py3.11_env/Scripts;$env:PATH"
$IdfPython=Join-Path $SdkRoot 'python_env/idf5.5_py3.11_env/Scripts/python.exe'
$Build=if ($BuildDirectory) { $BuildDirectory } else { "$Root/buffer/cloud-firmware-$Project" }
New-Item -ItemType Directory -Force -Path "$Root/buffer/temp",$Build | Out-Null
Push-Location "$Root/integrations/esp-firmware/$Project"
try {
  & $IdfPython "$env:IDF_PATH/tools/idf.py" -B $Build "-DCLOUD_VENDOR_COMPONENTS=$OriginalSoft/buffer/components-p4" -DCCACHE_ENABLE=0 build
  if ($LASTEXITCODE -ne 0) { throw "Cloud $Project build failed" }
} finally { Pop-Location }
