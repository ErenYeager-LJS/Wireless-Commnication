"""现有 MJPEG 接收器 + 局域网自动发现。"""
from pathlib import Path
import socket
import sys
import threading

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from receiver.server import DemoServer, FrameStore
from receiver.relay_udp import Reassembler, HEADER, CHUNK
from receiver.h264_tcp import H264Receiver
from receiver.person_detection import PersonDetector
from control import ControlHandler
from wireless import RouteController

def discovery(port,stop,video,control):
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    s.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,256*1024)
    if hasattr(socket,'SIO_UDP_CONNRESET'):
        s.ioctl(socket.SIO_UDP_CONNRESET,False)
    s.bind(('0.0.0.0',8081));s.settimeout(.1)
    print('自动发现 UDP :8081 已启动',flush=True)
    try:
        while not stop.is_set():
            try:request,peer=s.recvfrom(HEADER.size+CHUNK+1)
            except socket.timeout:video.expire();continue
            except ConnectionResetError:continue
            if request.startswith((b'ECP1 ', b'ECA1 ')):
                reply=control.handle(request,peer)
                if reply:
                    try:s.sendto(reply,peer)
                    except OSError:pass
                continue
            if request.startswith(b'EJR2'):
                ack=video.feed(request,peer)
                if ack:
                    try:s.sendto(ack,peer)
                    except OSError:pass  # A camera can change paths before its ACK.
                continue
            if request!=b'ESP_RELAY_DISCOVER_V1':continue
            probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
            try:probe.connect(peer);ip=probe.getsockname()[0]
            finally:probe.close()
            offer=f'ESP_RELAY_RECEIVER_V1 http://{ip}:{port}/frame'.encode('ascii')
            try:s.sendto(offer,peer)
            except OSError:pass
    finally:s.close()

def main():
    import argparse
    import cv2
    # OpenCV otherwise launches 32 threads on this laptop for image resize,
    # competing with the video decoder and the detector's bounded ORT pool.
    cv2.setNumThreads(2)
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8080)
    a=p.parse_args()
    stop=threading.Event()
    server=DemoServer(('0.0.0.0',a.port),FrameStore(2.0))
    server.RequestHandlerClass=ControlHandler
    server.route_controller=RouteController()
    server.route_controller.attach(server.stores)
    server.relay_video=Reassembler(server.stores)
    server.h264_video=H264Receiver(server.stores)
    server.person_detector=PersonDetector(server.store).start()
    threading.Thread(target=discovery,args=(a.port,stop,server.relay_video,server.route_controller),daemon=True).start()
    print(f'真实摄像头接收页：http://127.0.0.1:{a.port}',flush=True)
    try:server.serve_forever(.2)
    except KeyboardInterrupt:pass
    finally:stop.set();server.server_close()

if __name__=='__main__':main()
