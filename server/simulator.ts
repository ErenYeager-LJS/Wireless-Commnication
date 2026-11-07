import mqtt, { type MqttClient } from 'mqtt';
import type { CommandRecord, LinkMetric, LinkMode, NodeState, Snapshot } from '../src/types.js';
import { config } from './config.js';
import { platformState } from './state.js';

export class DemoSimulator {
  private client: MqttClient | null = null;
  private sequence = 0;
  private interval: NodeJS.Timeout | null = null;
  private lampOn = false;
  private alarm = false;

  start(): void {
    this.client = mqtt.connect(`mqtt://127.0.0.1:${config.mqttPort}`, {
      clientId: 'demo-terminal', username: 'relay', password: config.deviceToken,
    });
    this.client.on('connect', () => {
      this.client?.subscribe('relay/TERM-01/command');
      this.client?.subscribe('relay/system/mode');
      this.tick();
      this.interval = setInterval(() => this.tick(), 1_000);
    });
    this.client.on('message', (topic, payload) => {
      if (topic === 'relay/TERM-01/command') this.handleCommand(JSON.parse(payload.toString()) as CommandRecord);
    });
  }

  setScenario(scenario: Snapshot['demoScenario']): void {
    platformState.setScenario(scenario);
    this.alarm = scenario === 'alarm';
    this.tick();
  }

  private publish(topic: string, value: unknown): void {
    this.client?.publish(topic, JSON.stringify(value), { qos: 0 });
  }

  private node(nodeId: string, role: NodeState['role'], mode: LinkMode, online: boolean): NodeState {
    const relay = mode === 'relay';
    return {
      nodeId, role, online, sequence: this.sequence, mode,
      upstream: role === 'terminal' ? (relay ? 'RELAY-01' : 'CONTROL-01') : role === 'relay' ? 'CONTROL-01' : null,
      downstream: role === 'relay' ? 'TERM-01' : role === 'controller' ? (relay ? 'RELAY-01' : 'TERM-01') : null,
      lastSeen: new Date().toISOString(), source: 'simulated', firmware: 'demo-1.0.0',
      rssi: role === 'controller' ? undefined : relay ? -52 : -78,
      lampOn: role === 'terminal' ? this.lampOn : undefined,
      alarm: role === 'terminal' ? this.alarm : undefined,
      temperature: role === 'terminal' ? 23.8 + Math.sin(this.sequence / 9) * 0.7 : undefined,
      humidity: role === 'terminal' ? 56 + Math.sin(this.sequence / 7) * 2 : undefined,
    };
  }

  private tick(): void {
    if (!this.client?.connected) return;
    this.sequence += 1;
    const mode = platformState.mode;
    const scenario = platformState.scenario;
    const offline = scenario === 'offline';
    const degraded = scenario === 'degraded';
    if (!offline) this.publish('relay/TERM-01/status', this.node('TERM-01', 'terminal', mode, true));
    this.publish('relay/RELAY-01/status', this.node('RELAY-01', 'relay', mode, true));
    this.publish('relay/CONTROL-01/status', this.node('CONTROL-01', 'controller', mode, true));

    const sent = 10;
    const loss = offline ? 10 : degraded ? (mode === 'direct' ? 4 : 1) : 0;
    const baseRtt = mode === 'relay' ? 46 : 27;
    const rtt = offline ? 0 : degraded ? baseRtt + (mode === 'direct' ? 150 : 35) : baseRtt + Math.round(Math.sin(this.sequence) * 5);
    const metric: LinkMetric = {
      timestamp: new Date().toISOString(), testId: `DEMO-${new Date().toISOString().slice(0, 10)}`,
      sourceNode: 'TERM-01', targetNode: 'CONTROL-01',
      path: mode === 'relay' ? ['TERM-01', 'RELAY-01', 'CONTROL-01'] : ['TERM-01', 'CONTROL-01'],
      windowSeconds: 1, sent, received: sent - loss, timedOut: loss, duplicates: 0,
      rttAvgMs: rtt ? Math.max(1, rtt - 9) : 0, rttP95Ms: rtt,
      goodputKbps: offline ? 0 : mode === 'relay' ? 246 : degraded ? 41 : 312,
      forwardedPackets: mode === 'relay' && !offline ? (this.sequence * 10) : 0, source: 'simulated',
    };
    this.publish('relay/TERM-01/metric', metric);
  }

  private handleCommand(command: CommandRecord): void {
    if (command.action === 'lamp_on') this.lampOn = true;
    if (command.action === 'lamp_off') this.lampOn = false;
    if (command.action === 'alarm_reset') this.alarm = false;
    setTimeout(() => {
      this.publish('relay/TERM-01/ack', { commandId: command.commandId, ok: true });
      this.tick();
    }, 180 + Math.random() * 250);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.client?.end(true);
  }
}
