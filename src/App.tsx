import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, BellRing, Box, Building2, Camera, CheckCircle2, ChevronRight,
  CircleOff, Eye, Focus, Gauge, Layers3, Lightbulb, LightbulbOff, Radio, RefreshCw,
  Router, Server, ShieldCheck, Thermometer, Wifi, WifiOff, XCircle,
} from 'lucide-react';
import { api } from './api';
import { TwinScene } from './TwinScene';
import { usePlatform } from './usePlatform';
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

function CameraPanel({ snapshot }: { snapshot: Snapshot }) {
  const image = snapshot.camera.source === 'measured' && snapshot.camera.frameUrl
    ? snapshot.camera.frameUrl : `/api/demo/frame.svg?t=${encodeURIComponent(snapshot.serverTime)}`;
  return <section className="panel camera-panel">
    <div className="panel-title"><span><Camera size={15} />现场画面</span><em className={`source-tag ${snapshot.camera.source}`}>{snapshot.camera.source === 'measured' ? '实测' : '模拟'}</em></div>
    <div className="camera-feed">
      <img src={image} alt="TERM-01 现场画面" />
      <div className="camera-reticle" />
      <span className="live-mark"><i /> LIVE</span>
      <span className="camera-time">{snapshot.camera.source === 'measured' ? relativeTime(snapshot.camera.capturedAt) : '演示视频源'}</span>
    </div>
    <div className="camera-meta"><span>TERM-01 · 地下设备走廊</span><span>{snapshot.camera.fps || 1} FPS</span></div>
  </section>;
}

function QualityPanel({ snapshot }: { snapshot: Snapshot }) {
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
      <NodeIcon node={node} /><span><b>{node.nodeId}</b><small>{node.role === 'terminal' ? '业务终端' : node.role === 'relay' ? '通信中继' : '控制电脑'}</small></span>
      <em>{node.online ? relativeTime(node.lastSeen) : '离线'}</em><ChevronRight size={14} />
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
  if (!snapshot) return <div className="loading"><RefreshCw size={28} className="spin" /><span>正在接入本地数据服务</span></div>;

  return <main className={`app health-${snapshot.health}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><ShieldCheck size={22} /></span><div><b>麟盾</b><span>数据通信中继与三维联动平台</span></div></div>
      <div className="system-summary">
        <span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? '平台在线' : '正在重连'}</span>
        <span className={`source-tag ${snapshot.source}`}>{snapshot.source === 'measured' ? '实测数据' : '模拟数据'}</span>
        <span className={`health-badge ${snapshot.health}`}><HealthIcon size={15} />{meta.label}</span>
      </div>
      <time>{clock.toLocaleDateString('zh-CN')}<b>{clock.toLocaleTimeString('zh-CN', { hour12: false })}</b></time>
    </header>

    <div className="scene-wrap">
      <TwinScene nodes={snapshot.nodes} mode={snapshot.mode} health={snapshot.health} exploded={exploded}
        transparent={transparent} selected={selected} onSelect={setSelected} />
      <div className="scene-heading"><span>园区地下通信保障域</span><b>{snapshot.metric?.testId ?? '等待测试轮次'}</b></div>
      <div className="scene-tools">
        <button title="楼层抽出" className={exploded ? 'active' : ''} onClick={() => setExploded(!exploded)}><Layers3 size={17} /></button>
        <button title="建筑透明" className={transparent ? 'active' : ''} onClick={() => setTransparent(!transparent)}><Eye size={17} /></button>
        <button title="定位终端" onClick={() => setSelected('TERM-01')}><Focus size={17} /></button>
      </div>
      <div className="scene-legend"><span><i className="normal" />正常</span><span><i className="degraded" />退化</span><span><i className="offline" />失联</span></div>
      {selectedNode && <div className="selected-readout"><NodeIcon node={selectedNode} /><div><b>{selectedNode.nodeId}</b><span>{selectedNode.upstream ? `上游 ${selectedNode.upstream}` : '控制端节点'}</span></div>{selectedNode.rssi !== undefined && <em>{selectedNode.rssi} dBm</em>}</div>}
    </div>

    <aside className="left-rail"><CameraPanel snapshot={snapshot} /><QualityPanel snapshot={snapshot} /><ComparisonPanel snapshot={snapshot} /></aside>
    <aside className="right-rail">
      <section className="panel control-panel">
        <div className="panel-title"><span><Radio size={15} />链路与控制</span><em>人工模式</em></div>
        <div className="segmented">
          <button className={snapshot.mode === 'direct' ? 'active' : ''} disabled={!!busy} onClick={() => run('direct', () => api.setMode('direct'))}>直连</button>
          <button className={snapshot.mode === 'relay' ? 'active' : ''} disabled={!!busy} onClick={() => run('relay', () => api.setMode('relay'))}>经中继</button>
        </div>
        <div className="control-actions">
          <button disabled={!!busy || !terminal?.online} onClick={() => run('lamp', () => api.command(terminal?.lampOn ? 'lamp_off' : 'lamp_on'))}>
            {terminal?.lampOn ? <LightbulbOff size={17} /> : <Lightbulb size={17} />}{terminal?.lampOn ? '关闭警示灯' : '点亮警示灯'}
          </button>
          <button disabled={!!busy || !terminal?.alarm} onClick={() => run('reset', () => api.command('alarm_reset'))}><BellRing size={17} />复位告警</button>
        </div>
        <div className={`command-status ${latestCommand?.status ?? ''}`}><span>最近指令</span><b>{latestCommand ? `${latestCommand.commandId.slice(0, 8)} · ${latestCommand.status}` : '暂无'}</b></div>
        {error && <div className="operation-error">{error}</div>}
      </section>
      <DevicePanel snapshot={snapshot} selected={selected} onSelect={setSelected} />
      <section className="panel sensor-strip">
        <div><Thermometer size={16} /><span>温度<b>{terminal?.temperature?.toFixed(1) ?? '--'}°C</b></span></div>
        <div><Activity size={16} /><span>湿度<b>{terminal?.humidity?.toFixed(0) ?? '--'}%</b></span></div>
      </section>
      <EventsPanel snapshot={snapshot} />
    </aside>

    {snapshot.source === 'simulated' && <div className="demo-controls"><span>演示注入</span>{(['steady', 'degraded', 'offline', 'alarm'] as const).map((scenario) => <button key={scenario}
      className={snapshot.demoScenario === scenario ? 'active' : ''} onClick={() => run(`scenario-${scenario}`, () => api.scenario(scenario))}>
      {{ steady: '稳定', degraded: '退化', offline: '断链', alarm: '告警' }[scenario]}
    </button>)}</div>}
    <footer><span><Building2 size={13} />地下层 B1 · 设备走廊</span><span><Radio size={13} />{snapshot.mode === 'relay' ? 'TERM-01 → RELAY-01 → CONTROL-01' : 'TERM-01 → CONTROL-01'}</span><span>状态更新时间 {relativeTime(snapshot.serverTime)}</span></footer>
  </main>;
}
