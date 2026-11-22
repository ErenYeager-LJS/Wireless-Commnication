"""Package the already-built provisioning firmware. Treat output as private."""
from pathlib import Path
import hashlib
import json
import zipfile
import ast
import re

ROOT = Path(__file__).resolve().parents[1]


def main():
    out = ROOT / 'releases/wifi-provision-20261122'
    out.mkdir(parents=True, exist_ok=True)
    archive = out / 'PRIVATE-WiFi-Provision-Firmware-20261122.zip'
    source=(ROOT/'integrations/esp-firmware/common/secrets.h').read_text(encoding='utf8')
    relay_password=ast.literal_eval(re.search(r'#define\s+DEMO_RELAY_PASSWORD\s+(".*?")',source).group(1))
    connection_info='摄像头热点：DEMO_CAM_SETUP_XXXX\n密码：esp32demo\n地址：http://192.168.5.1/\n\n中继热点：DEMO_RELAY\n密码：'+relay_password+'\n地址：http://192.168.4.1/\n'
    (out/'热点连接信息.txt').write_text(connection_info,encoding='utf8')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for project, folder, chip in [
            ('CAM', 'cloud-firmware-CAM-short', 'esp32p4'),
            ('Repeater', 'cloud-firmware-Repeater', 'esp32'),
        ]:
            build = ROOT / 'buffer' / folder
            args = json.loads((build / 'flasher_args.json').read_text(encoding='utf8'))
            manifest = {'project': project, 'chip': chip, 'flash_settings': args['flash_settings'], 'files': []}
            for offset, filename in args['flash_files'].items():
                file = build / filename
                z.write(file, f'{project}/{file.name}')
                manifest['files'].append({'offset': offset, 'file': file.name, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
            z.writestr(f'{project}/manifest.json', json.dumps(manifest, indent=2))
        z.write(ROOT / 'deploy/Flash-Cloud.ps1', 'Flash-Cloud.ps1')
        z.write(ROOT / 'deploy/手机配网说明.md', '手机配网说明.md')
        z.write(ROOT / 'deploy/手机配网验证-20261122.md', '手机配网验证-20261122.md')
        z.writestr('热点连接信息.txt',connection_info)
    (out / 'SHA256SUMS.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n', encoding='utf8')
    print('Private provisioning firmware archive generated; device credentials not printed.')


if __name__ == '__main__':
    main()
