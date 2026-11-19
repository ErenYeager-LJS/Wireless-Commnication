"""Local, latest-frame person detection. Never runs on the video/ACK thread.

YOLOX decoding/letterboxing follows OpenCV Zoo (Apache-2.0), adapted to
person-only results, ONNX Runtime, and normalized upright display coordinates.
"""
from collections import deque
import hashlib
from pathlib import Path
import threading
import time

import cv2
import numpy as np

MODEL_PATH = Path(__file__).parent / 'models' / 'person-yolox.onnx'
MODEL_SHA256 = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063'
RESULT_TTL = 0.7


def decode_people(output, width, height, confidence=0.45, iou=0.45):
    """Convert YOLOX raw 640x640 output to normalized upright xywh boxes."""
    raw = np.asarray(output)[0]
    if raw.shape != (8400, 85) or not np.isfinite(raw).all():
        raise ValueError('invalid YOLOX output')
    # COCO class 0 is person. Avoid decoding thousands of background boxes.
    scores = raw[:, 4] * raw[:, 5]
    selected = np.flatnonzero((scores >= confidence) & (raw[:, 5:].argmax(axis=1) == 0))
    if not len(selected):
        return []
    grids, strides = [], []
    for stride in (8, 16, 32):
        y, x = np.mgrid[:640 // stride, :640 // stride]
        grids.append(np.stack((x, y), axis=-1).reshape(-1, 2))
        strides.append(np.full((x.size, 1), stride))
    grid = np.concatenate(grids)[selected]
    stride = np.concatenate(strides)[selected]
    pred = raw[selected]
    center = (pred[:, :2] + grid) * stride
    size = np.exp(np.clip(pred[:, 2:4], -16, 16)) * stride
    ratio = min(640 / width, 640 / height)
    xy1 = np.clip((center - size / 2) / ratio, (0, 0), (width, height))
    xy2 = np.clip((center + size / 2) / ratio, (0, 0), (width, height))
    boxes = np.concatenate((xy1, xy2 - xy1), axis=1)
    valid = (boxes[:, 2] >= 2) & (boxes[:, 3] >= 2)
    boxes, scores = boxes[valid], scores[selected][valid]
    if not len(boxes):
        return []
    keep = np.asarray(cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), confidence, iou)).reshape(-1)
    return [dict(x=round(float(boxes[i, 0] / width), 6),
                 y=round(float(boxes[i, 1] / height), 6),
                 width=round(float(boxes[i, 2] / width), 6),
                 height=round(float(boxes[i, 3] / height), 6),
                 confidence=round(float(scores[i]), 3)) for i in keep[:20]]


