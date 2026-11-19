"""OV5647 局域网接收器，仅依赖 Python 3.10+ 标准库。"""
from __future__ import annotations

import argparse
from collections import deque
import csv
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import socket
import select
import threading
import time
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[1]
MAX_FRAME = 256 * 1024
MAX_CLIENTS = 8
MAX_REQUESTS = 32


class FrameStore:
    def __init__(self, stale_after=2.0, clock=time.monotonic):
        self.condition = threading.Condition()
        self.clock = clock
        self.stale_after = stale_after
        self.jpeg = None
        self.metadata = {}
        self.received_at = None
        self.version = 0
        self.arrivals = deque()
        self.loss_window = deque()
        self.session_received = 0
        self.session_missing = 0
        self.enabled = True
        self.events = deque(maxlen=100)
        self.event_id = 0
        self.offline_reported = False
        self.stopping = False

    def _event(self, kind, **data):
        self.event_id += 1
        self.events.appendleft({"id": self.event_id, "kind": kind,
                               "time": datetime.now(timezone.utc).isoformat(), **data})

    def _expire(self, now):
        if (self.received_at is not None and now - self.received_at >= self.stale_after
                and not self.offline_reported):
            self.offline_reported = True
            self._event("offline", route=self.metadata.get("route"))

    def publish(self, jpeg, metadata):
        with self.condition:
            now = self.clock()
            self._expire(now)
            previous = self.metadata
            new_session = not previous or previous['boot_id'] != metadata['boot_id']
            if not self.enabled and (not previous or not new_session):
                return True  # Acknowledge an upload already in flight when paused.
            if new_session:
                self.enabled = True
                self.session_received = self.session_missing = 0
                self.loss_window.clear()
            gap_ms = None if self.received_at is None else round((now - self.received_at) * 1000)
            if previous and previous["boot_id"] == metadata["boot_id"] and metadata["frame_id"] <= previous["frame_id"]:
                return False  # 拒绝重复帧和乱序帧，同一启动会话内帧号必须递增。
            if previous and (previous["boot_id"] != metadata["boot_id"] or self.offline_reported):
                self.arrivals.clear()
            if not previous or previous["boot_id"] != metadata["boot_id"]:
                self._event("session", route=metadata["route"], simulated=metadata["simulated"])
            elif previous["route"] != metadata["route"]:
                self._event("switch", route=metadata["route"], previous_route=previous["route"],
                            gap_ms=gap_ms, simulated=metadata["simulated"])
            elif self.offline_reported:
                self._event("resume", route=metadata["route"], gap_ms=gap_ms)
            self.jpeg = jpeg
            self.metadata = metadata
            self.received_at = now
            self.offline_reported = False
            self.version += 1
            missing = 0 if new_session else max(0, metadata['frame_id'] - previous['frame_id'] - 1)
            self.session_received += 1
            self.session_missing += missing
            if not new_session:
                self.loss_window.append((now, missing, missing + 1))
            while self.loss_window and now - self.loss_window[0][0] > 3:
                self.loss_window.popleft()
            self.arrivals.append(now)
            while self.arrivals and now - self.arrivals[0] > 3:
                self.arrivals.popleft()
            self.condition.notify_all()
            return True

    def set_enabled(self, enabled):
        with self.condition:
            self.enabled = enabled
            self.arrivals.clear()
            self.loss_window.clear()
            self.received_at = None
            if not enabled:
                self.jpeg = None
            self.condition.notify_all()

    def status(self):
        with self.condition:
            now = self.clock()
            self._expire(now)
            age = None if self.received_at is None else now - self.received_at
            online = self.enabled and age is not None and age < self.stale_after
            recent = [t for t in self.arrivals if now - t <= 3]
            fps = (len(recent) - 1) / (now - recent[0]) if online and len(recent) >= 2 and now > recent[0] else 0
            loss = [v for v in self.loss_window if now - v[0] <= 3]
            expected = sum(v[2] for v in loss)
            missing = sum(v[1] for v in loss)
            return {"online": online, "age_ms": None if age is None else round(age * 1000),
                    "enabled": self.enabled,
                    "fps": round(fps, 1), "received": self.version,
                    "frame_loss_percent": round(missing * 100 / expected, 1) if online and expected else None,
                    "frame_loss_window_s": 3,
                    "session_received": self.session_received, "session_missing": self.session_missing,
                    "loss_basis": "encoded_frame_sequence" if self.metadata.get("transport") == "H264/TCP"
                                  else "frame_sequence_including_latest_frame_drops",
                    "stale_after_ms": round(self.stale_after * 1000),
                    **self.metadata, "events": list(self.events)}


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = not hasattr(socket, 'SO_EXCLUSIVEADDRUSE')

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def __init__(self, address, store=None):
        self.store = store or FrameStore()
        self.stores = {"mipi": self.store}
        self.stream_slots = threading.BoundedSemaphore(MAX_CLIENTS)
        self.request_slots = threading.BoundedSemaphore(MAX_REQUESTS)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def server_close(self):
        for store in self.stores.values():
            with store.condition:
                store.stopping = True
                store.condition.notify_all()
        detector = getattr(self, 'person_detector', None)
        if detector is not None:
            detector.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle_one_request(self):
        self._body_read = 0
        return super().handle_one_request()

    def read_body(self, size):
        body = self.rfile.read(size)
        self._body_read += len(body)
        return body

    def setup(self):
        super().setup()
        self.connection.settimeout(3)
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith(("POST /frame", "GET /status", "GET /detection")):
            return
        super().log_message(fmt, *args)

    def send_body(self, code, body=b"", content_type="application/json; charset=utf-8", keep_alive=False):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "keep-alive" if keep_alive else "close")
        self.end_headers()
        self.close_connection = not keep_alive
        self.wfile.write(body)

    def error_json(self, code, message):
        # On Windows, closing with an unread request body can reset the TCP
        # connection before the client receives the error response.
        if self.command == 'POST':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self._body_read < size <= MAX_FRAME:
                    self.read_body(size - self._body_read)
                elif size > MAX_FRAME:
                    # Reject oversized declarations without trusting their
                    # length or allocating it. Drain only a bounded amount of
                    # already-arriving data, so Windows delivers our 413
                    # instead of resetting over a small unread request body.
                    previous_timeout = self.connection.gettimeout()
                    try:
                        self.connection.settimeout(.05)
                        remaining = min(size - self._body_read, MAX_FRAME + 8192)
                        until = time.monotonic() + .05
                        while remaining > 0 and time.monotonic() < until:
                            data = self.rfile.read1(min(8192, remaining))
                            if not data:
                                break
                            remaining -= len(data)
                            self._body_read += len(data)
                    except OSError:
                        pass
                    finally:
                        self.connection.settimeout(previous_timeout)
            except (ValueError, OSError):
                pass
        self.send_body(code, json.dumps({"error": message}).encode())

    def do_POST(self):
        if urlsplit(self.path).path != "/frame":
            return self.error_json(404, "unknown endpoint")
        if self.headers.get("Transfer-Encoding"):
            return self.error_json(400, "use Content-Length, not chunked upload")
        try:
            size = int(self.headers["Content-Length"])
            metadata = {"frame_id": int(self.headers["X-Frame-Id"]),
                        "boot_id": self.headers["X-Boot-Id"],
                        "route": self.headers["X-Route"],
                        "rssi": int(self.headers["X-RSSI"]),
                        "simulated": self.headers.get("X-Simulated", "0") == "1"}
            metadata["ssid"] = self.headers.get("X-SSID", "").encode("latin1").decode("utf8", "replace")[:32]
            metadata["source_ip"] = self.client_address[0]
            metadata["camera"] = self.headers.get("X-Camera", "ESP32-CAM")[:64]
            metadata["camera_id"] = self.headers.get("X-Camera-Id", "mipi")
            metadata["resolution"] = self.headers.get("X-Resolution", "320x240")[:24]
            if metadata["camera_id"] not in self.server.stores:
                raise ValueError("invalid camera id")
            if not 4 <= size <= MAX_FRAME:
                return self.error_json(413, "JPEG size outside 4..262144 bytes")
            if (metadata["route"] not in ("direct", "relay") or not 0 <= metadata["frame_id"] < 2**63
                    or not -127 <= metadata["rssi"] <= 0 or not metadata["boot_id"]
                    or len(metadata["boot_id"]) > 64
                    or self.headers.get_content_type() != "image/jpeg"):
                raise ValueError("invalid metadata")
        except (ValueError, TypeError):
            return self.error_json(400, "missing or invalid frame headers")
        try:
            jpeg = self.read_body(size)
        except (TimeoutError, OSError):
            return self.error_json(408, "upload timed out")
        if len(jpeg) != size or not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
            return self.error_json(400, "incomplete JPEG")
        # 此处仅检查边界和长度；浏览器负责解码，本服务不承诺检测全部 JPEG 损坏。
        if not self.server.stores[metadata["camera_id"]].publish(jpeg, metadata):
            return self.error_json(409, "duplicate or out-of-order frame")
        self.send_body(204, keep_alive=self.headers.get("Connection", "").lower() != "close")

    def do_GET(self):
        path = urlsplit(self.path).path
        camera = parse_qs(urlsplit(self.path).query).get("camera", ["mipi"])[0]
        if camera not in self.server.stores:
            return self.error_json(400, "unknown camera")
        store = self.server.stores[camera]
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8"),
                 "/tokens.css": ("tokens.css", "text/css; charset=utf-8")}
        if path in files:
            filename, content_type = files[path]
            return self.send_body(200, (Path(__file__).parent / "static" / filename).read_bytes(), content_type)
        if path == "/status":
            return self.send_body(200, json.dumps(store.status(), ensure_ascii=False).encode("utf-8"))
        if path == "/detection":
            detector = getattr(self.server, 'person_detector', None)
            if detector is None:
                return self.error_json(503, 'person detector is not configured')
            return self.send_body(200, json.dumps(detector.status(), ensure_ascii=False).encode('utf-8'))
        if path == "/events.csv":
            out = io.StringIO(newline="")
            fields = ["id", "time", "kind", "previous_route", "route", "gap_ms", "simulated"]
            writer = csv.DictWriter(out, fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(reversed(store.status()["events"]))
            return self.send_body(200, ("\ufeff" + out.getvalue()).encode("utf-8"), "text/csv; charset=utf-8")
        if path == "/stream":
            return self.stream(store)
        return self.error_json(404, "unknown endpoint")

    def stream(self, store):
        if not self.server.stream_slots.acquire(blocking=False):
            return self.error_json(503, "too many viewers")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            last_version = -1
            while not store.stopping:
                with store.condition:
                    store.condition.wait_for(lambda: store.stopping or store.version != last_version, timeout=1)
                    if store.stopping:
                        break
                    updated = store.version != last_version
                    last_version = store.version
                    jpeg = store.jpeg
                    fresh = store.enabled and store.received_at is not None and store.clock() - store.received_at < store.stale_after
                # 无新帧时不重复推送；浏览器离开后及时释放观看名额。
                if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                    break
                if jpeg is None or not fresh or not updated:
                    continue
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
            pass
        finally:
            self.server.stream_slots.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--stale-after", type=float, default=2.0)
    args = parser.parse_args()
    if args.stale_after <= 0:
        parser.error("--stale-after must be positive")
    server = DemoServer((args.host, args.port), FrameStore(args.stale_after))
    print(f"查看画面：http://127.0.0.1:{server.server_port}", flush=True)
    print("摄像头上传地址：把 127.0.0.1 换成这台电脑的路由器局域网 IPv4。Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
