import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const base = process.env.ESP_UI_URL ?? 'http://127.0.0.1:8787';
const out = path.join(root, 'buffer/render_checks');
fs.mkdirSync(out, {recursive: true});
const report = {started: new Date().toISOString(), controls: [], samples: [], errors: []};
const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const snapshot = async () => (await (await page.request.get(base + '/api/snapshot')).json());
const waitState = async (condition, timeout = 40000) => {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const s = await snapshot(); if (condition(s)) return s;
    await page.waitForTimeout(250);
  }
  throw Error('Hardware state did not settle');
};
const route = async mode => {
  const start = performance.now();
  await page.locator('.three-modes').getByRole('button', {name: mode === 'relay' ? '经中继' : mode === 'direct' ? '直连' : '自动', exact: true}).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.three-modes button')].some(b => b.disabled), undefined, {timeout: 40000});
  const s = await waitState(s => s.esp.control?.last_mode === mode && (mode === 'auto' || !s.esp.video?.enabled || s.esp.video?.online && s.mode === mode));
  if (await page.locator('.operation-error').count()) throw Error(await page.locator('.operation-error').innerText());
  const result = {kind: 'route', mode, durationMs: Math.round(performance.now() - start), actualRoute: s.mode, cameraEnabled: s.esp.video.enabled};
  report.controls.push(result); console.log(JSON.stringify(result));
};
try {
  await page.goto(base, {waitUntil: 'domcontentloaded'});
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout: 30000});
  await route('direct');
  await route('relay');
  const camera = page.getByRole('switch', {name: '摄像头传输', exact: true});
  await camera.click();
  await waitState(s => !s.esp.video.enabled && !s.esp.video.online);
  await page.waitForTimeout(1000);
  const paused = await snapshot(); await page.waitForTimeout(1200); const paused2 = await snapshot();
  if (paused.esp.video.received !== paused2.esp.video.received || await page.locator('.esp-video').count() || await page.locator('.person-box').count()) throw Error('Paused video or boxes did not stop');
  report.controls.push({kind: 'pause', receivedStable: paused2.esp.video.received});
  await route('direct');
  await camera.click(); await waitState(s => s.esp.video.enabled && s.esp.video.online && s.mode === 'direct');
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout: 30000});
  report.controls.push({kind: 'resume', success: true});
  await route('relay');
  await page.waitForTimeout(5000);
  const before = await snapshot();
  const abort = new AbortController();
  const durationMs = Number(process.env.ESP_SAMPLE_MS ?? 60000);
  const marker = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n');
  let frames = 0, maxGapMs = 0, previous = null, pending = Buffer.alloc(0);
  const started = performance.now();
  const stream = (async () => {
    try {
      const response = await fetch(base + '/api/esp/stream', {signal: abort.signal});
      if (!response.ok) throw Error('Proxy stream HTTP ' + response.status);
      for await (const chunk of response.body) {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        let index;
        while ((index = pending.indexOf(marker)) >= 0) {
          const now = performance.now(); if (previous !== null) maxGapMs = Math.max(maxGapMs, now - previous);
          previous = now; frames++; pending = pending.subarray(index + marker.length);
        }
        if (pending.length > marker.length) pending = pending.subarray(pending.length - marker.length);
      }
    } catch (e) {if (!abort.signal.aborted) throw e;}
  })();
  while (performance.now() - started < durationMs) {
    const s = await snapshot(); report.samples.push({at: new Date().toISOString(), video: s.esp.video, detection: s.esp.detection && {fps: s.esp.detection.fps, fresh: s.esp.detection.fresh, error: s.esp.detection.error}});
    await page.waitForTimeout(500);
  }
  abort.abort(); await stream;
  const elapsed = (performance.now() - started) / 1000; const after = await snapshot();
  report.measurement = {seconds: elapsed, resolution: after.esp.video.resolution, route: after.mode,
    receiverFps: (after.esp.video.received - before.esp.video.received) / elapsed, proxyFrames: frames, proxyFps: frames / elapsed, maxProxyGapMs: maxGapMs,
    offlineSamples: report.samples.filter(s => !s.video.online).length, maxFrameLossPercent: Math.max(...report.samples.map(s => s.video.frame_loss_percent ?? 0)),
    browserRenderer: 'Edge headless with SwiftShader; actual ESP hardware and live Three.js scene'};
  report.measurement.meets30Fps = report.measurement.receiverFps >= 30 && report.measurement.proxyFps >= 30;
  await page.screenshot({path: path.join(out, 'esp-relay-live.png'), fullPage: true});
  await route('auto');
  report.functionalPassed = !report.errors.length;
  console.log(JSON.stringify(report.measurement));
} catch (e) {report.errors.push(String(e)); throw e;}
finally {
  report.ended = new Date().toISOString(); fs.writeFileSync(path.join(out, 'esp-live.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
