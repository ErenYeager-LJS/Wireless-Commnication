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
import type { EspBridge } from './esp-bridge.js';

function sendJson(ws: import('ws').WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function createHttpApp(simulator: DemoSimulator | null, bridge: EspBridge | null = null): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, demoMode: !bridge && config.demoMode, backend: bridge ? 'esp32' : 'mqtt', time: new Date().toISOString() }));
  app.get('/api/snapshot', (_req, res) => res.json(bridge ? bridge.snapshot() : platformState.snapshot()));

  if (bridge) {
    app.get('/api/esp/stream', (req, res) => bridge.stream(req, res));
    app.get('/api/esp/detection', (_req, res) => res.json(bridge.snapshot().esp?.detection ?? {fresh: false, boxes: []}));
    app.post(['/api/mode', '/api/esp/camera', '/api/esp/detection'], async (req, res) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
      const origin = req.get('origin');
      if (!local || (origin && origin !== `${req.protocol}://${req.get('host')}`)) return res.status(403).json({error: '仅允许本机页面控制 ESP'});
      if (!req.is('application/json')) return res.status(400).json({error: '请使用 JSON 指令'});
      const kind = req.path === '/api/mode' ? 'route' : req.path.endsWith('/camera') ? 'camera' : 'detection';
      const data = kind === 'route' ? {mode: req.body?.mode} : kind === 'camera' ? {camera: 'mipi', enabled: req.body?.enabled} : {enabled: req.body?.enabled};
      if (kind === 'route' ? !['direct', 'relay', 'auto'].includes(data.mode) : typeof data.enabled !== 'boolean') return res.status(400).json({error: '无效的控制参数'});
      try { return res.json(await bridge.command(kind, data)); }
      catch (error) { return res.status(503).json({error: error instanceof Error ? error.message : '控制失败'}); }
    });
    app.post('/api/commands', (_req, res) => res.status(409).json({error: '当前 OV5647 方案未接入警示灯和告警执行器'}));
    app.post('/api/device/:nodeId/frame', (_req, res) => res.status(409).json({error: 'ESP32 模式由本地 H.264 接收端提供画面'}));
  }

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

export function attachWebSocket(server: Server, bridge: EspBridge | null = null): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => sendJson(ws, { type: 'snapshot', data: bridge ? bridge.snapshot() : platformState.snapshot() }));
  const update = (snapshot: Snapshot) => wss.clients.forEach((ws) => { if (ws.bufferedAmount < 256 * 1024) sendJson(ws, { type: 'state', data: snapshot }); });
  const unsubscribe = bridge ? bridge.onChange(update) : platformState.onChange(update);
  wss.on('close', unsubscribe);
  return wss;
}
