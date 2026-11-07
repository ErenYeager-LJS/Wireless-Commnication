import net from 'node:net';
import { Aedes, type AuthenticateError, type Client } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import type { CommandRecord, LinkMetric, NodeState } from '../src/types.js';
import { config } from './config.js';
import { platformState } from './state.js';

let broker: Aedes;
let gateway: MqttClient;

const authenticate = (_client: Client, username: string | undefined, password: Buffer | undefined, callback: (error: AuthenticateError | null, successful: boolean | null) => void) => {
  const allowed = username === 'relay' && password?.toString() === config.deviceToken;
  callback(null, allowed);
};

function parse<T>(buffer: Buffer): T | null {
  try { return JSON.parse(buffer.toString()) as T; } catch { return null; }
}

function processMessage(topic: string, payload: Buffer): void {
  const [, nodeId, channel] = topic.split('/');
  if (!nodeId || !channel) return;
  if (channel === 'probe') {
    const probe = parse<{ sequence: number; sentAtMs: number; payload?: string }>(payload);
    if (probe) gateway.publish(`relay/${nodeId}/probe-ack`, JSON.stringify({
      sequence: probe.sequence,
      sentAtMs: probe.sentAtMs,
      payload: probe.payload ?? '',
      serverReceivedAt: new Date().toISOString(),
    }), { qos: 0 });
  }
  if (channel === 'status') {
    const incoming = parse<Partial<NodeState>>(payload);
    if (!incoming) return;
    platformState.setNode({
      nodeId, role: incoming.role ?? 'terminal', online: true, sequence: incoming.sequence ?? 0,
      mode: incoming.mode ?? platformState.mode, upstream: incoming.upstream ?? null,
      downstream: incoming.downstream ?? null, lastSeen: incoming.lastSeen || new Date().toISOString(),
      source: incoming.source ?? 'measured', firmware: incoming.firmware, rssi: incoming.rssi,
      lampOn: incoming.lampOn, alarm: incoming.alarm, temperature: incoming.temperature, humidity: incoming.humidity,
    });
  }
  if (channel === 'metric') {
    const metric = parse<LinkMetric>(payload);
    if (metric) platformState.setMetric({ ...metric, timestamp: metric.timestamp || new Date().toISOString() });
  }
  if (channel === 'forwarding') {
    const evidence = parse<{ forwardedPackets: number; forwardedBytes: number }>(payload);
    if (evidence) platformState.setRelayForwardingEvidence(Number(evidence.forwardedPackets));
  }
  if (channel === 'ack') {
    const ack = parse<{ commandId: string; ok: boolean; error?: string }>(payload);
    if (ack?.commandId) platformState.completeCommand(ack.commandId, ack.ok, ack.error);
  }
  if (channel === 'alarm') {
    const alarm = parse<{ active: boolean; detail?: string }>(payload);
    const node = platformState.nodes.get(nodeId);
    if (node && alarm) platformState.setNode({ ...node, alarm: alarm.active, lastSeen: new Date().toISOString() });
  }
}

export async function startMqtt(): Promise<net.Server> {
  broker = await Aedes.createBroker({ authenticate });
  const tcpServer = net.createServer(broker.handle);
  await new Promise<void>((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(config.mqttPort, '0.0.0.0', () => resolve());
  });

  gateway = mqtt.connect(`mqtt://127.0.0.1:${config.mqttPort}`, {
    clientId: `platform-${process.pid}`, username: 'relay', password: config.deviceToken, reconnectPeriod: 1_000,
  });
  gateway.on('connect', () => gateway.subscribe('relay/+/+'));
  gateway.on('message', processMessage);
  return tcpServer;
}

export function publishCommand(command: CommandRecord): void {
  gateway.publish(`relay/${command.target}/command`, JSON.stringify(command), { qos: 1 });
}

export function publishMode(mode: 'direct' | 'relay'): void {
  gateway.publish('relay/system/mode', JSON.stringify({ mode, timestamp: new Date().toISOString() }), { qos: 1, retain: true });
}

export async function stopMqtt(): Promise<void> {
  gateway?.end(true);
  await broker.close();
}
