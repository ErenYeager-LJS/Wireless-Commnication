import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity, AlertTriangle, BellRing, Box, Building2, Camera, CheckCircle2, ChevronRight,
  CircleOff, Eye, Focus, Gauge, Layers3, Lightbulb, LightbulbOff, Radio, RefreshCw, ChevronsLeft, ChevronsRight,
  Router, Server, ShieldCheck, Thermometer, Wifi, WifiOff, XCircle,
} from 'lucide-react';
import { api } from './api';
import { TwinScene } from './TwinScene';
import { usePlatform } from './usePlatform';
import { EspCameraPanel } from './EspCameraPanel';
import type { Health, LinkMetric, NodeState, Snapshot } from './types';

const healthMeta: Record<Health, { label: string; icon: typeof Wifi }> = {
  normal: { label: '链路正常', icon: Wifi }, degraded: { label: '链路退化', icon: AlertTriangle },
  offline: { label: '业务离线', icon: WifiOff }, unknown: { label: '状态未知', icon: CircleOff },
};

function relativeTime(value?: string | null): string {
  if (!value) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  return seconds < 2 ? '刚刚' : seconds < 60 ? `${seconds}秒前` : `${Math.floor(seconds / 60)}分钟前`;
}

function loss(metric: LinkMetric | null): string {
  if (!metric?.sent) return '--';
  return `${(((metric.sent - metric.received) / metric.sent) * 100).toFixed(1)}%`;
}

function MetricTile({ label, value, unit, tone }: { label: string; value: string | number; unit?: string; tone?: string }) {
  return <div className="metric-tile"><span>{label}</span><strong className={tone}>{value}<small>{unit}</small></strong></div>;
}

function FoldablePanel({title, children}: {title: string; children: ReactNode}) {
  return <details className="panel disclosure-panel"><summary><span>{title}</span><ChevronRight size={17} /></summary>{children}</details>;
}

function CameraPanel({ snapshot }: { snapshot: Snapshot }) {
  const image = snapshot.camera.source === 'measured' ? snapshot.camera.frameUrl
    : `/api/demo/frame.svg?t=${encodeURIComponent(snapshot.serverTime)}`;
  return <section className="panel camera-panel">
    <div className="panel-title"><span><Camera size={15} />现场画面</span><em className={`source-tag ${snapshot.camera.source}`}>{snapshot.camera.source === 'measured' ? '实测' : '模拟'}</em></div>
    <div className="camera-feed">
      {image ? <img src={image} alt="TERM-01 现场画面" /> : <div className="camera-empty">等待摄像头连接</div>}
      <div className="camera-reticle" />
      {image && <span className="live-mark"><i /> LIVE</span>}
      <span className="camera-time">{snapshot.camera.source === 'measured' ? relativeTime(snapshot.camera.capturedAt) : '演示视频源'}</span>
    </div>
    <div className="camera-meta"><span>TERM-01 · 地下设备走廊</span><span>{snapshot.camera.fps} FPS</span></div>
  </section>;
}

