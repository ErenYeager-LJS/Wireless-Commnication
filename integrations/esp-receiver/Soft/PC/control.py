"""Local browser API backed by acknowledged Wi-Fi commands."""
import json
from pathlib import Path
from urllib.parse import urlsplit
from receiver.server import Handler
from wireless import MODES

class ControlHandler(Handler):
    def _local(self):
        if self.client_address[0] not in ('127.0.0.1','::1'):
            self.error_json(403,'切换控制仅允许在接收电脑本机操作')
            return False
        return True

    def do_GET(self):
        if urlsplit(self.path).path=='/maintenance/c6.bin':
            firmware=Path(__file__).resolve().parents[1]/'buffer/build-C6/esp_hosted_c6.bin'
            if not firmware.is_file():return self.error_json(404,'co-processor image not built')
            return self.send_body(200,firmware.read_bytes(),'application/octet-stream')
        if urlsplit(self.path).path=='/transport':
            if not self._local():return
            video=self.server.relay_video
            return self.send_body(200,json.dumps({'relay_udp':video.counts,
                                  'pending':len(video.pending),
                                  'h264':self.server.h264_video.counts}).encode())
        if urlsplit(self.path).path!='/control':return super().do_GET()
        if not self._local():return
        self.send_body(200,json.dumps(self.server.route_controller.state()).encode())

    def do_POST(self):
        path=urlsplit(self.path).path
        if path=='/h264':
            if self.headers.get('Upgrade')!='esp-h264' or self.headers.get('Content-Length')!='0':
                return self.error_json(400,'use esp-h264 upgrade with no HTTP body')
            self.send_response(101,'Switching Protocols')
            self.send_header('Connection','Upgrade')
            self.send_header('Upgrade','esp-h264')
            self.end_headers()
            self.wfile.flush()
            self.close_connection=True
            return self.server.h264_video.connection(self.connection,self.client_address)
        if path not in ('/control/route','/control/camera','/control/detection'):return super().do_POST()
        if not self._local():return
        origin=self.headers.get('Origin')
        port=self.server.server_port
        if origin and origin not in (f'http://127.0.0.1:{port}',f'http://localhost:{port}'):
            return self.error_json(403,'不允许其他网页发送控制指令')
        if self.headers.get('Transfer-Encoding') or self.headers.get_content_type()!='application/json':
            return self.error_json(400,'请使用 JSON 指令')
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 1<=size<=256:raise ValueError()
            data=json.loads(self.read_body(size).decode('utf8'))
            if not isinstance(data,dict):raise ValueError()
            if path=='/control/route':
                if data.get('mode') not in MODES:raise ValueError()
            elif path=='/control/detection':
                if type(data.get('enabled')) is not bool:raise ValueError()
            elif data.get('camera') not in self.server.stores or type(data.get('enabled')) is not bool:
                raise ValueError()
        except (ValueError,UnicodeError,TypeError,TimeoutError):
            return self.error_json(400,'无效的切换模式')
        try:
            if path=='/control/route':result=self.server.route_controller.switch(data['mode'])
            elif path=='/control/detection':
                detector=getattr(self.server,'person_detector',None)
                if detector is None:raise RuntimeError('person detector is not configured')
                result=detector.set_enabled(data['enabled'])
            else:
                result=self.server.route_controller.camera(data['camera'],data['enabled'])

        except RuntimeError as e:return self.error_json(503,str(e))
        self.send_body(200,json.dumps(result).encode())
