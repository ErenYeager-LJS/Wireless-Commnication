import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {PNG} from 'pngjs';

const base=process.env.ESP_UI_URL??'http://127.0.0.1:8787';
const output=path.resolve(import.meta.dirname,'../buffer/render_checks');
fs.mkdirSync(output,{recursive:true});
const hardware=process.env.ESP_RENDER_HARDWARE==='1';
const report={environment:hardware?'Edge headless / default graphics backend':'Edge headless / SwiftShader; browser checks are not hardware GPU benchmarks',errors:[],layout:[]};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:hardware?[]:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.on('pageerror',e=>report.errors.push(e.message));
try{
  await page.goto(base+'/?view=architectural',{waitUntil:'domcontentloaded'});
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout:30000});
  await page.waitForFunction(()=>Number(document.querySelector('canvas')?.dataset.sceneDrawCalls)>0);
  await page.waitForTimeout(1200);
  await page.screenshot({path:path.join(output,'scene-desktop.png'),fullPage:true});
  const canvas=page.locator('canvas');
  report.renderer=await canvas.evaluate(e=>({...e.dataset}));
  if(Number(report.renderer.sceneDrawCalls)>160)throw Error('Scene draw-call budget exceeded: '+report.renderer.sceneDrawCalls);
  if(report.renderer.shadowUpdates!=='false')throw Error('Static architectural shadow cache was disabled');
  const png=PNG.sync.read(await canvas.screenshot()),colors=new Set();
  for(let y=0;y<png.height;y+=8)for(let x=0;x<png.width;x+=8){const i=(y*png.width+x)*4;colors.add(`${png.data[i]>>4},${png.data[i+1]>>4},${png.data[i+2]>>4}`);}
  report.colors=colors.size;if(colors.size<30)throw Error('Architectural scene is blank or lacks surface detail');
  report.image=await page.locator('.esp-video').evaluate(e=>({width:e.naturalWidth,height:e.naturalHeight,rotation:getComputedStyle(e).transform}));
  if(report.image.width!==1280||report.image.height!==720||!report.image.rotation.startsWith('matrix(-1'))throw Error('Live video changed dimensions/rotation');
  await page.getByRole('button',{name:'收起视频侧栏',exact:true}).click();
  await page.getByRole('button',{name:'收起控制侧栏',exact:true}).click();
  await page.waitForTimeout(500);
  await page.screenshot({path:path.join(output,'scene-overview.png'),fullPage:true});
  const before=await page.getByTestId('aircraft-label').getAttribute('data-position');
  await page.waitForTimeout(1000);
  const after=await page.getByTestId('aircraft-label').getAttribute('data-position');
  const a=JSON.parse(before),b=JSON.parse(after);
  if(Math.hypot(a[0]-b[0],a[2]-b[2])<.5||b[1]!==18)throw Error('Raised circular flight stopped');
  report.flight=true;
  await page.getByTitle('楼层抽出',{exact:true}).click();
  await page.getByTitle('建筑透明',{exact:true}).click();
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(output,'scene-exploded.png'),fullPage:true});
  await page.getByTitle('建筑透明',{exact:true}).click();
  await page.getByTitle('楼层抽出',{exact:true}).click();
  await page.getByRole('button',{name:'展开视频侧栏',exact:true}).click();
  await page.getByRole('button',{name:'展开控制侧栏',exact:true}).click();
  for(const width of [1920,1440,1280,1100,768,414,375,320]){
    await page.setViewportSize({width,height:1000});await page.waitForTimeout(400);
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
      overflow:[...document.querySelectorAll('.esp-video-metrics,.three-modes,.panel-title')].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>e.className)}));
    if(layout.scroll>width+1||layout.overflow.length)throw Error('Scene layout overflow: '+JSON.stringify(layout));
    report.layout.push(layout);
    if([1440,768,375,320].includes(width))await page.screenshot({path:path.join(output,`scene-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'放大画面',exact:true}).click();
  await page.locator('.camera-expanded').waitFor();
  report.modal=await page.locator('.camera-expanded').evaluate(e=>{const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));});
  if(!report.modal)throw Error('Scene obscured the expanded camera');
  await page.keyboard.press('Escape');
  report.status=await(await page.request.get(base+'/api/snapshot')).json();
  report.passed=!report.errors.length;
  if(!report.passed)throw Error(report.errors.join('\n'));
}catch(e){report.errors.push(String(e));throw e;}
finally{fs.writeFileSync(path.join(output,'scene-quality.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({passed:report.passed,renderer:report.renderer,colors:report.colors,widths:report.layout.map(x=>x.width),flight:report.flight,modal:report.modal}));
