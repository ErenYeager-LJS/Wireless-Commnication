import http from 'node:http';
import type { Request, Response } from 'express';
import type { DetectionStatus, EspSnapshot, LinkMode, ReceiverStatus, RouteMode, Snapshot, WirelessControl } from '../src/types.js';

export function makeEspSnapshot(esp: EspSnapshot, now = Date.now()): Snapshot {
  const age = esp.updatedAt ? now - Date.parse(esp.updatedAt) : Infinity;
  const available = esp.receiverAvailable && age < 2_000;
  const online = available && !!esp.video?.online && esp.video.enabled;
  const video = esp.video;
  const mode = video?.route ?? 'direct';
  const wireless = available && !!esp.control?.wireless_online;
  const seen = esp.updatedAt ?? new Date(now).toISOString();
  const health = !online ? 'offline' : (video!.frame_loss_percent ?? 0) > 5 || video!.fps < 20 ? 'degraded' : 'normal';
  const names: Record<string, string> = {session: '开始接收', switch: '路径已切换', offline: '图像连接中断', resume: '画面恢复'};
  return {
    serverTime: new Date(now).toISOString(), source: 'measured', mode, health, demoScenario: 'steady',
    nodes: [
      {nodeId: 'TERM-01', role: 'terminal', online: online || wireless, sequence: video?.frame_id ?? 0,
        mode, upstream: mode === 'relay' ? 'RELAY-01' : 'CONTROL-01', downstream: null, lastSeen: seen,
        source: 'measured', firmware: 'ESP32-P4 + C6 / OV5647', ...(online ? {rssi: video?.rssi} : {})},
      {nodeId: 'RELAY-01', role: 'relay', online: online && mode === 'relay', sequence: 0,
        mode, upstream: 'CONTROL-01', downstream: 'TERM-01', lastSeen: seen, source: 'measured', firmware: 'ESP32 TCP relay'},
      {nodeId: 'CONTROL-01', role: 'controller', online: available, sequence: 0, mode,
        upstream: null, downstream: mode === 'relay' ? 'RELAY-01' : 'TERM-01', lastSeen: seen, source: 'measured', firmware: 'Local H.264 receiver'},
    ],
    // The receiver measures image delivery, not network P95 RTT or IP packet loss.
    metric: null, comparison: {direct: null, relay: null}, commands: [],
    events: (video?.events ?? []).map(e => ({id: e.id, timestamp: e.time, nodeId: 'TERM-01', type: 'status',
      severity: e.kind === 'offline' ? 'warning' : 'info', title: names[e.kind] ?? e.kind,
      detail: `${e.route === 'relay' ? '经中继' : e.route === 'direct' ? '直连' : ''}${e.gap_ms != null ? ` · 等待 ${(e.gap_ms / 1000).toFixed(2)} s` : ''}`,
      source: 'measured'})),
    camera: {nodeId: 'TERM-01', frameUrl: online ? '/api/esp/stream' : null, capturedAt: online ? seen : null,
      fps: online ? video!.fps : 0, width: video?.width ?? 0, height: video?.height ?? 0, source: 'measured'},
    config: {offlineTimeoutMs: 2_000, degradedRttMs: 0, degradedLossPercent: 5},
    esp: {...esp, receiverAvailable: available,
      video: video ? {...video, online, fps: online ? video.fps : 0} : null,
      control: esp.control ? {...esp.control, wireless_online: wireless} : null,
      detection: available && online ? esp.detection : esp.detection ? {...esp.detection, fresh: false, boxes: [], count: null} : null},
  };
}

export class EspBridge {
  state: EspSnapshot = {receiverAvailable: false, error: '等待 ESP 接收服务', updatedAt: null,
    video: null, control: null, detection: null, transport: null, paths: {direct: null, relay: null}};
  listeners = new Set<(snapshot: Snapshot) => void>();
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private commandBusy = false;
  readonly base: URL;

