"""Exercise packaged runtime supervision on Windows without installing a task/firewall rule."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
import psutil

ROOT=Path(__file__).resolve().parents[1]
work=ROOT/'buffer/supervisor-validation'
work.mkdir(parents=True,exist_ok=True)
for folder,target in [('buffer/cloud-runtime','runtime'),('integrations/esp-receiver','integrations/esp-receiver'),('dist','dist')]:
    shutil.copytree(ROOT/folder,work/target,dirs_exist_ok=True,ignore=shutil.ignore_patterns('*.onnx','__pycache__','buffer'))
for name in ['deploy/private','data','logs']:(work/name).mkdir(parents=True,exist_ok=True)
config=json.loads((ROOT/'deploy/private/cloud.json').read_text())
def freeport():
    with socket.socket()as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
config.update(web_port=freeport(),device_port=freeport(),control_port=freeport(),certificate=str(ROOT/'deploy/private/server-cert.pem'),private_key=str(ROOT/'deploy/private/server-key.pem'))
(work/'deploy/private/cloud.json').write_text(json.dumps(config))
(work/'data/runtime.json').write_text(json.dumps(dict(python=sys.executable,node=shutil.which('node'))))
(work/'data/stop.flag').unlink(missing_ok=True)
# Node resolves the enclosing project's node_modules in this local fixture.
# A real server installation uses npm ci --omit=dev at its own root.
env={**os.environ,'TEMP':str(ROOT/'buffer/temp'),'TMP':str(ROOT/'buffer/temp'),'PYTHONDONTWRITEBYTECODE':'1','PYTHONUTF8':'1'}
log=open(work/'supervisor-test.log','wb')
child=subprocess.Popen([sys.executable,'-B',str(ROOT/'deploy/supervisor.py'),'--root',str(work)],env=env,stdout=log,stderr=subprocess.STDOUT)
report={'type':'local supervisor test; Windows SYSTEM startup/logoff/reboot not exercised'}
def health():
    return json.loads((work/'data/health.json').read_text())
try:
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        try:
            with urlopen('http://127.0.0.1:8080/status',timeout=1)as r:json.load(r)
            first=health()
            if 'web'in first and'video'in first:break
        except (OSError,ValueError):pass
        time.sleep(.25)
    else:raise RuntimeError('Supervisor failed to start both services')
    report['initial']=first
    pid=first['web']['pid'];process=psutil.Process(pid)
    if str(work/'runtime/server/index.js').lower()not in ' '.join(process.cmdline()).lower():raise RuntimeError('Child PID ownership mismatch')
    process.terminate()
    deadline=time.monotonic()+18
    while time.monotonic()<deadline:
        current=health()
        if current.get('web',{}).get('pid',pid)!=pid:break
        time.sleep(.25)
    else:raise RuntimeError('Dead web process was not restarted')
    report['restarted']=current['web']['pid']!=pid
    (work/'data/stop.flag').write_text('stop')
    child.wait(15)
    report['stopped']=not(work/'data/supervisor.pid').exists()
    report['passed']=report['restarted']and report['stopped']and child.returncode==0
finally:
    (work/'data/stop.flag').write_text('stop')
    if child.poll()is None:
        try:child.wait(15)
        except subprocess.TimeoutExpired:child.kill()
    log.close()
    (ROOT/'buffer/supervisor-test-result.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
