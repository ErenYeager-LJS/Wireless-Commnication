export type DataSource = 'measured' | 'simulated' | 'historical';
export type LinkMode = 'direct' | 'relay';
export type Health = 'normal' | 'degraded' | 'offline' | 'unknown';

export interface NodeState {
  nodeId: string;
  role: 'terminal' | 'relay' | 'controller';
  online: boolean;
  sequence: number;
  mode: LinkMode;
  upstream: string | null;
  downstream: string | null;
  lastSeen: string;
  source: DataSource;
  firmware?: string;
  rssi?: number;
  lampOn?: boolean;
  alarm?: boolean;
  temperature?: number;
  humidity?: number;
}

export interface LinkMetric {
  id?: number;
  timestamp: string;
  testId: string;
  sourceNode: string;
  targetNode: string;
  path: string[];
  windowSeconds: number;
  sent: number;
  received: number;
  timedOut: number;
  duplicates: number;
  rttAvgMs: number;
  rttP95Ms: number;
  goodputKbps: number;
  forwardedPackets: number;
  source: DataSource;
}

export interface PlatformEvent {
  id: number;
  timestamp: string;
  nodeId: string;
  type: 'status' | 'alarm' | 'mode' | 'command' | 'recovery' | 'system';
  severity: 'info' | 'warning' | 'critical' | 'success';
  title: string;
  detail: string;
  source: DataSource;
}

export interface CommandRecord {
  commandId: string;
  target: string;
  action: 'lamp_on' | 'lamp_off' | 'alarm_reset';
  sentAt: string;
  completedAt?: string;
  status: 'pending' | 'executed' | 'timeout' | 'failed';
  error?: string;
  source: DataSource;
}

export interface CameraState {
  nodeId: string;
  frameUrl: string | null;
  capturedAt: string | null;
  fps: number;
  width: number;
  height: number;
  source: DataSource;
}

export interface Snapshot {
  serverTime: string;
  mode: LinkMode;
  health: Health;
  source: DataSource;
  demoScenario: 'steady' | 'degraded' | 'offline' | 'alarm';
  nodes: NodeState[];
  metric: LinkMetric | null;
  comparison: { direct: LinkMetric | null; relay: LinkMetric | null };
  events: PlatformEvent[];
  commands: CommandRecord[];
  camera: CameraState;
  config: {
    offlineTimeoutMs: number;
    degradedRttMs: number;
    degradedLossPercent: number;
  };
}

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'state'; data: Snapshot }
  | { type: 'camera'; data: CameraState };
