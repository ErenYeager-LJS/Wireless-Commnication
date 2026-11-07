import net from 'node:net';
import mqtt from 'mqtt';

const targetHost = process.env.CONTROLLER_HOST ?? '192.168.50.10';
const mqttListenPort = Number(process.env.RELAY_MQTT_PORT ?? 1883);
const webListenPort = Number(process.env.RELAY_WEB_PORT ?? 8787);
const statusBroker = process.env.STATUS_BROKER ?? `mqtt://${targetHost}:1883`;
const token = process.env.DEVICE_TOKEN ?? 'relay-demo-token';
let forwardedPackets = 0;
let forwardedBytes = 0;
let sequence = 0;

function createProxy(listenPort, targetPort, label) {
  const server = net.createServer((downstream) => {
    const upstream = net.connect(targetPort, targetHost);
    downstream.on('data', (chunk) => { forwardedPackets += 1; forwardedBytes += chunk.length; });
    upstream.on('data', (chunk) => { forwardedPackets += 1; forwardedBytes += chunk.length; });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  server.listen(listenPort, '0.0.0.0', () => console.log(`${label} relay 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`));
  return server;
}

const mqttProxy = createProxy(mqttListenPort, 1883, 'MQTT');
const webProxy = createProxy(webListenPort, 8787, 'HTTP');

const client = mqtt.connect(statusBroker, { clientId: 'relay-agent-RELAY-01', username: 'relay', password: token });
setInterval(() => {
  sequence += 1;
  client.publish('relay/RELAY-01/status', JSON.stringify({
    nodeId: 'RELAY-01', role: 'relay', online: true, sequence, mode: 'relay',
    upstream: 'CONTROL-01', downstream: 'TERM-01', lastSeen: new Date().toISOString(),
    source: 'measured', firmware: 'linux-relay-1.0.0',
  }));
  client.publish('relay/RELAY-01/forwarding', JSON.stringify({
    timestamp: new Date().toISOString(), forwardedPackets, forwardedBytes,
  }));
}, 1_000);

process.on('SIGTERM', () => { mqttProxy.close(); webProxy.close(); client.end(); });
