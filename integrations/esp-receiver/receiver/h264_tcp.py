"""Decode framed native H.264. ACK only after real decode and JPEG publication.

The ESP sends complete Annex-B access units on TCP. No network frame skipping
is allowed inside a GOP; a new connection must start with an IDR and SPS/PPS.
"""
import socket
import struct
import threading
import time
import av
import cv2

HEADER = struct.Struct('!4sI16sQIHHhBB32s4x')
MAX_ACCESS_UNIT = 512 * 1024


def receive_exact(sock, size):
    data = bytearray(size)
    view = memoryview(data)
    used = 0
    while used < size:
        n = sock.recv_into(view[used:])
        if not n:
            raise EOFError('camera disconnected')
        used += n
    return data


class H264Receiver:
    def __init__(self, stores, jpeg_quality=85, decode_threads=2, timeout=3):
        self.stores = stores
        self.jpeg_quality, self.decode_threads, self.timeout = jpeg_quality, decode_threads, timeout
        self.counts = dict(connections=0, decoded=0, errors=0, bytes=0,
                           decode_ms=0.0, display_encode_ms=0.0)
        self.lock = threading.Lock()
        self.active = None

    def connection(self, sock, peer):
        with self.lock:
            previous = self.active
            self.active = sock
            if previous is not None:
                try:
                    previous.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self.counts['connections'] += 1
        decoder = av.CodecContext.create('h264', 'r')
        decoder.thread_count = self.decode_threads
        decoder.thread_type = 'SLICE'
        sock.settimeout(self.timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        first = True
        try:
            while True:
                fields = HEADER.unpack(receive_exact(sock, HEADER.size))
                magic, size, boot, number, capture_ms, width, height, rssi, relay, idr, ssid = fields
                if magic != b'EHV1' or not 4 <= size <= MAX_ACCESS_UNIT:
                    raise ValueError('invalid access unit header')
                if width < 80 or height < 80 or width * height > 1920 * 2048:
                    raise ValueError('invalid coded resolution')
                if relay not in (0, 1) or idr not in (0, 1) or not -127 <= rssi <= 0:
                    raise ValueError('invalid route or signal metadata')
                if any(c not in b'0123456789abcdef' for c in boot):
                    raise ValueError('invalid camera boot identifier')
                if first and not idr:
                    raise ValueError('new stream must begin at IDR')
                first = False
                payload = receive_exact(sock, size)
                self.counts['bytes'] += size
                start = time.perf_counter()
                frames = decoder.decode(av.Packet(payload))
                self.counts['decode_ms'] = round((time.perf_counter()-start)*1000, 2)
                if len(frames) != 1:
                    raise ValueError('expected exactly one decoded picture per access unit')
                frame = frames[0]
                if (frame.width, frame.height) != (width, height):
                    raise ValueError('actual decoded size differs from camera metadata')
                start = time.perf_counter()
                ok, jpg = cv2.imencode('.jpg', frame.to_ndarray(format='bgr24'),
                                       [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
                if not ok:
                    raise ValueError('display JPEG encode failed')
                self.counts['display_encode_ms'] = round((time.perf_counter()-start)*1000, 2)
                metadata = dict(frame_id=number, boot_id=boot.decode('ascii'),
                                camera_id='mipi', camera='ESP32-P4 + OV5647',
                                route='relay' if relay else 'direct', rssi=rssi,
                                ssid=ssid.rstrip(b'\0').decode('utf8'), simulated=False,
                                width=frame.width, height=frame.height,
                                resolution=f'{frame.width}x{frame.height}', source_ip=peer[0],
                                codec='H.264 hardware', capture_ms=capture_ms,
                                encoded_bytes=size, transport='H264/TCP')
                with self.lock:
                    if self.active is not sock:
                        break
                    if self.stores['mipi'].publish(jpg.tobytes(), metadata):
                        self.counts['decoded'] += 1
                sock.sendall(struct.pack('!I', number & 0xffffffff))
        except (EOFError, OSError):
            pass
        except Exception as exc:
            self.counts['errors'] += 1
            print(f'H264 {peer}: {type(exc).__name__}: {exc}', flush=True)
        finally:
            sock.close()
            with self.lock:
                if self.active is sock:
                    self.active = None

    def serve(self, stop, port=8082):
        with socket.socket() as listener:
            if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(('0.0.0.0', port))
            listener.listen(2)
            listener.settimeout(.3)
            print(f'Native hardware H264 TCP :{port} ready', flush=True)
            while not stop.is_set():
                try:
                    sock, peer = listener.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self.connection, args=(sock, peer), daemon=True).start()