function QualityPanel({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.esp) {
    const v = snapshot.esp.video, online = !!v?.online, t = snapshot.esp.transport;
    return <section className="panel quality-panel"><div className="panel-title"><span><Gauge size={15} />视频链路</span><em>真实接收</em></div>
      <div className="metric-grid"><MetricTile label="摄像头 Wi-Fi" value={online ? v?.rssi ?? '—' : '—'} unit="dBm" />
        <MetricTile label="电脑解码" value={t?.decode_ms ?? '—'} unit="ms" />
        <MetricTile label="当前路径" value={online ? v?.route === 'relay' ? '经中继' : '直连' : '未连接'} tone={online ? 'ok' : 'warn'} />
        <MetricTile label="当前网络" value={online ? v?.ssid ?? '—' : '—'} /></div>
      <div className="path-proof"><span>实际图像来源 · {online ? v?.source_ip : '等待接收'}</span><b>{online ? v?.route === 'relay' ? '无人机摄像端 → 中继站 → 接收中心' : '无人机摄像端 → 接收中心' : '未收到图像，不点亮业务路径'}</b></div>
    </section>;
  }
  const metric = snapshot.metric;
  return <section className="panel quality-panel">
    <div className="panel-title"><span><Gauge size={15} />链路质量</span><em>{metric?.windowSeconds ?? 0}s 窗口</em></div>
    <div className="metric-grid">
      <MetricTile label="P95 RTT" value={metric?.rttP95Ms ?? '--'} unit="ms" />
      <MetricTile label="丢包率" value={loss(metric)} tone={snapshot.health === 'normal' ? 'ok' : 'warn'} />
      <MetricTile label="有效速率" value={metric?.goodputKbps ?? '--'} unit="kbps" />
      <MetricTile label="中继转发" value={metric?.forwardedPackets ?? '--'} unit="包" />
    </div>
    <div className="path-proof"><span>当前证据链</span><b>{metric?.path.join(' → ') ?? '等待有效探测包'}</b></div>
  </section>;
}

function ComparisonPanel({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.esp) return <section className="panel comparison-panel"><div className="panel-title"><span><Activity size={15} />路径对比</span><em>最近一次采样</em></div>
    <div className="compare-head"><span>路径</span><span>帧率</span><span>帧缺失</span><span>分辨率</span></div>
    {(['direct', 'relay'] as const).map(mode => {
      const s = snapshot.esp!.paths[mode];
      return <div className={`compare-row ${snapshot.esp!.video?.online && snapshot.mode === mode ? 'active' : ''}`} key={mode} title={s ? `采样于 ${new Date(s.timestamp).toLocaleTimeString('zh-CN')}` : '本次运行尚无样本'}>
        <b>{mode === 'direct' ? '直连' : '中继'}</b><span>{s ? `${s.fps.toFixed(1)}` : '—'}</span><span>{s?.loss != null ? `${s.loss.toFixed(1)}%` : '—'}</span><span>{s?.resolution === '1280x720' ? '720p' : s?.resolution ?? '—'}</span></div>;
    })}<p className="panel-note">不同时间的样本，仅供观察；帧缺失不等于网络丢包。</p></section>;
  const rows = [['直连', snapshot.comparison.direct], ['中继', snapshot.comparison.relay]] as const;
  return <section className="panel comparison-panel">
    <div className="panel-title"><span><Activity size={15} />路径对比</span><em>本次运行</em></div>
    <div className="compare-head"><span>路径</span><span>丢包</span><span>P95</span><span>速率</span></div>
    {rows.map(([name, item]) => <div className={`compare-row ${snapshot.mode === (name === '直连' ? 'direct' : 'relay') ? 'active' : ''}`} key={name}>
      <b>{name}</b><span>{loss(item)}</span><span>{item ? `${item.rttP95Ms}ms` : '--'}</span><span>{item ? `${item.goodputKbps}k` : '--'}</span>
    </div>)}
  </section>;
}

function NodeIcon({ node }: { node: NodeState }) {
  const Icon = node.role === 'terminal' ? Radio : node.role === 'relay' ? Router : Server;
  return <span className={`node-icon ${node.online ? '' : 'offline'}`}><Icon size={16} /></span>;
}

function DevicePanel({ snapshot, selected, onSelect }: { snapshot: Snapshot; selected: string; onSelect: (id: string) => void }) {
  return <section className="panel device-panel">
    <div className="panel-title"><span><Box size={15} />设备状态</span><em>{snapshot.nodes.filter(n => n.online).length}/{snapshot.nodes.length} 在线</em></div>
    <div className="device-list">{snapshot.nodes.map((node) => <button key={node.nodeId} onClick={() => onSelect(node.nodeId)} className={selected === node.nodeId ? 'selected' : ''}>
      <NodeIcon node={node} /><span><b>{snapshot.esp ? node.role === 'terminal' ? 'UAV-01 · 无人机' : node.role === 'relay' ? '中间中继站' : '右侧接收中心' : node.nodeId}</b><small>{node.role === 'terminal' ? snapshot.esp ? 'OV5647 图传摄像端' : '业务终端' : node.role === 'relay' ? '通信中继' : '路由器 / 控制电脑'}</small></span>
      <em>{snapshot.esp && node.role === 'relay' && !node.online ? '未确认转发' : node.online ? relativeTime(node.lastSeen) : '离线'}</em><ChevronRight size={14} />
    </button>)}</div>
  </section>;
}

