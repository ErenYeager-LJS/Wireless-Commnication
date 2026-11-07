import fs from 'node:fs';
import mqtt from 'mqtt';

const brokerUrl = process.env.BROKER_URL ?? 'mqtt://192.168.60.1:1883';
const token = process.env.DEVICE_TOKEN ?? 'relay-demo-token';
const nodeId = process.env.NODE_ID ?? 'TERM-01';
const frameFile = process.env.FRAME_FILE;
const frameEndpoint = process.env.FRAME_ENDPOINT ?? 'http://192.168.50.10:8787';
let sequence = 0;
let lampOn = false;
const handled = new Set();

const client = mqtt.connect(brokerUrl, { clientId: `terminal-agent-${nodeId}`, username: 'relay', password: token, reconnectPeriod: 1_000 });
client.on('connect', () => client.subscribe(`relay/${nodeId}/command`, { qos: 1 }));
client.on('message', (_topic, buffer) => {
  const command = JSON.parse(buffer.toString());
  if (handled.has(command.commandId)) {
    client.publish(`relay/${nodeId}/ack`, JSON.stringify({ commandId: command.commandId, ok: true, duplicate: true }));
    return;
  }
  handled.add(command.commandId);
  if (handled.size > 200) handled.delete(handled.values().next().value);
  if (command.action === 'lamp_on') lampOn = true;
  if (command.action === 'lamp_off') lampOn = false;
  client.publish(`relay/${nodeId}/ack`, JSON.stringify({ commandId: command.commandId, ok: true }), { qos: 1 });
});

setInterval(() => {
  sequence += 1;
  client.publish(`relay/${nodeId}/status`, JSON.stringify({
    nodeId, role: 'terminal', online: true, sequence, mode: 'relay', upstream: 'RELAY-01', downstream: null,
    lastSeen: new Date().toISOString(), source: 'measured', firmware: 'linux-terminal-1.0.0', lampOn,
    temperature: null, humidity: null,
  }));
}, 1_000);

if (frameFile) setInterval(async () => {
  try {
    const frame = fs.readFileSync(frameFile);
    await fetch(`${frameEndpoint}/api/device/${nodeId}/frame`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-device-token': token, 'x-frame-rate': '1' }, body: frame,
    });
  } catch (error) { console.error('frame upload failed:', error.message); }
}, 1_000);
