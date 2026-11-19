import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright-core';

// Read-only video/render sampling. No camera, detector or route commands.
const base=process.env.ESP_UI_URL??'http://127.0.0.1:8787';
const output=path.resolve(import.meta.dirname,'../buffer/render_checks');
const hardware=process.env.ESP_RENDER_HARDWARE==='1';
const report={renderer:hardware?'Edge headless / default graphics backend':'Edge headless / SwiftShader',samples:[],errors:[]};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:hardware?[]:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>report.errors.push(e.message));
try{
  await page.goto(base+'/?view=scene-stream',{waitUntil:'domcontentloaded'});
  await page.locator('.esp-video:not(.not-loaded)').waitFor({timeout:30000});
  await page.waitForTimeout(2000);
  const snapshot=async()=>await(await page.request.get(base+'/api/snapshot')).json();
  const before=await snapshot();
  const animation=page.evaluate(async()=>{
    const intervals=[];let previous=performance.now();const start=previous;
    await new Promise(resolve=>{
      const tick=now=>{intervals.push(now-previous);previous=now;if(now-start>=20000)resolve();else requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    });
    intervals.sort((a,b)=>a-b);
    return {frames:intervals.length,seconds:(previous-start)/1000,p95Ms:intervals[Math.ceil(intervals.length*.95)-1],maxMs:intervals.at(-1)};
  });
  const start=performance.now();
  for(let i=0;i<20;i++){
    const s=await snapshot();report.samples.push({route:s.esp.video.route,online:s.esp.video.online,fps:s.esp.video.fps,loss:s.esp.video.frame_loss_percent});
    await page.waitForTimeout(1000);
  }
  const seconds=(performance.now()-start)/1000,after=await snapshot();
  report.video={seconds,receiverFps:(after.esp.video.received-before.esp.video.received)/seconds,resolution:after.esp.video.resolution,
    offlineSamples:report.samples.filter(s=>!s.online).length,route:after.esp.video.route};
  report.animation=await animation;
  report.graphics=await page.locator('canvas').evaluate(e=>({...e.dataset}));
  report.animation.browserRafFps=report.animation.frames/report.animation.seconds;
  report.passed=report.video.offlineSamples===0&&!report.errors.length;
}finally{
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'scene-stream.json'),JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify({passed:report.passed,video:report.video,animation:report.animation,errors:report.errors}));
