"""Bounded, deadline-based JPEG reassembly with one XOR parity per four chunks.

Only complete checksum-valid real frames are published; nothing is replayed to
hide missing frames. A damaged frame never blocks the next frame.
"""
from collections import OrderedDict
import struct
import time

HEADER = struct.Struct('!4sBBH16sQIIHHhBB32s')
ACK = struct.Struct('!4sB16sQ')
CHUNK = 1000
GROUP = 4
MAX_FRAME = 256 * 1024
DEADLINE = .4


def checksum(data):
    value = 2166136261
    for byte in data:
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


class Reassembler:
    def __init__(self, stores, clock=time.monotonic):
        self.stores = stores
        self.clock = clock
        self.pending = OrderedDict()
        self.completed = OrderedDict()
        self.counts = dict(datagrams=0, received=0, recovered_chunks=0, expired=0, rejected=0)

    def expire(self):
        now = self.clock()
        for key, frame in list(self.pending.items()):
            if now - frame['started'] >= DEADLINE:
                del self.pending[key]
                self.counts['expired'] += 1
        for key, then in list(self.completed.items()):
            if now - then >= 2:
                del self.completed[key]

    def feed(self, data, peer):
        self.counts['datagrams'] += 1
        self.expire()
        if len(data) < HEADER.size:
            return None
        fields = HEADER.unpack_from(data)
        magic, camera, kind, index, boot, frame_id, size, crc, width, height, rssi, group, ssid_size, ssid = fields
        if (magic != b'EJR2' or camera != 0 or kind not in (0, 1)
                or not 4 <= size <= MAX_FRAME or group != GROUP or ssid_size > 32
                or not 0 < width <= 1920 or not 0 < height <= 1080
                or not -127 <= rssi <= 0 or frame_id >= 2**63):
            self.counts['rejected'] += 1
            return None
        try:
            boot_id = boot.decode('ascii')
            if len(boot_id) != 16 or any(c not in '0123456789abcdef' for c in boot_id):
                raise ValueError()
        except (UnicodeError, ValueError):
            return None
        chunks = (size + CHUNK - 1) // CHUNK
        payload = data[HEADER.size:]
        if kind == 0:
            if index >= chunks or len(payload) != min(CHUNK, size - index * CHUNK):
                return None
        elif index >= chunks or index % GROUP or len(payload) != CHUNK:
            return None
        key = (peer[0], peer[1], camera, boot, frame_id)
        ack = ACK.pack(b'EJA2', camera, boot, frame_id)
        if key in self.completed:
            return ack
        signature = (size, crc, width, height, rssi, ssid_size, ssid)
        frame = self.pending.get(key)
        if frame is None:
            while len(self.pending) >= 8:
                self.pending.popitem(last=False)
                self.counts['expired'] += 1
            frame = dict(started=self.clock(), signature=signature, data={}, parity={})
            self.pending[key] = frame
        elif frame['signature'] != signature:
            self.counts['rejected'] += 1
            return None
        frame['data' if kind == 0 else 'parity'][index] = payload
        for start, parity in frame['parity'].items():
            indices = range(start, min(start + GROUP, chunks))
            missing = [i for i in indices if i not in frame['data']]
            if len(missing) != 1:
                continue
            restored = bytearray(parity)
            for i in indices:
                if i in frame['data']:
                    for j, value in enumerate(frame['data'][i]):
                        restored[j] ^= value
            i = missing[0]
            frame['data'][i] = bytes(restored[:min(CHUNK, size - i * CHUNK)])
            self.counts['recovered_chunks'] += 1
        if len(frame['data']) != chunks:
            return None
        jpeg = b''.join(frame['data'][i] for i in range(chunks))
        del self.pending[key]
        if (checksum(jpeg) != crc or not jpeg.startswith(b'\xff\xd8')
                or not jpeg.endswith(b'\xff\xd9')):
            self.counts['rejected'] += 1
            return None
        camera_id = 'mipi'
        metadata = dict(frame_id=frame_id, boot_id=boot_id, route='relay', rssi=rssi,
                        simulated=False, ssid=ssid[:ssid_size].decode('utf8', 'replace'),
                        source_ip=peer[0], camera='ESP32-P4 + OV5647',
                        camera_id=camera_id, resolution=f'{width}x{height}', transport='udp-fec')
        if not self.stores[camera_id].publish(jpeg, metadata):
            return None
        self.counts['received'] += 1
        self.completed[key] = self.clock()
        while len(self.completed) > 64:
            self.completed.popitem(last=False)
        return ack
