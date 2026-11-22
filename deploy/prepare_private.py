"""Create a private deployment identity and matching firmware headers. Never print credentials."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import secrets
import time


def prepare(root, host, wifi_config):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    ipaddress.IPv4Address(host)  # First deployment intentionally uses a fixed IPv4.
    private = root/'deploy/private'
    private.mkdir(parents=True, exist_ok=True)
    config_path = private/'cloud.json'
    if not config_path.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.now(timezone.utc)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1))
                .not_valid_after(now+timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(host), x509.IPAddress(ipaddress.ip_address(host))]), critical=False)
                .sign(key, hashes.SHA256()))
        (private/'server-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (private/'server-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (private/'server-cert.cer').write_bytes(cert.public_bytes(serialization.Encoding.DER))
        password = secrets.token_urlsafe(24)
        salt = secrets.token_hex(16)
        password_hash = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
        config = dict(public_host=host, web_port=443, device_port=8443, control_port=8081,
                      device_id='ov5647-1', device_token=secrets.token_hex(32), control_key=secrets.token_hex(32),
                      web_user='admin', password_salt=salt, password_hash=password_hash,
                      certificate='server-cert.pem', private_key='server-key.pem', detection_enabled=False)
        config_path.write_text(json.dumps(config, indent=2), encoding='utf8')
        fingerprint = cert.fingerprint(hashes.SHA256()).hex()
        (private/'LOGIN-PRIVATE.txt').write_text(f'Private cloud login; do not publish\nURL: https://{host}\nUsername: admin\nPassword: {password}\nCertificate SHA256: {fingerprint}\n', encoding='utf8')
    config = json.loads(config_path.read_text(encoding='utf8'))
    if config['public_host'] != host:
        raise ValueError('Existing private kit belongs to another host; refusing to overwrite it')
    firmware = root/'integrations/esp-firmware/common'
    cert_text = (private/'server-cert.pem').read_text(encoding='ascii')
    header = '// PRIVATE generated deployment identity. Do not commit.\n#pragma once\n'
    for name, value in [('CLOUD_HOST', host), ('CLOUD_DEVICE_ID', config['device_id']),
                        ('CLOUD_DEVICE_TOKEN', config['device_token']), ('CLOUD_CONTROL_KEY', config['control_key'])]:
        header += f'#define {name} {json.dumps(value)}\n'
    header += f'#define CLOUD_VIDEO_PORT {config["device_port"]}\n#define CLOUD_CONTROL_PORT {config["control_port"]}\n'
    header += f'#define CLOUD_BUILD_EPOCH {int(time.time())}\n'
    header += '#define CLOUD_CA '+json.dumps(cert_text)+'\n'
    (firmware/'cloud_config.h').write_text(header, encoding='utf8')
    wifi = json.loads(Path(wifi_config).read_text(encoding='utf8'))
    def literal(value):
        return '"'+''.join(f'\\x{b:02x}' for b in value.encode('utf8'))+'"'
    header = '// PRIVATE Wi-Fi configuration. Do not commit.\n#pragma once\n'
    for name, value in [('DEMO_PRIMARY_SSID',wifi['main_ssids'][0]),('DEMO_FALLBACK_SSID',wifi['main_ssids'][1]),
                        ('DEMO_MAIN_PASSWORD',wifi['main_password']),('DEMO_RELAY_SSID',wifi['relay_ssid']),('DEMO_RELAY_PASSWORD',wifi['relay_password'])]:
        header += f'#define {name} {literal(value)}\n'
    header += f'#define DEMO_RELAY_TX_POWER {int(wifi.get("relay_tx_power",44))}\n'
    (firmware/'secrets.h').write_text(header, encoding='utf8')
    print('Private identity and matching firmware headers prepared. Credentials were not printed.')


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--host',required=True);p.add_argument('--wifi-config',required=True)
    args=p.parse_args();prepare(Path(__file__).resolve().parents[1],args.host,args.wifi_config)
