"""Cloud receiver: TLS video + signed UDP, private loopback HTTP, inference off."""
import argparse
import json
import os
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from receiver.server import DemoServer, FrameStore
from receiver.h264_tcp import H264Receiver
from control import ControlHandler
from wireless import RouteController
from cloud_transport import serve_control, serve_video


class DisabledDetector:
    def status(self):
        return dict(enabled=False, ready=False, fresh=False, state='disabled', boxes=[], count=None,
                    fps=0, error=None, ttl_ms=700, model='YOLOX (not loaded)', processor='Cloud / inference disabled')

    def set_enabled(self, enabled):
        if enabled:
            raise RuntimeError('云端首阶段已禁用推理，请先核对服务器内存并安装检测依赖')
        return self.status()

    def close(self):
        pass


def main():
    import cv2
    cv2.setNumThreads(1)
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True)
    p.add_argument('--internal-port', type=int, default=8080)
    args = p.parse_args()
    filename = Path(args.config).resolve()
    settings = json.loads(filename.read_text(encoding='utf8'))
    if settings.get('detection_enabled') is not False:
        raise ValueError('This 2 GB first-stage profile requires detection_enabled=false')
    for name in ['device_token', 'control_key']:
        if len(settings[name]) != 64 or len(bytes.fromhex(settings[name])) != 32:
            raise ValueError('Invalid cloud device credentials')
    stop = threading.Event()
    server = DemoServer(('127.0.0.1', args.internal_port), FrameStore(2.0))
    server.stream_slots = threading.BoundedSemaphore(2)
    server.RequestHandlerClass = ControlHandler
    server.route_controller = RouteController()
    server.route_controller.attach(server.stores)
    server.relay_video = type('NoLegacyUDP', (), dict(counts={}, pending={}))()
    server.h264_video = H264Receiver(server.stores, jpeg_quality=72, decode_threads=1, timeout=5)
    server.person_detector = DisabledDetector()  # No model import, load or download.
    cert = filename.parent / settings['certificate']
    key = filename.parent / settings['private_key']
    workers = [
        threading.Thread(target=serve_video, args=(stop, server.h264_video, settings, cert, key), daemon=True),
        threading.Thread(target=serve_control, args=(stop, server.route_controller, settings), daemon=True),
    ]
    for worker in workers:
        worker.start()
    def watch():
        while not stop.wait(2):
            if any(not w.is_alive() for w in workers):
                print('Cloud transport listener stopped; supervisor must restart receiver', flush=True)
                os._exit(1)
    threading.Thread(target=watch, daemon=True).start()
    print('Cloud receiver started; private HTTP on loopback; inference disabled', flush=True)
    try:
        server.serve_forever(.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
