"""Scheduled as SYSTEM at boot. Owns both children and bounded rotating logs."""
import argparse
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.request import urlopen


def logger(root, name):
    log = logging.getLogger(name)
    if log.handlers:
        return log
    log.setLevel(logging.INFO)
    handler = RotatingFileHandler(root / 'logs' / f'{name}.log', maxBytes=5*1024*1024, backupCount=3, encoding='utf8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    log.addHandler(handler)
    return log


def run(root):
    import psutil
    root = Path(root).resolve()
    for name in ['logs', 'data', 'buffer/temp', 'buffer/cache']:
        (root / name).mkdir(parents=True, exist_ok=True)
    runtime = json.loads((root / 'data/runtime.json').read_text(encoding='utf-8-sig'))
    log = logger(root, 'supervisor')
    lock = open(root / 'data/supervisor.lock', 'a+b')
    if os.name == 'nt':
        import msvcrt
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    (root / 'data/supervisor.pid').write_text(str(os.getpid()))
    flag = root / 'data/stop.flag'
    env = {**os.environ, 'PROJECT_ROOT':str(root), 'CLOUD_CONFIG':str(root/'deploy/private/cloud.json'),
           'PLATFORM_BACKEND':'esp32', 'DEMO_MODE':'false', 'ESP_RECEIVER_URL':'http://127.0.0.1:8080',
           'TEMP':str(root/'buffer/temp'), 'TMP':str(root/'buffer/temp'), 'PYTHONUTF8':'1', 'PYTHONDONTWRITEBYTECODE':'1',
           'OMP_NUM_THREADS':'1', 'OPENBLAS_NUM_THREADS':'1'}
    commands = {
        'receiver':[runtime['python'], '-B', '-u', str(root/'integrations/esp-receiver/Soft/PC/cloud_server.py'), '--config',env['CLOUD_CONFIG']],
        'web':[runtime['node'], str(root/'runtime/server/index.js')],
    }
    children = {}
    meters = {}
    def start(name):
        child = subprocess.Popen(commands[name], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        children[name] = child
        meters[name] = psutil.Process(child.pid)
        stream_log = logger(root, name)
        def capture():
            for line in iter(child.stdout.readline, b''):
                stream_log.info(line.decode('utf8', errors='replace').rstrip())
        threading.Thread(target=capture, daemon=True).start()
        log.info('%s started pid=%s', name, child.pid)
    try:
        for name in commands:
            start(name)
        while not flag.exists():
            health = {}
            for name, child in list(children.items()):
                if child.poll() is not None:
                    log.warning('%s exited status=%s; restarting in 3 seconds', name, child.returncode)
                    time.sleep(3)
                    if flag.exists(): break
                    start(name)
                try:
                    process = meters[name]
                    health[name] = {'pid':process.pid, 'cpu_percent':process.cpu_percent(), 'rss_mb':round(process.memory_info().rss/1048576,1)}
                except psutil.Error:
                    pass
            try:
                with urlopen('http://127.0.0.1:8080/status', timeout=2) as response:
                    video = json.load(response)
                health['video'] = {key:video.get(key) for key in ['online','fps','resolution','route','frame_loss_percent','age_ms']}
            except Exception:
                health['video'] = {'online':False}
            health['measured_at'] = datetime.now(timezone.utc).isoformat()
            health['system_memory_available_mb'] = round(psutil.virtual_memory().available/1048576,1)
            temp = root/'data/health.tmp'
            temp.write_text(json.dumps(health, ensure_ascii=False), encoding='utf8')
            temp.replace(root/'data/health.json')
            time.sleep(2)
    finally:
        for child in children.values():
            if child.poll() is None: child.terminate()
        for child in children.values():
            try: child.wait(8)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        (root/'data/supervisor.pid').unlink(missing_ok=True)
        lock.close()
        log.info('Owned services stopped')


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--root', required=True)
    run(p.parse_args().root)
