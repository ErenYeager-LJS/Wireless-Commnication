"""Allowlist deployment packaging. Server ZIP never contains private credentials or firmware."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT=Path(__file__).resolve().parents[1]


def write_zip(output, files):
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)as archive:
        for file,name in files:
            archive.write(file,name)


def main():
    p=argparse.ArgumentParser();p.add_argument('--camera-build',type=Path,default=ROOT/'buffer/cloud-firmware-CAM-short')
    args=p.parse_args()
    out=ROOT/'releases/cloud-20261122';out.mkdir(parents=True,exist_ok=True)
    files=[]
    for name in ['package.json','package-lock.json']:
        files.append((ROOT/name,name))
    for folder in ['dist','buffer/cloud-runtime','integrations/esp-receiver/receiver','integrations/esp-receiver/Soft/PC']:
        for file in (ROOT/folder).rglob('*'):
            if not file.is_file()or'__pycache__'in file.parts or file.suffix in ['.onnx','.pyc','.log']:continue
            if folder=='buffer/cloud-runtime':name='runtime/'+file.relative_to(ROOT/folder).as_posix()
            else:name=file.relative_to(ROOT).as_posix()
            files.append((file,name))
    for pattern in ['*.ps1','check-runtime.cjs','supervisor.py','measure_cloud.py','requirements-cloud.txt','*.md']:
        for file in (ROOT/'deploy').glob(pattern):files.append((file,'deploy/'+file.name))
    # Prevent accidental disclosure even if new files enter an allowlisted directory.
    private=json.loads((ROOT/'deploy/private/cloud.json').read_text())
    forbidden=[private['device_token'].encode(),private['control_key'].encode(),b'-----BEGIN PRIVATE KEY-----']
    for file,name in files:
        if any(marker in file.read_bytes()for marker in forbidden):raise ValueError('Secret material in server archive allowlist: '+name)
    write_zip(out/'Wireless-Cloud-Server-20261122.zip',files)
    write_zip(out/'PRIVATE-Server-Config-20261122.zip',[(file,'deploy/private/'+file.name)for file in (ROOT/'deploy/private').iterdir()if file.is_file()])
    firmware=[]
    for project,build in [('CAM',args.camera_build),('Repeater',ROOT/'buffer/cloud-firmware-Repeater')]:
        config=json.loads((build/'flasher_args.json').read_text())
        manifest={'project':project,'chip':'esp32p4'if project=='CAM'else'esp32','flash_settings':config['flash_settings'],'files':[]}
        for addr,name in config['flash_files'].items():
            file=(build/name).resolve()
            target=f'{project}/{file.name}';firmware.append((file,target))
            manifest['files'].append(dict(offset=addr,file=file.name,sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
        folder=out/'buffer'/project;folder.mkdir(parents=True,exist_ok=True)
        m=folder/'manifest.json';m.write_text(json.dumps(manifest,indent=2));firmware.append((m,f'{project}/manifest.json'))
    firmware.extend([(ROOT/'deploy/Flash-Cloud.ps1','Flash-Cloud.ps1'),(ROOT/'deploy/固件烧录与回退.md','固件烧录与回退.md')])
    write_zip(out/'PRIVATE-Cloud-Firmware-20261122.zip',firmware)
    (out/'SHA256SUMS.txt').write_text('\n'.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name for f in sorted(out.glob('*.zip')))+'\n')
    shutil.copy2(ROOT/'deploy/云端部署说明.md',out/'先读-云端部署说明.md')
    print('Server ZIP, separate private configuration kit, private firmware ZIP and SHA256SUMS generated in releases/cloud-20261122. No credentials printed.')


if __name__=='__main__':main()
