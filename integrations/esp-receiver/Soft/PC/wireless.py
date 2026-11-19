"""Bounded, expiring wireless commands carried by camera-initiated UDP polls."""
import secrets
import threading
import time

MODES = {'auto': 0, 'direct': 1, 'relay': 2}
MODE_NAMES = {v: k for k, v in MODES.items()}


def parse_report(data):
    if len(data) != 51:
        return None
    try:
        kind, boot, sequence, applied, mode, mask = data.decode('ascii').split(' ')
        if kind not in ('ECP1', 'ECA1') or len(boot) != 16 or len(sequence) != 8 or len(applied) != 16:
            return None
        if any(c not in '0123456789abcdef' for c in boot + sequence + applied):
            return None
        if mode not in ('0', '1', '2') or mask not in ('0', '1'):
            return None
        return kind, boot, sequence, int(applied, 16), int(mode), int(mask)
    except (ValueError, UnicodeError):
        return None


class RouteController:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.condition = threading.Condition()
        self.pending = None
        self.boot = None
        self.last_mode = None
        self.camera_mask = 1
        self.last_seen = None
        self.peer = None
        self.stores = None

    def attach(self, stores):
        self.stores = stores

    def _state_matches(self, command, mode, mask):
        if command['op'] == 1:
            return mode == command['value']
        return bool(mask & (1 << (command['op'] - 2))) == bool(command['value'])

    def handle(self, data, peer):
        report = parse_report(data)
        if report is None:
            return None
        kind, boot, sequence, applied, mode, mask = report
        now = self.clock()
        with self.condition:
            # One physical camera host. Don't let unrelated clients replace a
            # live session. An unsolicited ACK cannot discover a new device.
            if self.boot != boot:
                if kind != 'ECP1' or (self.last_seen is not None and now - self.last_seen < 3):
                    return None
                if self.pending is not None:
                    self.pending['error'] = '摄像头已重启，请重新发送指令'
                self.boot = boot
            self.last_seen, self.peer = now, peer
            self.last_mode = MODE_NAMES[mode]
            self.camera_mask = mask
            if self.stores is not None:
                for bit, camera in enumerate(('mipi',)):
                    value = bool(mask & (1 << bit))
                    if self.stores[camera].enabled != value:
                        self.stores[camera].set_enabled(value)
            command = self.pending
            if command is not None and command['boot'] == boot and applied == command['id']:
                if self._state_matches(command, mode, mask):
                    command['acknowledged'] = True
                else:
                    command['error'] = '设备回执状态与指令不一致，请重试'
            self.condition.notify_all()
            if kind == 'ECA1':
                return None
            if (command is None or command['acknowledged'] or command.get('error')
                    or now >= command['deadline'] or command['boot'] != boot):
                identity, op, value = 0, 0, 0
            else:
                identity, op, value = command['id'], command['op'], command['value']
            return f'ECS1 {boot} {sequence} {identity:016x} {op} {value}'.encode('ascii')

    def _command(self, op, value, timeout=5.5):
        with self.condition:
            if self.pending is not None:
                raise RuntimeError('上一条无线指令正在发送，请稍候')
            if self.boot is None or self.last_seen is None:
                raise RuntimeError('未收到摄像头无线心跳，请确认摄像头和接收电脑在同一网络')
            command = dict(id=secrets.randbits(64) or 1, op=op, value=value,
                           boot=self.boot, deadline=self.clock()+timeout, acknowledged=False)
            self.pending = command
            try:
                while not command['acknowledged'] and not command.get('error'):
                    remaining = command['deadline']-self.clock()
                    if remaining <= 0:
                        raise RuntimeError('无线指令未收到回执，请检查连接后重试；设备可能已执行，请以当前路径为准')
                    self.condition.wait(timeout=remaining)
                if command.get('error'):
                    raise RuntimeError(command['error'])
            finally:
                self.pending = None

    def switch(self, mode):
        self._command(1, MODES[mode])
        return {'ok': True, 'mode': mode, 'acknowledged': True, 'transport': 'wifi'}

    def camera(self, camera, enabled):
        if camera != 'mipi':
            raise ValueError('Unknown camera')
        self._command(2, int(enabled))
        return {'ok': True, 'camera': camera, 'enabled': enabled,
                'acknowledged': True, 'transport': 'wifi'}

    def state(self):
        with self.condition:
            age = None if self.last_seen is None else max(0, self.clock()-self.last_seen)
            return {'enabled': True, 'transport': 'wifi', 'last_mode': self.last_mode,
                    'wireless_online': age is not None and age < 3,
                    'heartbeat_age_ms': None if age is None else round(age*1000),
                    'cameras': {c: bool(self.camera_mask & (1 << bit))
                                for bit, c in enumerate(('mipi',))}}
