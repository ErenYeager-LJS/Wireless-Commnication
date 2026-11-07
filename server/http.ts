import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { CommandRecord, ServerMessage, Snapshot } from '../src/types.js';
import { config } from './config.js';
import { publishCommand, publishMode } from './mqtt-broker.js';
import { DemoSimulator } from './simulator.js';
import { platformState } from './state.js';

function sendJson(ws: import('ws').WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function createHttpApp(simulator: DemoSimulator | null): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, demoMode: config.demoMode, time: new Date().toISOString() }));
  app.get('/api/snapshot', (_req, res) => res.json(platformState.snapshot()));

  app.post('/api/mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'direct' && mode !== 'relay') return res.status(400).json({ error: 'mode must be direct or relay' });
    platformState.setMode(mode);
    publishMode(mode);
    return res.json(platformState.snapshot());
  });

  app.post('/api/commands', (req, res) => {
    const action = req.body?.action as CommandRecord['action'];
    const target = String(req.body?.target ?? 'TERM-01');
    if (!['lamp_on', 'lamp_off', 'alarm_reset'].includes(action)) return res.status(400).json({ error: 'unsupported action' });
    const command = platformState.createCommand(target, action);
    publishCommand(command);
    return res.status(202).json(command);
  });

  app.post('/api/demo/scenario', (req, res) => {
    if (!simulator) return res.status(409).json({ error: 'demo mode is disabled' });
    const scenario = req.body?.scenario as Snapshot['demoScenario'];
    if (!['steady', 'degraded', 'offline', 'alarm'].includes(scenario)) return res.status(400).json({ error: 'unsupported scenario' });
    simulator.setScenario(scenario);
    return res.json({ ok: true, scenario });
  });

  app.post('/api/device/:nodeId/frame', express.raw({ type: ['image/jpeg', 'image/png'], limit: '3mb' }), (req, res) => {
    if (req.header('x-device-token') !== config.deviceToken) return res.status(401).json({ error: 'invalid device token' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty frame' });
    fs.mkdirSync(config.framesDir, { recursive: true });
    const nodeId = req.params.nodeId.replace(/[^A-Za-z0-9_-]/g, '');
    const extension = req.is('image/png') ? 'png' : 'jpg';
    const filename = `${nodeId}.${extension}`;
    fs.writeFileSync(path.join(config.framesDir, filename), req.body);
    platformState.setCamera({
      nodeId, frameUrl: `/api/device/${nodeId}/frame?ts=${Date.now()}`, capturedAt: new Date().toISOString(),
      fps: Number(req.header('x-frame-rate') ?? 1), width: Number(req.header('x-frame-width') ?? 0),
      height: Number(req.header('x-frame-height') ?? 0), source: 'measured',
    });
    return res.status(204).end();
  });

  app.get('/api/device/:nodeId/frame', (req, res) => {
    const nodeId = req.params.nodeId.replace(/[^A-Za-z0-9_-]/g, '');
    const candidates = [`${nodeId}.jpg`, `${nodeId}.png`];
    const found = candidates.map((name) => path.join(config.framesDir, name)).find(fs.existsSync);
    if (!found) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(found);
  });

  app.get('/api/demo/frame.svg', (_req, res) => {
    const now = new Date();
    const terminal = platformState.nodes.get('TERM-01');
    const alarm = terminal?.alarm;
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-store');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
      <defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#18252b"/><stop offset="1" stop-color="#4d5b55"/></linearGradient></defs>
      <rect width="960" height="540" fill="url(#g)"/><path d="M0 400L180 260 390 350 610 190 960 330V540H0Z" fill="#223b35"/>
      <path d="M0 440H960M180 0V540M480 0V540M780 0V540" stroke="#9db2a7" stroke-opacity=".12"/>
      <rect x="658" y="128" width="130" height="188" rx="4" fill="#1b272b" stroke="#86a89a"/><circle cx="723" cy="214" r="18" fill="${alarm ? '#e34d4d' : '#40c982'}"/>
      <text x="34" y="50" fill="#eaf5ef" font-family="Segoe UI" font-size="24">地下设备走廊 · TERM-01</text>
      <text x="34" y="88" fill="#a9beb4" font-family="Consolas" font-size="18">${now.toLocaleString('zh-CN', { hour12: false })}  SIMULATED CAMERA</text>
      <path d="M36 112h180" stroke="${alarm ? '#e34d4d' : '#40c982'}" stroke-width="4"/>
      <text x="34" y="504" fill="#dbe8e1" font-family="Segoe UI" font-size="20">演示画面 · 非现场实拍</text>
    </svg>`);
  });

  if (fs.existsSync(config.distDir)) {
    app.use(express.static(config.distDir));
    app.get('*path', (_req, res) => res.sendFile(path.join(config.distDir, 'index.html')));
  }
  return app;
}

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => sendJson(ws, { type: 'snapshot', data: platformState.snapshot() }));
  platformState.onChange((snapshot) => wss.clients.forEach((ws) => sendJson(ws, { type: 'state', data: snapshot })));
  return wss;
}
