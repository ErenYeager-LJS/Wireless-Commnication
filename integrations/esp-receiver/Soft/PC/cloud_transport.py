"""Authenticated outbound-device transport. Never accepts LAN discovery packets."""
import hashlib
import hmac
import socket
import ssl
import threading

from wireless import parse_report


def seal(body, device, key):
    data = body + b'|' + device.encode('ascii')
    return data + b'|' + hmac.new(bytes.fromhex(key), data, hashlib.sha256).hexdigest().encode('ascii')


class SignedControl:
    def __init__(self, controller, device, key):
        self.controller, self.device, self.key = controller, device, key
        self.sequences = {}  # At most 256 authenticated boot sessions per server lifetime.
        self.lock = threading.Lock()

    def handle(self, packet, peer):
        if len(packet) > 180:
            return None
        try:
            body, device, mac = packet.rsplit(b'|', 2)
            if device != self.device.encode('ascii') or len(mac) != 64:
                return None
            if not hmac.compare_digest(seal(body, self.device, self.key), packet):
                return None
        except (ValueError, UnicodeError):
            return None
        report = parse_report(body)
        if report is None:
            return None
        kind, boot, sequence, *_ = report
        sequence = int(sequence, 16)
        with self.lock:
            previous = self.sequences.get(boot)
            if previous is None:
                if kind != 'ECP1' or len(self.sequences) >= 256:
                    return None
            elif kind == 'ECP1':
                advance = (sequence - previous[0]) & 0xffffffff
                if not 0 < advance < 0x80000000:
                    return None
            elif sequence != previous[0] or previous[1]:
                return None
            self.sequences[boot] = (sequence, kind == 'ECA1')
            response = self.controller.handle(body, peer)
            return seal(response, self.device, self.key) if response else None


def serve_control(stop, controller, settings, host='0.0.0.0'):
    signed = SignedControl(controller, settings['device_id'], settings['control_key'])
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((host, settings['control_port']))
        sock.settimeout(.25)
        if hasattr(socket, 'SIO_UDP_CONNRESET'):
            sock.ioctl(socket.SIO_UDP_CONNRESET, False)
        while not stop.is_set():
            try:
                data, peer = sock.recvfrom(256)
                reply = signed.handle(data, peer)
                if reply:
                    sock.sendto(reply, peer)
            except socket.timeout:
                continue
            except ConnectionResetError:
                continue


def serve_video(stop, receiver, settings, cert, key, host='0.0.0.0'):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    slots = threading.BoundedSemaphore(8)

    def connection(raw, peer):
        try:
            raw.settimeout(5)
            with context.wrap_socket(raw, server_side=True) as sock:
                header = bytearray()
                while len(header) < 2048 and not header.endswith(b'\r\n\r\n'):
                    part = sock.recv(1)
                    if not part:
                        return
                    header.extend(part)
                lines = bytes(header).decode('ascii').split('\r\n')
                fields = {}
                for line in lines[1:]:
                    if ':' in line:
                        k, v = line.split(':', 1)
                        if k.lower() in fields:
                            return
                        fields[k.lower()] = v.strip()
                expected = 'Bearer ' + settings['device_token']
                if (lines[0] != 'POST /h264 HTTP/1.1' or
                        not header.endswith(b'\r\n\r\n') or
                        fields.get('x-device-id') != settings['device_id'] or
                        not hmac.compare_digest(fields.get('authorization', ''), expected) or
                        fields.get('upgrade') != 'esp-h264' or fields.get('content-length') != '0'):
                    sock.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                    return
                sock.sendall(b'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: esp-h264\r\n\r\n')
                receiver.connection(sock, peer)
        except (OSError, ValueError, UnicodeError):
            pass
        finally:
            raw.close()
            slots.release()

    with socket.socket() as listener:
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind((host, settings['device_port']))
        listener.listen(8)
        listener.settimeout(.25)
        while not stop.is_set():
            try:
                raw, peer = listener.accept()
            except socket.timeout:
                continue
            if slots.acquire(blocking=False):
                threading.Thread(target=connection, args=(raw, peer), daemon=True).start()
            else:
                raw.close()