function EventsPanel({ snapshot }: { snapshot: Snapshot }) {
  return <section className="panel events-panel">
    <div className="panel-title"><span><BellRing size={15} />事件记录</span><em>实时</em></div>
    <div className="event-list">{snapshot.events.slice(0, 8).map((event) => {
      const Icon = event.severity === 'success' ? CheckCircle2 : event.severity === 'critical' ? XCircle : event.severity === 'warning' ? AlertTriangle : Activity;
      return <div className={`event ${event.severity}`} key={event.id}><Icon size={14} /><span><b>{event.title}</b><small>{event.detail}</small></span><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>;
    })}</div>
  </section>;
}

export function App() {
  const { snapshot, connected } = usePlatform();
  const [selected, setSelected] = useState('TERM-01');
  const [exploded, setExploded] = useState(false);
  const [transparent, setTransparent] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(new Date());
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 1_000); return () => clearInterval(timer); }, []);
  const terminal = snapshot?.nodes.find((node) => node.nodeId === 'TERM-01');
  const latestCommand = snapshot?.commands[0];
  const meta = healthMeta[snapshot?.health ?? 'unknown'];
  const HealthIcon = meta.icon;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(''); }
  };

  const selectedNode = useMemo(() => snapshot?.nodes.find((node) => node.nodeId === selected), [snapshot, selected]);
  if (!snapshot) return <div className="loading"><RefreshCw size={28} className="spin" /><span>正在接入数据服务</span></div>;

  return <main className={`app health-${snapshot.health} ${snapshot.esp ? 'esp-platform' : ''} ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><ShieldCheck size={22} /></span><div><b>麟盾</b><span>数据通信中继与三维联动平台</span></div></div>
      <div className="system-summary">
        {snapshot.cloud && <button className="cloud-logout" onClick={()=>void fetch('/auth/logout',{method:'POST'}).then(response=>{if(response.ok)location.replace('/login');})}>退出登录</button>}
        <span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? '平台在线' : '正在重连'}</span>
        <span className={`source-tag ${snapshot.source}`}>{snapshot.source === 'measured' ? '实测数据' : '模拟数据'}</span>
        <span className={`health-badge ${snapshot.health}`}><HealthIcon size={15} />{meta.label}</span>
      </div>
      <time>{clock.toLocaleDateString('zh-CN')}<b>{clock.toLocaleTimeString('zh-CN', { hour12: false })}</b></time>
    </header>

    <div className="scene-wrap">
      <TwinScene nodes={snapshot.nodes} mode={snapshot.mode} health={snapshot.health} exploded={exploded}
        transparent={transparent} selected={selected} onSelect={setSelected} videoPriority={!!snapshot.esp} video={snapshot.esp?.video} />
      <div className="scene-heading"><span>{snapshot.esp ? '无人机图像回传' : '园区地下通信保障域'}</span><b>{snapshot.esp ? '机载摄像端 → 右侧接收中心' : snapshot.metric?.testId ?? '等待测试轮次'}</b><small>{snapshot.esp ? 'RSSI 相对位置示意 · 非真实定位' : '园区与无人机为示意模型'}</small></div>
      <div className="scene-tools">
        <button title="楼层抽出" className={exploded ? 'active' : ''} onClick={() => setExploded(!exploded)}><Layers3 size={17} /></button>
        <button title="建筑透明" className={transparent ? 'active' : ''} onClick={() => setTransparent(!transparent)}><Eye size={17} /></button>
        <button title="定位终端" onClick={() => setSelected('TERM-01')}><Focus size={17} /></button>
      </div>
      <div className="scene-legend"><span><i className="normal" />正常</span><span><i className="degraded" />退化</span><span><i className="offline" />失联</span></div>
      {snapshot.esp && <div className="flight-summary" aria-label="无人机图像路径">
        <strong>{!snapshot.esp.video?.online ? '等待无人机画面' : snapshot.mode === 'relay' ? '无人机 → 中间中继站 → 右侧接收中心' : '无人机 → 右侧接收中心'}</strong>
        <span>{snapshot.mode === 'relay' ? '围绕中继器匀速飞行 · 信号越弱，半径越大' : '围绕右侧接收中心匀速飞行 · 信号越弱，半径越大'}</span>
      </div>}
      {selectedNode && <div className="selected-readout"><NodeIcon node={selectedNode} /><div><b>{snapshot.esp ? selectedNode.role === 'terminal' ? 'UAV-01 · 无人机' : selectedNode.role === 'relay' ? '中继站' : '接收中心' : selectedNode.nodeId}</b><span>{selectedNode.upstream ? `上游 ${selectedNode.upstream}` : '控制端节点'}</span></div>{selectedNode.rssi !== undefined && <em>{selectedNode.rssi} dBm</em>}</div>}
    </div>

    {snapshot.esp && <>
      <button className="rail-toggle rail-toggle-left" aria-label={leftCollapsed ? '展开视频侧栏' : '收起视频侧栏'} aria-expanded={!leftCollapsed} title={leftCollapsed ? '展开视频侧栏' : '收起视频侧栏'} onClick={() => setLeftCollapsed(v => !v)}>{leftCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}</button>
      <button className="rail-toggle rail-toggle-right" aria-label={rightCollapsed ? '展开控制侧栏' : '收起控制侧栏'} aria-expanded={!rightCollapsed} title={rightCollapsed ? '展开控制侧栏' : '收起控制侧栏'} onClick={() => setRightCollapsed(v => !v)}>{rightCollapsed ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}</button>
    </>}
    <aside className="left-rail">{snapshot.esp ? <>
      <EspCameraPanel esp={snapshot.esp} busy={busy} run={run} cloud={snapshot.cloud}/>
      <FoldablePanel title="视频链路详情"><QualityPanel snapshot={snapshot} /></FoldablePanel>
      <FoldablePanel title="直连 / 中继对比"><ComparisonPanel snapshot={snapshot} /></FoldablePanel>
    </> : <><CameraPanel snapshot={snapshot} /><QualityPanel snapshot={snapshot} /><ComparisonPanel snapshot={snapshot} /></>}</aside>
    <aside className="right-rail">
      <section className="panel control-panel">
        <div className="panel-title"><span><Radio size={15} />链路与控制</span><em>{snapshot.esp ? 'Wi-Fi 控制' : '人工模式'}</em></div>
        <div className={`segmented ${snapshot.esp ? 'three-modes' : ''}`} aria-label="连接方式">
          {snapshot.esp && <button className={snapshot.esp.control?.last_mode === 'auto' ? 'active' : ''} disabled={!!busy || !connected || !snapshot.esp.control?.wireless_online} onClick={() => run('auto', () => api.setMode('auto'))}>自动</button>}
          <button className={(snapshot.esp ? snapshot.esp.control?.last_mode : snapshot.mode) === 'direct' ? 'active' : ''} disabled={!!busy || (!!snapshot.esp && (!connected || !snapshot.esp.control?.wireless_online))} onClick={() => run('direct', () => api.setMode('direct'))}>直连</button>
          <button className={(snapshot.esp ? snapshot.esp.control?.last_mode : snapshot.mode) === 'relay' ? 'active' : ''} disabled={!!busy || (!!snapshot.esp && (!connected || !snapshot.esp.control?.wireless_online))} onClick={() => run('relay', () => api.setMode('relay'))}>经中继</button>
        </div>
        {snapshot.esp ? <><div className="control-actions esp-actions"><button role="switch" aria-label="摄像头传输" aria-checked={snapshot.esp.control?.cameras.mipi ?? false} disabled={!!busy || !connected || !snapshot.esp.control?.wireless_online}
          onClick={() => run('camera', () => api.camera(!snapshot.esp!.control?.cameras.mipi))}><Camera size={17} />{snapshot.esp.control?.cameras.mipi ? '暂停画面' : '开启画面'}</button></div>
          <div className="command-status"><span>{busy ? '指令处理中' : '无线控制'}</span><b role="status">{busy ? '等待设备确认与重新联网…' : snapshot.esp.control?.wireless_online ? '心跳在线 · 可操作' : '等待设备心跳'}</b></div>
          <p className="panel-note">选择模式后等待设备确认。实际路径以收到的画面为准。</p></> : <><div className="control-actions">
          <button disabled={!!busy || !terminal?.online} onClick={() => run('lamp', () => api.command(terminal?.lampOn ? 'lamp_off' : 'lamp_on'))}>
            {terminal?.lampOn ? <LightbulbOff size={17} /> : <Lightbulb size={17} />}{terminal?.lampOn ? '关闭警示灯' : '点亮警示灯'}
          </button>
          <button disabled={!!busy || !terminal?.alarm} onClick={() => run('reset', () => api.command('alarm_reset'))}><BellRing size={17} />复位告警</button>
        </div>
        <div className={`command-status ${latestCommand?.status ?? ''}`}><span>最近指令</span><b>{latestCommand ? `${latestCommand.commandId.slice(0, 8)} · ${latestCommand.status}` : '暂无'}</b></div></>}
        {error && <div className="operation-error">{error}</div>}
      </section>
      {snapshot.esp ? <FoldablePanel title="设备状态"><DevicePanel snapshot={snapshot} selected={selected} onSelect={setSelected} /></FoldablePanel> : <DevicePanel snapshot={snapshot} selected={selected} onSelect={setSelected} />}
      {snapshot.esp ? <FoldablePanel title="硬件配置"><section className="panel esp-hardware"><div className="panel-title"><span><Box size={15} />当前硬件</span><em>单路 OV</em></div><p>ESP32-P4 + C6 / OV5647</p><p>ESP32 中继 · H.264 / TCP</p><small>温湿度与警示灯未接入</small></section></FoldablePanel> : <section className="panel sensor-strip">
        <div><Thermometer size={16} /><span>温度<b>{terminal?.temperature?.toFixed(1) ?? '--'}°C</b></span></div>
        <div><Activity size={16} /><span>湿度<b>{terminal?.humidity?.toFixed(0) ?? '--'}%</b></span></div>
      </section>}
      {snapshot.esp ? <FoldablePanel title="事件记录"><EventsPanel snapshot={snapshot} /></FoldablePanel> : <EventsPanel snapshot={snapshot} />}
    </aside>

    {!snapshot.esp && snapshot.source === 'simulated' && <div className="demo-controls"><span>演示注入</span>{(['steady', 'degraded', 'offline', 'alarm'] as const).map((scenario) => <button key={scenario}
      className={snapshot.demoScenario === scenario ? 'active' : ''} onClick={() => run(`scenario-${scenario}`, () => api.scenario(scenario))}>
      {{ steady: '稳定', degraded: '退化', offline: '断链', alarm: '告警' }[scenario]}
    </button>)}</div>}
    <footer><span><Building2 size={13} />{snapshot.esp ? '无人机图传示意 · 实拍来自 OV5647' : '地下层 B1 · 设备走廊'}</span><span><Radio size={13} />{snapshot.esp ? !snapshot.esp.video?.online ? '等待实际图像路径' : snapshot.mode === 'relay' ? '无人机 → 中继站 → 接收中心' : '无人机 → 接收中心' : snapshot.mode === 'relay' ? 'TERM-01 → RELAY-01 → CONTROL-01' : 'TERM-01 → CONTROL-01'}</span><span>状态更新时间 {relativeTime(snapshot.serverTime)}</span></footer>
  </main>;
}