  constructor(url: string) {
    this.base = new URL(url);
    if (this.base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)) {
      throw new Error('ESP_RECEIVER_URL must be a local HTTP receiver');
    }
  }

  async json<T>(path: string, data?: object, timeout = 1_500): Promise<T> {
    const response = await fetch(new URL(path, this.base), {signal: AbortSignal.timeout(timeout),
      ...(data ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)} : {})});
    const result = await response.json() as {error?: string};
    if (!response.ok) throw new Error(result.error ?? `接收端 HTTP ${response.status}`);
    return result as T;
  }

  snapshot(): Snapshot { return {...makeEspSnapshot(this.state), ...(process.env.CLOUD_CONFIG ? {cloud:true} : {})}; }
  onChange(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async poll(): Promise<void> {
    const [video, control, detection, transport] = await Promise.allSettled([
      this.json<ReceiverStatus>('/status'), this.json<WirelessControl>('/control'),
      this.json<DetectionStatus>('/detection'),
      this.json<{h264: NonNullable<EspSnapshot['transport']>}>('/transport'),
    ]);
    const available = video.status === 'fulfilled';
    this.state.receiverAvailable = available;
    this.state.error = available ? null : process.env.CLOUD_CONFIG ? '云端接收服务未连接，请检查服务器运行状态' : '本地接收端未连接，请启动 ESP 接收程序';
    this.state.updatedAt = new Date().toISOString();
    if (available) this.state.video = video.value;
    else if (this.state.video) this.state.video = {...this.state.video, online: false};
    this.state.control = control.status === 'fulfilled' ? control.value : null;
    this.state.detection = detection.status === 'fulfilled' ? detection.value : null;
    this.state.transport = transport.status === 'fulfilled' ? transport.value.h264 : null;
    const v = this.state.video;
    if (available && v?.online && v.route) this.state.paths[v.route] = {
      fps: v.fps, loss: v.frame_loss_percent, resolution: v.resolution ?? null, timestamp: this.state.updatedAt,
    };
    const snapshot = this.snapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  start(): void {
    this.stopped = false;
    const tick = async () => {
      await this.poll();
      if (!this.stopped) this.timer = setTimeout(tick, 150);
    };
    void tick();
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  async command(kind: 'route' | 'camera' | 'detection', data: object): Promise<unknown> {
    if (this.commandBusy) throw new Error('上一条指令正在执行，请稍候');
    this.commandBusy = true;
    try {
      const result = await this.json<{acknowledged?: boolean}>(`/control/${kind}`, data, 8_000);
      if (kind !== 'detection' && !result.acknowledged) throw new Error('设备尚未确认无线指令');
      if (kind === 'route' && (data as {mode: RouteMode}).mode !== 'auto') {
        // Firmware ACKs before leaving Wi-Fi. Do not permit the next command
        // until a fresh heartbeat arrives after association/DHCP completes.
        const start = Date.now(); let settled = false;
        while (Date.now() - start < 25_000) {
          await new Promise(resolve => setTimeout(resolve, 400));
          try {
            const c = await this.json<WirelessControl>('/control');
            if (Date.now() - start >= 1_500 && c.wireless_online &&
                c.heartbeat_age_ms != null && c.heartbeat_age_ms < 750 && c.last_mode === (data as {mode: RouteMode}).mode) {
              settled = true; break;
            }
          } catch { /* Allow temporary route-change silence through the deadline. */ }
        }
        if (!settled) throw new Error('指令已确认，但换网后的心跳尚未恢复，请以实际路径为准');
      }
      await this.poll();
      return result;
    } finally { this.commandBusy = false; }
  }

  stream(req: Request, res: Response): void {
    const upstream = http.get(new URL('/stream?camera=mipi', this.base));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.on('close', () => upstream.destroy());
    upstream.on('response', source => {
      res.status(source.statusCode ?? 502);
      res.setHeader('Content-Type', source.headers['content-type'] ?? 'application/octet-stream');
      source.on('error', () => res.destroy());
      source.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.status(503).json({error: '摄像头接收端暂不可用'});
      else res.destroy();
    });
    // Backpressure and browser disconnects propagate; never queue video in JS.
    req.socket.setNoDelay(true);
  }
}

export function espPath(mode: LinkMode): string[] {
  return mode === 'relay' ? ['TERM-01', 'RELAY-01', 'CONTROL-01'] : ['TERM-01', 'CONTROL-01'];
}
