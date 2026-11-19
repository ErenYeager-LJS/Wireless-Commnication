import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..'), base = process.env.ESP_UI_URL ?? 'http://127.0.0.1:8787';
const output = path.join(root, 'buffer/render_checks'); fs.mkdirSync(output, {recursive: true});
const report = {errors: [], routes: [], layout: [], foldable: false};
const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--use-angle=swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
page.on('pageerror', e => report.errors.push(e.message));
const initial = await (await page.request.get(base + '/api/snapshot')).json();
async function route(mode) {
  await page.locator('.three-modes').getByRole('button', {name: mode === 'direct' ? '直连' : '经中继', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('.three-modes button').disabled, undefined, {timeout: 40000});
  await page.waitForFunction(mode => document.querySelector('[data-testid="aircraft-label"]')?.dataset.route === mode && document.querySelector('[data-testid="aircraft-label"]')?.dataset.online === 'true', mode, {timeout: 30000});
  if (await page.locator('.operation-error').count()) throw Error(await page.locator('.operation-error').innerText());
  await page.waitForTimeout(4000);
  const positions = [];
  for (let i = 0; i < 10; i++) {
    const sample = await page.getByTestId('aircraft-label').evaluate(e => ({position:e.dataset.position,radius:Number(e.dataset.radius),center:e.dataset.center}));
    const raw = sample.position;
    if (!raw) throw Error('Missing aircraft position');
    const [x,y,z] = JSON.parse(raw);
    const radius = sample.radius;
    const [cx,cz] = JSON.parse(sample.center);
    positions.push([x,y,z]);
    if (Math.abs(y - 18) > .001 || Math.abs(Math.hypot(x-cx,z-cz)-radius) > .001) throw Error('Aircraft left its elevated RSSI orbit: '+JSON.stringify(sample));
    await page.waitForTimeout(100);
  }
  if (Math.hypot(positions.at(-1)[0]-positions[0][0],positions.at(-1)[2]-positions[0][2]) < .5) throw Error('Aircraft stopped while live signal remained online');
  report.routes.push({mode, positions});
  await page.screenshot({path: path.join(output, `flight-${mode}.png`), fullPage: true});
}
try {
  await page.goto(base + '/?view=flight', {waitUntil: 'domcontentloaded'});
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout: 30000});
  if (await page.locator('.disclosure-panel').count() !== 5 || await page.locator('.disclosure-panel[open]').count()) throw Error('Secondary panels should start folded');
  const detail = page.locator('.disclosure-panel').first();
  await detail.locator('summary').click(); await page.getByText('实际图像来源', {exact: false}).waitFor();
  await detail.locator('summary').click(); report.foldable = true;
  await route('direct'); await route('relay');
  for (const width of [1920, 1440, 1100, 768, 414, 375, 320]) {
    await page.setViewportSize({width, height: 1000}); await page.waitForTimeout(350);
    const layout = await page.evaluate(() => {
      const wrap = document.querySelector('.scene-wrap').getBoundingClientRect();
      const labels = [...document.querySelectorAll('.flight-label,.scene-label')].map(e => {const b=e.getBoundingClientRect(); return {text:e.textContent, x:b.x,y:b.y,width:b.width,height:b.height,font:getComputedStyle(e).fontSize,visible:b.left>=wrap.left-1&&b.right<=wrap.right+1&&b.top>=wrap.top&&b.bottom<=wrap.bottom};});
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,labels};
    });
    const overlap = layout.labels.some((a,i) => layout.labels.slice(i+1).some(b => Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>2 && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>2));
    if (layout.scroll > width+1 || overlap || layout.labels.some(l => !l.visible || parseFloat(l.font) < 14)) throw Error('Unreadable/clipped scene labels: '+JSON.stringify(layout));
    report.layout.push(layout);
    if ([1440,375,320].includes(width)) await page.screenshot({path:path.join(output,`flight-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  const before = await page.locator('.scene-wrap').boundingBox();
  await page.getByRole('button',{name:'收起视频侧栏',exact:true}).click();
  await page.getByRole('button',{name:'收起控制侧栏',exact:true}).click();
  await page.waitForTimeout(500);
  const after=await page.locator('.scene-wrap').boundingBox();
  if(after.width < before.width+600) throw Error('Folding side rails did not release scene space');
  await page.screenshot({path:path.join(output,'flight-rails-folded.png'),fullPage:true});
  await page.getByRole('button',{name:'展开视频侧栏',exact:true}).click();
  await page.getByRole('button',{name:'展开控制侧栏',exact:true}).click();
  await page.locator('.esp-video:not(.not-loaded)').waitFor(); report.rails=true;
  report.passed=!report.errors.length;
} catch(e) {report.errors.push(String(e)); throw e;}
finally {
  const mode=initial.esp?.control?.last_mode;
  if(mode) {
    const r=await page.request.post(base+'/api/mode',{data:{mode},timeout:40000});
    report.restoredMode=mode;report.restoreStatus=r.status();
  }
  fs.writeFileSync(path.join(output,'flight-ui.json'),JSON.stringify(report,null,2));
  await browser.close();
}
console.log(JSON.stringify({passed:report.passed,foldable:report.foldable,rails:report.rails,widths:report.layout.map(l=>l.width),restoredMode:report.restoredMode}));
