import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts');
fs.mkdirSync(output, { recursive: true });
const executablePath = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function canvasHasPixels(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  let opaque = 0;
  for (let y = 0; y < png.height; y += 12) for (let x = 0; x < png.width; x += 12) {
    const index = (png.width * y + x) * 4;
    if (png.data[index + 3] > 200) opaque += 1;
    colors.add(`${png.data[index] >> 4},${png.data[index + 1] >> 4},${png.data[index + 2] >> 4}`);
  }
  return opaque > 100 && colors.size > 12;
}

for (const device of [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: device.width, height: device.height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:8787', { waitUntil: 'networkidle' });
  await page.locator('canvas').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_500);
  const canvasBox = await page.locator('canvas').boundingBox();
  if (!canvasBox) throw new Error(`${device.name}: canvas has no bounds`);
  const canvasImage = await page.screenshot({ path: path.join(output, `${device.name}-canvas.png`), clip: canvasBox });
  if (!(await canvasHasPixels(canvasImage))) throw new Error(`${device.name}: Three.js canvas is blank`);
  await page.screenshot({ path: path.join(output, `${device.name}.png`), fullPage: true });
  if (errors.length) throw new Error(`${device.name}: ${errors.join('; ')}`);
  if (device.name === 'desktop') {
    const droneLabel = page.getByText('UAV-01');
    await droneLabel.waitFor({ state: 'visible' });
    const before = await droneLabel.boundingBox();
    await page.waitForTimeout(900);
    const after = await droneLabel.boundingBox();
    if (!before || !after || Math.hypot(after.x - before.x, after.y - before.y) < 2) {
      throw new Error('desktop: patrol drone did not move');
    }
    await page.getByRole('button', { name: '退化' }).click();
    await page.getByText('链路退化').waitFor();
    await page.getByTitle('楼层抽出').click();
    await page.waitForTimeout(500);
  }
  console.log(`${device.name}: canvas and layout verified`);
  await page.close();
  await browser.close();
}

await fetch('http://127.0.0.1:8787/api/demo/scenario', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'steady' }),
});
await fetch('http://127.0.0.1:8787/api/mode', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'relay' }),
});
