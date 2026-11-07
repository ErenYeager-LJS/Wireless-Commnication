import 'dotenv/config';
import http from 'node:http';
import { config } from './config.js';
import { createHttpApp, attachWebSocket } from './http.js';
import { startMqtt, stopMqtt } from './mqtt-broker.js';
import { DemoSimulator } from './simulator.js';
import { platformState } from './state.js';

await startMqtt();
const simulator = config.demoMode ? new DemoSimulator() : null;
simulator?.start();
const server = http.createServer(createHttpApp(simulator));
attachWebSocket(server);
const offlineTimer = setInterval(() => platformState.markStaleNodesOffline(), 1_000);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[platform] Web:  http://localhost:${config.port}`);
  console.log(`[platform] MQTT: mqtt://localhost:${config.mqttPort}`);
  console.log(`[platform] Mode: ${config.demoMode ? 'SIMULATED DEMO' : 'MEASURED DEVICE'}`);
});

const shutdown = async () => {
  simulator?.stop();
  clearInterval(offlineTimer);
  server.close();
  await stopMqtt();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
