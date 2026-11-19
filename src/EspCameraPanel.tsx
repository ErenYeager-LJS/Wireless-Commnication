import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Maximize2, Minimize2, Scan } from 'lucide-react';
import type { EspSnapshot } from './types';
import { api } from './api';

export function EspCameraPanel({ esp, busy, run }: {
  esp: EspSnapshot; busy: string; run: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(performance.now());
  const [geometry, setGeometry] = useState({width: 0, height: 0, x: 0, y: 0});
  const image = useRef<HTMLImageElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const detection = esp.detection;
  const detectionAt = useRef({value: detection, at: performance.now()});
  if (detectionAt.current.value !== detection) detectionAt.current = {value: detection, at: performance.now()};
  const video = esp.video;
  const online = !!(esp.receiverAvailable && video?.online && video.enabled);
  const fresh = online && loaded && !failed && detection?.fresh && detection.enabled &&
    detection.boot_id === video?.boot_id &&
    (detection.age_ms ?? Infinity) + clock - detectionAt.current.at < detection.ttl_ms;

  useEffect(() => {
    const timer = setInterval(() => setClock(performance.now()), 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!online) { setLoaded(false); setFailed(false); }
  }, [online]);
  useEffect(() => {
    if (!online || !failed) return;
    const timer = setTimeout(() => { setFailed(false); setLoaded(false); setRetry(v => v + 1); }, 1_000);
    return () => clearTimeout(timer);
  }, [online, failed]);
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const resize = () => {
      if (!element.naturalWidth) return;
      const scale = Math.min(element.clientWidth / element.naturalWidth, element.clientHeight / element.naturalHeight);
      const width = element.naturalWidth * scale, height = element.naturalHeight * scale;
      setGeometry({width, height, x: (element.clientWidth - width) / 2, y: (element.clientHeight - height) / 2});
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => observer.disconnect();
  }, [online, loaded, expanded]);
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.showModal();
  }, [expanded]);

  const detectionText = !esp.receiverAvailable ? '接收端未连接' : !detection ? '检测不可用' :
    !detection.enabled ? '已关闭' : detection.error ? '模型不可用' : fresh ? `检测到 ${detection.count} 人` : online ? '正在检测…' : '等待画面';
  const panel = <section className={`panel camera-panel esp-camera ${expanded ? 'camera-expanded' : ''}`} aria-label="OV5647 实时画面">
    <div className="panel-title"><span><Camera size={15} />无人机画面 · OV5647</span><div className="panel-actions">
      <em className="source-tag measured">实测</em>
      <button className="icon-button" aria-label={expanded ? '收起画面' : '放大画面'} onClick={() => setExpanded(!expanded)}>
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button></div></div>
    <div className="camera-feed" data-testid="esp-camera-feed">
      {online && <img ref={image} key={retry} className={`esp-video ${loaded && !failed ? '' : 'not-loaded'}`} src={`/api/esp/stream?v=${retry}`}
        alt="OV5647 实时画面" onLoad={() => {setLoaded(true); setFailed(false);}} onError={() => {setFailed(true); setLoaded(false);}} />}
      {(!online || !loaded || failed) && <div className="camera-empty"><Camera size={30} /><strong>{!esp.receiverAvailable ? '等待本地接收端' : video?.enabled === false ? '画面已暂停' : failed ? '画面连接中断' : online ? '正在载入画面' : '等待摄像头连接'}</strong><span>{esp.error ?? 'ESP32-P4 + C6 / OV5647'}</span></div>}
      <div className="person-overlay" aria-hidden="true">{fresh && detection.boxes.map((b, i) =>
        <div key={i} className="person-box" style={{left: geometry.x + b.x * geometry.width, top: geometry.y + b.y * geometry.height, width: b.width * geometry.width, height: b.height * geometry.height}}>
          <span>人 · {Math.round(b.confidence * 100)}%</span>
        </div>)}</div>
      {online && loaded && !failed && <span className="live-mark"><i /> LIVE</span>}
      <span className="camera-time">{online ? (video?.resolution ?? '—').replace('x', ' × ') : '无新画面'}</span>
    </div>
    <div className="esp-video-metrics">
      <div><span>接收帧率</span><strong data-testid="video-fps">{online ? video!.fps.toFixed(1) : '—'}<small>fps</small></strong></div>
      <div><span title="最近 3 秒已编码帧号缺失，不等于 Wi-Fi 丢包率">帧丢失率</span><strong>{online && video?.frame_loss_percent != null ? video.frame_loss_percent.toFixed(1) : '—'}<small>%</small></strong></div>
      <div><span>累计接收</span><strong>{(video?.received ?? 0).toLocaleString()}<small>帧</small></strong></div>
    </div>
    <div className="camera-meta"><span>{video?.codec ?? 'H.264 硬件编码'}</span><span>{online ? `${video?.age_ms ?? 0} ms 前` : '等待新帧'}</span></div>
    <div className="esp-detection"><div><b><Scan size={14} />人物框选</b><span role="status" title={detection?.error ?? '遮挡、衣物和暗光可能造成误检或漏检'}>{detectionText}</span></div><button className="esp-switch" role="switch" aria-label="人物框选" aria-checked={detection?.enabled ?? false} disabled={!!busy || !esp.receiverAvailable || !detection}
      onClick={() => run('detection', () => api.detection(!detection?.enabled))}><i /><span>{detection?.enabled ? '开启' : '关闭'}</span></button></div>
    <div className="detection-foot"><span>本机处理 · {fresh ? `${detection.fps.toFixed(1)} Hz / ${Math.round(detection.inference_ms ?? 0)} ms` : '—'}</span><span>人数仅供参考</span></div>
  </section>;
  return expanded ? createPortal(<dialog ref={dialog} className="esp-camera-modal" aria-label="放大的 OV5647 实时画面"
    onCancel={() => setExpanded(false)}>{panel}</dialog>, document.body) : panel;
}
