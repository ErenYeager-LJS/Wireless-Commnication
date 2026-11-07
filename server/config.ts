import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  projectRoot,
  dataDir: path.join(projectRoot, 'data'),
  framesDir: path.join(projectRoot, 'data', 'frames'),
  distDir: path.join(projectRoot, 'dist'),
  port: intEnv('PORT', 8787),
  mqttPort: intEnv('MQTT_PORT', 1883),
  demoMode: (process.env.DEMO_MODE ?? 'true').toLowerCase() === 'true',
  deviceToken: process.env.DEVICE_TOKEN ?? 'relay-demo-token',
  offlineTimeoutMs: intEnv('OFFLINE_TIMEOUT_MS', 5_000),
  degradedRttMs: intEnv('DEGRADED_RTT_MS', 120),
  degradedLossPercent: intEnv('DEGRADED_LOSS_PERCENT', 5),
};
