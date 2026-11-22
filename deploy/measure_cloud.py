"""Measure decoded video, MJPEG bytes/gaps and server resources on the server."""
import argparse
import http.client
import json
from pathlib import Path
import socket
import ssl
import threading
import time
from urllib.request import urlopen


def measure(root, seconds, output):
    settings=json.loads((root/'deploy/private/cloud.json').read_text(encoding='utf8'))
    login=(root/'deploy/private/LOGIN-PRIVATE.txt').read_text(encoding='utf8')
    password=next(line.removeprefix('Password: ')for line in login.splitlines()if line.startswith('Password: '))
    context=ssl.create_default_context(cafile=str(root/'deploy/private'/settings['certificate']))
    def connection():
        conn=http.client.HTTPConnection('127.0.0.1',settings['web_port'],timeout=4)
        conn.sock=context.wrap_socket(socket.create_connection(('127.0.0.1',settings['web_port']),timeout=4),server_hostname=settings['public_host'])
        return conn
    conn=connection()
    origin='https://'+settings['public_host']+(''if settings['web_port']==443 else ':'+str(settings['web_port']))
    conn.request('POST','/auth/login',body=json.dumps(dict(username=settings['web_user'],password=password)),headers={'Content-Type':'application/json','Origin':origin})
    response=conn.getresponse();cookie=response.getheader('Set-Cookie');response.read()
    if response.status!=200:raise RuntimeError('Cloud login failed')
    conn.close()
    report={'source':'server-side actual decoder and authenticated MJPEG, not browser rendering or glass-to-glass latency','samples':[]}
    count=0;received_bytes=0;arrivals=[];stop=threading.Event();errors=[]
    def stream():
        nonlocal count,received_bytes
        conn=connection()
        try:
            conn.request('GET','/api/esp/stream',headers={'Cookie':cookie})
            response=conn.getresponse()
            if response.status!=200:raise RuntimeError('MJPEG status '+str(response.status))
            pending=b'';marker=b'--frame\r\nContent-Type: image/jpeg\r\n'
            while not stop.is_set():
                chunk=response.read1(16384)
                if not chunk:break
                received_bytes+=len(chunk);pending+=chunk
                while marker in pending:
                    position=pending.index(marker);count+=1;arrivals.append(time.monotonic());pending=pending[position+len(marker):]
                pending=pending[-len(marker):]
        except (OSError,ValueError,RuntimeError)as exc:
            if not stop.is_set():errors.append(type(exc).__name__+': '+str(exc))
        finally:conn.close()
    def status():
        with urlopen('http://127.0.0.1:8080/status',timeout=3)as response:return json.load(response)
    before=status();start=time.monotonic()
    thread=threading.Thread(target=stream,daemon=True);thread.start()
    while time.monotonic()-start<seconds:
        video=status()
        health=json.loads((root/'data/health.json').read_text(encoding='utf8'))if(root/'data/health.json').exists()else None
        report['samples'].append(dict(video=video,resources=health))
        time.sleep(.5)
    stop.set();end=time.monotonic();thread.join(5);after=status();elapsed=end-start
    gaps=[b-a for a,b in zip([start]+arrivals,arrivals+[end])]
    report['measurement']=dict(seconds=elapsed,receiver_fps=(after['received']-before['received'])/elapsed,
        mjpeg_fps=count/elapsed,mjpeg_megabits_per_second=received_bytes*8/elapsed/1e6,max_no_new_mjpeg_ms=max(gaps)*1000,
        offline_samples=sum(not s['video']['online']for s in report['samples']),route=after.get('route'),resolution=after.get('resolution'),errors=errors)
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report['measurement'],ensure_ascii=False,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--seconds',type=int,default=60);p.add_argument('--output',type=Path)
    args=p.parse_args();measure(args.root.resolve(),args.seconds,args.output or args.root/'logs/cloud-measurement.json')
