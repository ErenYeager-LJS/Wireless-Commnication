import { randomUUID } from 'node:crypto';
import type { CameraState, CommandRecord, DataSource, LinkMetric, LinkMode, NodeState, Snapshot } from '../src/types.js';
import { config } from './config.js';
import { deriveHealth } from './metrics.js';
import { addCommand, addEvent, addMetric, recentCommands, recentEvents, updateCommand } from './store.js';

type Listener = (snapshot: Snapshot) => void;

class PlatformState {
  mode: LinkMode = 'relay';
  source: DataSource = config.demoMode ? 'simulated' : 'measured';
  scenario: Snapshot['demoScenario'] = 'steady';
  nodes = new Map<string, NodeState>();
  metric: LinkMetric | null = null;
  comparison: { direct: LinkMetric | null; relay: LinkMetric | null } = { direct: null, relay: null };
  camera: CameraState = {
    nodeId: 'TERM-01', frameUrl: null, capturedAt: null, fps: 0, width: 0, height: 0, source: this.source,
  };
  listeners = new Set<Listener>();
  pendingTimers = new Map<string, NodeJS.Timeout>();
  relayForwardedPackets = 0;

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  snapshot(): Snapshot {
    const nodes = [...this.nodes.values()];
    return {
      serverTime: new Date().toISOString(), mode: this.mode,
      health: deriveHealth(nodes, this.metric, config.degradedRttMs, config.degradedLossPercent),
      source: this.source, demoScenario: this.scenario, nodes, metric: this.metric,
      comparison: this.comparison, events: recentEvents(30), commands: recentCommands(10), camera: this.camera,
      config: {
        offlineTimeoutMs: config.offlineTimeoutMs,
        degradedRttMs: config.degradedRttMs,
        degradedLossPercent: config.degradedLossPercent,
      },
    };
  }

  setNode(node: NodeState): void {
    if (node.source === 'measured') this.source = 'measured';
    const previous = this.nodes.get(node.nodeId);
    this.nodes.set(node.nodeId, node);
    if (previous && previous.online !== node.online) {
      addEvent({ timestamp: node.lastSeen, nodeId: node.nodeId, type: node.online ? 'recovery' : 'status',
        severity: node.online ? 'success' : 'critical', title: node.online ? '节点恢复在线' : '节点通信中断',
        detail: node.online ? '重新收到有效状态与序号' : '超过离线阈值未收到心跳', source: node.source });
    }
    this.emit();
  }

  setMetric(metric: LinkMetric): void {
    const measuredMetric = metric.source === 'measured' && metric.path.includes('RELAY-01')
      ? { ...metric, forwardedPackets: this.relayForwardedPackets }
      : metric;
    this.metric = measuredMetric;
    this.comparison[measuredMetric.path.includes('RELAY-01') ? 'relay' : 'direct'] = measuredMetric;
    addMetric(measuredMetric);
    this.emit();
  }

  setRelayForwardingEvidence(forwardedPackets: number): void {
    if (!Number.isFinite(forwardedPackets) || forwardedPackets < this.relayForwardedPackets) return;
    this.relayForwardedPackets = forwardedPackets;
    if (this.metric?.source === 'measured' && this.metric.path.includes('RELAY-01')) {
      this.metric = { ...this.metric, forwardedPackets };
    }
    this.emit();
  }

  setMode(mode: LinkMode): void {
    if (this.mode === mode) return;
    const before = this.mode;
    this.mode = mode;
    addEvent({ timestamp: new Date().toISOString(), nodeId: 'SYSTEM', type: 'mode', severity: 'info',
      title: mode === 'relay' ? '人工启用中继链路' : '人工切换直连链路', detail: `${before} -> ${mode}，操作来源：控制台`, source: this.source });
    this.emit();
  }

  createCommand(target: string, action: CommandRecord['action']): CommandRecord {
    const command: CommandRecord = { commandId: randomUUID(), target, action, sentAt: new Date().toISOString(), status: 'pending', source: this.source };
    addCommand(command);
    addEvent({ timestamp: command.sentAt, nodeId: target, type: 'command', severity: 'info', title: '控制指令已下发', detail: `${action} / ${command.commandId.slice(0, 8)}`, source: this.source });
    this.emit();
    this.pendingTimers.set(command.commandId, setTimeout(() => {
      updateCommand(command.commandId, 'timeout', '3 秒内未收到设备执行回执');
      addEvent({ timestamp: new Date().toISOString(), nodeId: target, type: 'command', severity: 'critical',
        title: '控制指令超时', detail: command.commandId.slice(0, 8), source: this.source });
      this.pendingTimers.delete(command.commandId);
      this.emit();
    }, 3_000));
    return command;
  }

  completeCommand(commandId: string, ok: boolean, error?: string): void {
    const timer = this.pendingTimers.get(commandId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTimers.delete(commandId);
    updateCommand(commandId, ok ? 'executed' : 'failed', error);
    addEvent({ timestamp: new Date().toISOString(), nodeId: 'TERM-01', type: 'command', severity: ok ? 'success' : 'critical',
      title: ok ? '终端执行确认' : '终端执行失败', detail: `${commandId.slice(0, 8)}${error ? ` / ${error}` : ''}`, source: this.source });
    this.emit();
  }

  setCamera(camera: CameraState): void { this.camera = camera; this.emit(); }

  setScenario(scenario: Snapshot['demoScenario']): void {
    this.scenario = scenario;
    addEvent({ timestamp: new Date().toISOString(), nodeId: 'DEMO', type: 'system', severity: 'warning',
      title: '演示场景已切换', detail: scenario, source: 'simulated' });
    this.emit();
  }

  markStaleNodesOffline(now = Date.now()): void {
    let changed = false;
    for (const [nodeId, node] of this.nodes) {
      if (node.online && now - Date.parse(node.lastSeen) > config.offlineTimeoutMs) {
        this.nodes.set(nodeId, { ...node, online: false });
        addEvent({ timestamp: new Date(now).toISOString(), nodeId, type: 'status', severity: 'critical',
          title: '节点通信中断', detail: `超过 ${config.offlineTimeoutMs / 1000} 秒未收到心跳`, source: node.source });
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}

export const platformState = new PlatformState();
