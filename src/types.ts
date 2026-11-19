export type DataSource = 'measured' | 'simulated' | 'historical';
export type LinkMode = 'direct' | 'relay';
export type RouteMode = LinkMode | 'auto';
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
  esp?: EspSnapshot;
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

export interface ReceiverEvent {
  id: number; kind: string; time: string; route?: LinkMode; previous_route?: LinkMode; gap_ms?: number | null;
}
export interface ReceiverStatus {
  online: boolean; enabled: boolean; fps: number; received: number; age_ms: number | null;
  frame_loss_percent: number | null; frame_loss_window_s?: number; frame_id?: number;
  boot_id?: string; route?: LinkMode; rssi?: number; ssid?: string;
  width?: number; height?: number; resolution?: string; codec?: string;
  source_ip?: string; events: ReceiverEvent[];
}
export interface WirelessControl {
  enabled: boolean; wireless_online: boolean; last_mode: RouteMode | null;
  heartbeat_age_ms: number | null; cameras: {mipi: boolean}; transport: string;
}
export interface PersonBox { x: number; y: number; width: number; height: number; confidence: number }
export interface DetectionStatus {
  enabled: boolean; ready: boolean; state: string; fresh: boolean; count: number | null;
  boxes: PersonBox[]; fps: number; inference_ms: number | null; age_ms: number | null;
  ttl_ms: number; boot_id: string | null; error: string | null;
}
export interface EspPathSample {
  fps: number; loss: number | null; resolution: string | null; timestamp: string;
}
export interface EspSnapshot {
  receiverAvailable: boolean; error: string | null; updatedAt: string | null;
  video: ReceiverStatus | null; control: WirelessControl | null; detection: DetectionStatus | null;
  transport: {decoded: number; errors: number; decode_ms: number; display_encode_ms: number; bytes: number} | null;
  paths: {direct: EspPathSample | null; relay: EspPathSample | null};
}

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'state'; data: Snapshot }
  | { type: 'camera'; data: CameraState };
