import 'dotenv/config';
import http from 'node:http';
import { config } from './config.js';
import { createHttpApp, attachWebSocket } from './http.js';
import { startMqtt, stopMqtt } from './mqtt-broker.js';
import { DemoSimulator } from './simulator.js';
import { platformState } from './state.js';
import { EspBridge } from './esp-bridge.js';

if (!config.espMode) await startMqtt();
const bridge = config.espMode ? new EspBridge(config.espReceiverUrl) : null;
bridge?.start();
const simulator = !bridge && config.demoMode ? new DemoSimulator() : null;
simulator?.start();
const server = http.createServer(createHttpApp(simulator, bridge));
attachWebSocket(server, bridge);
const offlineTimer = setInterval(() => { if (!bridge) platformState.markStaleNodesOffline(); }, 1_000);

server.listen(config.port, config.espMode ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`[platform] Web:  http://localhost:${config.port}`);
  console.log(`[platform] ${bridge ? `ESP receiver: ${config.espReceiverUrl}` : `MQTT: mqtt://localhost:${config.mqttPort}`}`);
  console.log(`[platform] Mode: ${bridge ? 'ESP32-P4 / OV5647 LIVE' : config.demoMode ? 'SIMULATED DEMO' : 'MEASURED DEVICE'}`);
});

const shutdown = async () => {
  simulator?.stop();
  bridge?.stop();
  clearInterval(offlineTimer);
  server.close();
  if (!bridge) await stopMqtt();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