class YoloXPeople:
    def __init__(self, path=MODEL_PATH):
        import onnxruntime as ort
        path = Path(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError('person model SHA-256 does not match manifest')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        self.session = ort.InferenceSession(str(path), sess_options=options,
                                           providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, upright_bgr):
        h, w = upright_bgr.shape[:2]
        ratio = min(640 / w, 640 / h)
        resized = cv2.resize(upright_bgr, (int(w * ratio), int(h * ratio)))
        # Zoo model consumes RGB float32 values in 0..255, with top-left padding.
        padded = np.full((640, 640, 3), 114, np.float32)
        padded[:resized.shape[0], :resized.shape[1]] = resized[:, :, ::-1]
        blob = np.ascontiguousarray(padded.transpose(2, 0, 1)[None])
        output = self.session.run(None, {self.input_name: blob})[0]
        return decode_people(output, w, h)


class PersonDetector:
    def __init__(self, store, factory=YoloXPeople, max_fps=10, clock=time.monotonic):
        self.store, self.clock = store, clock
        self.factory, self.interval = factory, 1 / max_fps
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.enabled = True
        self.generation = 0
        self.ready = False
        self.error = None
        self.result = None
        self.completions = deque(maxlen=60)
        self.thread = threading.Thread(target=self._run, name='person-detection', daemon=True)

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.stop.set()
        with self.store.condition:
            self.store.condition.notify_all()
        if self.thread.is_alive():
            self.thread.join(2)

    def set_enabled(self, enabled):
        with self.lock:
            self.enabled = enabled
            self.generation += 1
            self.result = None
            self.completions.clear()
        return self.status()

    def status(self):
        now = self.clock()
        with self.lock:
            result = self.result
            enabled, ready, error = self.enabled, self.ready, self.error
            times = [t for t in self.completions if now - t < 3]
        with self.store.condition:
            source_online = (self.store.enabled and self.store.received_at is not None
                             and self.store.clock() - self.store.received_at < self.store.stale_after)
            boot = self.store.metadata.get('boot_id')
        age = None if result is None else now - result['source_at']
        fresh = bool(enabled and source_online and result and result['boot_id'] == boot
                     and age < RESULT_TTL)
        state = ('disabled' if not enabled else 'error' if error else 'loading' if not ready
                 else 'waiting' if not source_online else 'active' if fresh else 'warming')
        hz = ((len(times) - 1) / (now - times[0])
              if fresh and len(times) > 1 and now > times[0] else 0)
        return dict(enabled=enabled, ready=ready, state=state, error=error,
                    boxes=result['boxes'] if fresh else [],
                    count=len(result['boxes']) if fresh else None,
                    fresh=fresh, age_ms=None if age is None else round(age * 1000),
                    inference_ms=result['inference_ms'] if result else None,
                    fps=round(hz, 1), max_fps=round(1 / self.interval), ttl_ms=round(RESULT_TTL * 1000),
                    frame_id=result['frame_id'] if result else None,
                    boot_id=result['boot_id'] if result else None,
                    rotation_degrees=180, coordinates='normalized_upright',
                    model='YOLOX-S COCO / person', processor='PC / ONNX Runtime CPU')

    def _run(self):
        try:
            engine = self.factory()
            with self.lock:
                self.ready = True
        except Exception as exc:
            with self.lock:
                self.error = f'{type(exc).__name__}: {exc}'
            print(f'Person detection unavailable: {self.error}', flush=True)
            return
        last_version = -1
        while not self.stop.is_set():
            with self.lock:
                enabled, generation = self.enabled, self.generation
            if not enabled:
                self.stop.wait(.1)
                continue
            with self.store.condition:
                self.store.condition.wait_for(lambda: self.stop.is_set() or self.store.stopping
                                              or self.store.version != last_version, timeout=.2)
                if self.stop.is_set() or self.store.stopping:
                    break
                if self.store.version == last_version:
                    continue
                last_version = self.store.version
                jpeg, metadata, received_at = self.store.jpeg, self.store.metadata.copy(), self.store.received_at
                # The source store and detector use monotonic clocks. Capture a
                # detector timestamp without assuming identical test clocks.
                age = None if received_at is None else self.store.clock() - received_at
                source_at = self.clock() - age if age is not None else None
                valid = self.store.enabled and jpeg and age is not None and age < RESULT_TTL
            if not valid:
                self.stop.wait(.05)
                continue
            started = self.clock()
            try:
                raw = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                if raw is None:
                    raise ValueError('invalid source JPEG')
                # Match the existing CSS 180-degree rotation before inference.
                upright = cv2.rotate(raw, cv2.ROTATE_180)
                boxes = engine.detect(upright)
                finished = self.clock()
                result = dict(boxes=boxes, source_at=source_at, boot_id=metadata['boot_id'],
                              frame_id=metadata['frame_id'], inference_ms=round((finished-started)*1000, 1))
                with self.lock:
                    if self.enabled and generation == self.generation:
                        self.error = None
                        self.result = result
                        self.completions.append(finished)
            except Exception as exc:
                with self.lock:
                    self.result = None
                    self.error = f'{type(exc).__name__}: {exc}'
            self.stop.wait(max(0, self.interval - (self.clock() - started)))
