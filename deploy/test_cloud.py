"""Local TLS/codec/control test with synthetic pictures. No public-cloud performance claim."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import unittest
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[1]
PC=ROOT/'integrations/esp-receiver/Soft/PC'
sys.path.insert(0,str(PC));sys.path.insert(0,str(PC.parents[1]))
from cloud_transport import SignedControl, seal
from wireless import RouteController
from receiver.h264_tcp import HEADER


class SignedTests(unittest.TestCase):
    def test_identity_tamper_and_replay(self):
        controller=RouteController();signed=SignedControl(controller,'test','12'*32)
        body=b'ECP1 1111111111111111 00000001 0000000000000000 0 1'
        packet=seal(body,'test','12'*32)
        self.assertIsNotNone(signed.handle(packet,('127.0.0.1',12000)))
        self.assertIsNone(signed.handle(packet,('127.0.0.1',12000)))
        self.assertIsNone(signed.handle(packet[:-1]+b'x',('127.0.0.1',12000)))
        self.assertIsNone(signed.handle(seal(body,'other','12'*32),('127.0.0.1',12000)))
        self.assertIsNone(signed.handle(body,('127.0.0.1',12000)))


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work=ROOT/'buffer/cloud-tests';cls.work.mkdir(parents=True,exist_ok=True)
        cls.settings=json.loads((ROOT/'deploy/private/cloud.json').read_text())
        cls.settings.update(web_port=port(),device_port=port(),control_port=port(),web_user='test',
            password_salt='12'*16,password_hash=hashlib.scrypt(b'test-password',salt=('12'*16).encode(),n=16384,r=8,p=1,dklen=64).hex(),
            certificate=str(ROOT/'deploy/private/server-cert.pem'),private_key=str(ROOT/'deploy/private/server-key.pem'))
        cls.internal=port();cfg=cls.work/'cloud.json';cfg.write_text(json.dumps(cls.settings))
        env={**os.environ,'CLOUD_CONFIG':str(cfg),'PROJECT_ROOT':str(ROOT),'PLATFORM_BACKEND':'esp32','DEMO_MODE':'false',
             'ESP_RECEIVER_URL':f'http://127.0.0.1:{cls.internal}','PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1'}
        cls.logs=[open(cls.work/f'{name}.log','wb')for name in ['receiver','web']]
        cls.children=[subprocess.Popen([sys.executable,'-B','-u',str(PC/'cloud_server.py'),'--config',str(cfg),'--internal-port',str(cls.internal)],stdout=cls.logs[0],stderr=subprocess.STDOUT,env=env,cwd=ROOT),
                      subprocess.Popen(['node','--import','tsx','server/index.ts'],stdout=cls.logs[1],stderr=subprocess.STDOUT,env=env,cwd=ROOT)]
        cls.context=ssl.create_default_context(cafile=cls.settings['certificate'])
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            try:
                if cls.web('GET','/login')[0]==200 and cls.state()['online'] is False:break
            except (OSError,ValueError):time.sleep(.2)
        else:
            cls.tearDownClass();raise RuntimeError('Cloud test services did not start; inspect buffer/cloud-tests logs')

    @classmethod
    def tearDownClass(cls):
        for child in cls.children:
            child.terminate()
        for child in cls.children:
            try:child.wait(8)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for log in cls.logs:log.close()

    @classmethod
    def web(cls,method,path,data=None,cookie=None):
        conn=http.client.HTTPConnection('127.0.0.1',cls.settings['web_port'],timeout=35)
        conn.sock=cls.context.wrap_socket(socket.create_connection(('127.0.0.1',cls.settings['web_port']),timeout=35),server_hostname=cls.settings['public_host'])
        headers={'Origin':f'https://{cls.settings["public_host"]}:{cls.settings["web_port"]}','Content-Type':'application/json'}
        if cookie:headers['Cookie']=cookie
        conn.request(method,path,body=json.dumps(data)if data else None,headers=headers)
        response=conn.getresponse();body=response.read();result=(response.status,body,response.getheader('Set-Cookie'));conn.close();return result

    @classmethod
    def state(cls):
        with urlopen(f'http://127.0.0.1:{cls.internal}/status',timeout=3)as r:return json.load(r)

    def video(self,token=None):
        sock=self.context.wrap_socket(socket.create_connection(('127.0.0.1',self.settings['device_port']),timeout=5),server_hostname=self.settings['public_host'])
        sock.sendall(('POST /h264 HTTP/1.1\r\nHost: cloud\r\nContent-Length: 0\r\nUpgrade: esp-h264\r\nConnection: Upgrade\r\nX-Device-Id: '+self.settings['device_id']+'\r\nAuthorization: Bearer '+(token or self.settings['device_token'])+'\r\n\r\n').encode())
        reply=b''
        while not reply.endswith(b'\r\n\r\n'):reply+=sock.recv(1)
        return sock,reply

    def test_transport_auth_decode_reconnect_control(self):
        import av
        import numpy as np
        self.assertEqual(self.web('GET','/api/snapshot')[0],401)
        status,_,cookie=self.web('POST','/auth/login',{'username':'test','password':'test-password'})
        self.assertEqual(status,200);self.assertIn('Secure',cookie)
        sock,reply=self.video('wrong');self.assertIn(b'401',reply);sock.close()
        encoder=av.CodecContext.create('libx264','w');encoder.width=1280;encoder.height=720;encoder.pix_fmt='yuv420p'
        from fractions import Fraction
        encoder.time_base=Fraction(1,30);encoder.options={'preset':'ultrafast','tune':'zerolatency','x264-params':'keyint=15:repeat-headers=1'}
        picture=np.zeros((720,1280,3),np.uint8);picture[:,:,1]=100
        packets=[]
        for _ in range(5):packets+=encoder.encode(av.VideoFrame.from_ndarray(picture,format='bgr24'))
        self.assertEqual(len(packets),5)
        def frame(number,packet,relay):
            data=bytes(packet)
            return HEADER.pack(b'EHV1',len(data),b'2222222222222222',number,100,1280,720,-51,int(relay),int(packet.is_keyframe),b'test-network')+data
        for relay,start in [(False,1),(True,10)]:
            sock,reply=self.video();self.assertIn(b'101',reply)
            for i,packet in enumerate(packets):
                sock.sendall(frame(start+i,packet,relay));self.assertEqual(sock.recv(4),struct.pack('!I',start+i))
            sock.close()
            self.assertEqual(self.state()['route'],'relay'if relay else'direct')
            self.assertEqual((self.state()['width'],self.state()['height']),(1280,720))
        # Reconnect on an inter picture must fail without being counted.
        before=self.state()['received'];sock,_=self.video();sock.sendall(frame(20,packets[1],True));self.assertEqual(sock.recv(4),b'');sock.close()
        self.assertEqual(self.state()['received'],before)
        sock,_=self.video();sock.sendall(frame(21,packets[0],True));self.assertEqual(sock.recv(4),struct.pack('!I',21));sock.close()
        stop=threading.Event();observed=[]
        def camera():
            mode,mask,applied=0,1,0
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM)as s:
                s.settimeout(.5)
                for seq in range(1,200):
                    body=f'ECP1 1111111111111111 {seq:08x} {applied:016x} {mode} {mask}'.encode()
                    s.sendto(seal(body,self.settings['device_id'],self.settings['control_key']),('127.0.0.1',self.settings['control_port']))
                    try:
                        reply,_=s.recvfrom(256);core=reply.split(b'|')[0]
                        self.assertEqual(reply,seal(core,self.settings['device_id'],self.settings['control_key']))
                        _,boot,sequence,identity,op,value=core.decode().split();op=int(op);value=int(value)
                        if op:
                            applied=int(identity,16)
                            if op==1:mode=value
                            else:mask=value
                            observed.append((op,value))
                            ack=f'ECA1 {boot} {sequence} {identity} {mode} {mask}'.encode()
                            s.sendto(seal(ack,self.settings['device_id'],self.settings['control_key']),('127.0.0.1',self.settings['control_port']))
                    except socket.timeout:pass
                    if stop.wait(.15):break
        thread=threading.Thread(target=camera);thread.start()
        try:
            time.sleep(.4)
            self.assertEqual(self.web('POST','/api/mode',{'mode':'relay'},cookie)[0],200)
            self.assertEqual(self.web('POST','/api/esp/camera',{'enabled':False},cookie)[0],200)
            self.assertFalse(self.state()['enabled'])
            self.assertEqual(self.web('POST','/api/mode',{'mode':'direct'},cookie)[0],200)
            self.assertEqual(self.web('POST','/api/esp/camera',{'enabled':True},cookie)[0],200)
            self.assertEqual(self.web('POST','/api/mode',{'mode':'auto'},cookie)[0],200)
            self.assertIn((1,2),observed);self.assertIn((1,1),observed);self.assertIn((2,0),observed)
            self.assertEqual(self.web('POST','/api/esp/detection',{'enabled':True},cookie)[0],503)
            with urlopen(f'http://127.0.0.1:{self.internal}/detection')as r:self.assertFalse(json.load(r)['enabled'])
        finally:stop.set();thread.join(3)


if __name__=='__main__':unittest.main(verbosity=2)
