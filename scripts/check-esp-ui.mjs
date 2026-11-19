import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'buffer/render_checks');
fs.mkdirSync(output, {recursive: true});
const base = process.env.ESP_UI_URL ?? 'http://127.0.0.1:8787';
const report = {errors: [], geometry: [], screenshots: [], live: null};
const browser = await chromium.launch({headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=swiftshader']});
try {
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(base, {waitUntil: 'domcontentloaded'});
  await page.locator('.esp-platform').waitFor({timeout: 15000});
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout: 30000});
  report.live = await (await page.request.get(base + '/api/snapshot')).json();
  if (!report.live.esp?.video?.online || report.live.camera.width !== 1280 || report.live.camera.height !== 720) throw Error('Native 720p camera did not connect');
  if (await page.getByText('模拟数据', {exact: true}).count()) throw Error('Live mode displayed simulated metrics');
  if (await page.getByText('点亮警示灯', {exact: true}).count()) throw Error('Unsupported lamp controls exposed');
  const image = await page.locator('.esp-video').evaluate(e => ({width: e.naturalWidth, height: e.naturalHeight, rotation: getComputedStyle(e).transform}));
  if (image.width !== 1280 || image.height !== 720 || !image.rotation.startsWith('matrix(-1')) throw Error('Native camera size/rotation mismatch');
  report.image = image;
  await page.waitForTimeout(1200);
  const canvasBuffer = await page.locator('canvas').screenshot();
  const png = PNG.sync.read(canvasBuffer), colors = new Set();
  for (let y = 0; y < png.height; y += 20) for (let x = 0; x < png.width; x += 20) {
    const i = (y * png.width + x) * 4; colors.add(`${png.data[i] >> 4}/${png.data[i+1] >> 4}/${png.data[i+2] >> 4}`);
  }
  if (colors.size < 15) throw Error('Campus canvas is blank');
  report.sceneColors = colors.size;
  for (const width of [1920, 1440, 1100, 768, 414, 375, 320]) {
    await page.setViewportSize({width, height: 1080}); await page.waitForTimeout(350);
    const g = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('.esp-video-metrics,.esp-detection,.three-modes,.panel-title')].filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.className)}));
    if (g.scroll > width + 1 || g.overflow.length) throw Error('Layout overflow ' + JSON.stringify(g));
    report.geometry.push(g);
    if ([1920, 1440, 375, 320].includes(width)) {
      const file = `esp-${width}.png`; await page.screenshot({path: path.join(output, file), fullPage: true}); report.screenshots.push(file);
    }
  }
  await page.setViewportSize({width: 1440, height: 1000});
  await page.getByRole('button', {name: '放大画面'}).click();
  await page.locator('.camera-expanded').waitFor();
  const expanded = await page.locator('.camera-expanded .camera-feed').boundingBox();
  if (!expanded || expanded.width < 900 || expanded.height < 300) throw Error('Expanded camera is too small or clipped');
  const unobstructed = await page.locator('.camera-expanded').evaluate(panel => {
    const b = panel.getBoundingClientRect();
    return [[.1,.1],[.9,.1],[.5,.5],[.9,.8]].every(([x,y]) => panel.contains(document.elementFromPoint(b.x+b.width*x,b.y+b.height*y)));
  });
  if (!unobstructed) throw Error('Expanded camera is obscured by scene labels or side panels');
  await page.screenshot({path: path.join(output, 'esp-expanded.png'), fullPage: true});
  await page.keyboard.press('Escape');
  await page.locator('.camera-expanded').waitFor({state: 'detached'});
  report.expanded = expanded;
  const detector = page.getByRole('switch', {name: '人物框选', exact: true});
  const initial = await detector.getAttribute('aria-checked');
  await detector.click();
  await page.waitForFunction(value => document.querySelector('[aria-label="人物框选"]').getAttribute('aria-checked') !== value, initial);
  await detector.click();
  await page.waitForFunction(value => document.querySelector('[aria-label="人物框选"]').getAttribute('aria-checked') === value, initial);
  report.detectionToggle = true;
  report.passed = !report.errors.length;
  if (!report.passed) throw Error(report.errors.join('\n'));
} finally {
  fs.writeFileSync(path.join(output, 'esp-ui.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({passed: report.passed, image: report.image, sceneColors: report.sceneColors, geometry: report.geometry, detectionToggle: report.detectionToggle}));
