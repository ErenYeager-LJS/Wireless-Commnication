import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EspBridge, makeEspSnapshot } from '../server/esp-bridge.js';
import type { EspSnapshot, ReceiverStatus } from '../src/types.js';

function state(): EspSnapshot {
  return {receiverAvailable: true, error: null, updatedAt: new Date().toISOString(),
    video: {online: true, enabled: true, fps: 31.2, received: 100, age_ms: 10, frame_loss_percent: 0,
      frame_id: 100, boot_id: 'test', route: 'relay', resolution: '1280x720', width: 1280, height: 720,
      source_ip: '192.168.0.102', events: []},
    control: {enabled: true, wireless_online: true, heartbeat_age_ms: 10, last_mode: 'relay', cameras: {mipi: true}, transport: 'wifi'},
    detection: {enabled: true, ready: true, fresh: true, state: 'active', error: null, count: 1,
      boxes: [{x: .1, y: .2, width: .3, height: .4, confidence: .9}], fps: 9, inference_ms: 80, age_ms: 100, ttl_ms: 700, boot_id: 'test'},
    transport: null, paths: {direct: null, relay: null}};
}

test('maps actual relay frames to topology without inventing network statistics', () => {
  const snapshot = makeEspSnapshot(state());
  assert.equal(snapshot.mode, 'relay'); assert.equal(snapshot.health, 'normal');
  assert.equal(snapshot.nodes.find(n => n.role === 'relay')?.online, true);
  assert.equal(snapshot.metric, null); assert.equal(snapshot.camera.width, 1280);
  assert.equal(snapshot.camera.frameUrl, '/api/esp/stream');
  assert.equal(snapshot.commands.length, 0);
  assert.equal(snapshot.nodes[0].temperature, undefined);
});

test('offline and paused frames never remain LIVE or keep person boxes', () => {
  const s = state(); s.video!.online = false;
  const snapshot = makeEspSnapshot(s);
  assert.equal(snapshot.health, 'offline'); assert.equal(snapshot.camera.frameUrl, null);
  assert.deepEqual(snapshot.esp?.detection?.boxes, []);
  assert.equal(snapshot.nodes.find(n => n.role === 'relay')?.online, false);
  assert.equal(snapshot.nodes[0].online, true); // Separate Wi-Fi control heartbeat.
});

test('stale receiver snapshot is invalidated rather than displaying old telemetry', () => {
  const s = state(); s.updatedAt = new Date(Date.now() - 3_000).toISOString();
  const snapshot = makeEspSnapshot(s);
  assert.equal(snapshot.esp?.receiverAvailable, false);
  assert.equal(snapshot.esp?.control?.wireless_online, false);
  assert.equal(snapshot.camera.frameUrl, null);
});

test('disabled camera suppresses a late online status and detection boxes', () => {
  const s = state(); s.video!.enabled = false;
  const snapshot = makeEspSnapshot(s);
  assert.equal(snapshot.camera.frameUrl, null);
  assert.equal(snapshot.esp?.video?.online, false);
  assert.deepEqual(snapshot.esp?.detection?.boxes, []);
});

test('direct evidence never reports relay as forwarding', () => {
  const s = state(); s.video!.route = 'direct';
  const snapshot = makeEspSnapshot(s);
  assert.equal(snapshot.mode, 'direct');
  assert.equal(snapshot.nodes[0].upstream, 'CONTROL-01');
  assert.equal(snapshot.nodes[1].online, false);
});

test('rejects remote receiver addresses', () => {
  assert.throws(() => new EspBridge('http://192.168.0.101:8080'));
  assert.throws(() => new EspBridge('https://127.0.0.1:8080'));
});

test('HTTP adapter forwards real control and refreshes status; failed ACK is not success', async () => {
  const s = state();
  let acknowledge = true;
  const requests: {path: string; body: unknown}[] = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      const buffers = []; for await (const part of req) buffers.push(part);
      const data = JSON.parse(Buffer.concat(buffers).toString());
      requests.push({path: req.url!, body: data});
      if (req.url === '/control/detection') {s.detection!.enabled = data.enabled; return res.end(JSON.stringify(s.detection));}
      res.end(JSON.stringify({acknowledged: acknowledge})); return;
    }
    const result = req.url === '/status' ? s.video : req.url === '/control' ? s.control : req.url === '/detection' ? s.detection : {h264: null};
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = new EspBridge(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    await bridge.poll();
    assert.equal(bridge.snapshot().camera.fps, 31.2);
    assert.equal(bridge.state.paths.relay?.resolution, '1280x720');
    await bridge.command('detection', {enabled: false});
    assert.equal(bridge.state.detection?.enabled, false);
    await bridge.command('camera', {camera: 'mipi', enabled: false});
    assert.deepEqual(requests.at(-1), {path: '/control/camera', body: {camera: 'mipi', enabled: false}});
    acknowledge = false;
    await assert.rejects(bridge.command('route', {mode: 'auto'}), /确认/);
  } finally {bridge.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  await bridge.poll();
  assert.equal(bridge.snapshot().esp?.video?.online, false);
});

test('ESP API validates wireless commands and never falls through to MQTT controls', async () => {
  const {createHttpApp} = await import('../server/http.js');
  const bridge = new EspBridge('http://127.0.0.1:8080');
  const calls: unknown[] = [];
  bridge.command = async (kind, data) => {calls.push({kind, data}); return {acknowledged: true};};
  const server = http.createServer(createHttpApp(null, bridge));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: object, origin?: string) => fetch(base + p, {method: 'POST',
    headers: {'Content-Type': 'application/json', ...(origin ? {Origin: origin} : {})}, body: JSON.stringify(body)});
  try {
    assert.equal((await post('/api/mode', {mode: 'relay'}, 'https://unrelated.invalid')).status, 403);
    assert.equal((await post('/api/mode', {mode: 'bad'})).status, 400);
    assert.equal((await post('/api/esp/camera', {enabled: 'false'})).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await post('/api/mode', {mode: 'auto'}, base)).status, 200);
    assert.equal((await post('/api/esp/camera', {enabled: false}, base)).status, 200);
    assert.equal((await post('/api/esp/detection', {enabled: true}, base)).status, 200);
    assert.deepEqual(calls, [{kind: 'route', data: {mode: 'auto'}},
      {kind: 'camera', data: {camera: 'mipi', enabled: false}}, {kind: 'detection', data: {enabled: true}}]);
    assert.equal((await post('/api/commands', {action: 'lamp_on'})).status, 409);
    bridge.command = async () => {throw Error('No device ACK');};
    assert.equal((await post('/api/mode', {mode: 'relay'})).status, 503);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('closing the browser video releases the upstream receiver connection', async () => {
  const {createHttpApp} = await import('../server/http.js');
  let released!: () => void;
  const closed = new Promise<void>(resolve => {released = resolve;});
  const receiver = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'multipart/x-mixed-replace; boundary=frame'});
    const send = () => res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n');
    send(); const timer = setInterval(send, 10);
    res.on('close', () => {clearInterval(timer); released();});
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const bridge = new EspBridge(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`);
  const server = http.createServer(createHttpApp(null, bridge));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/esp/stream`, {signal: abort.signal});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /multipart/);
    await response.body!.getReader().read(); abort.abort();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('Upstream video leaked')), 1500).unref())]);
  } finally {
    server.closeAllConnections(); receiver.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => receiver.close(() => resolve()))]);
  }
});
