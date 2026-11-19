import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';

// Browser-only signal fixture; never sends a Wi-Fi command or changes server telemetry.
const base=process.env.ESP_UI_URL??'http://127.0.0.1:8787';
const output=path.resolve(import.meta.dirname,'../buffer/render_checks');
const report={type:'browser RSSI fixture, not RF distance evidence',errors:[],samples:[]};
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let fixtureRssi=-33;
try {
  await page.routeWebSocket('**/ws',ws=>{
    const upstream=ws.connectToServer();
    upstream.onMessage(raw=>{
      const message=JSON.parse(String(raw));
      if(message.data?.esp?.video){
        message.data.source='simulated';message.data.mode='direct';
        message.data.esp.video={...message.data.esp.video,rssi:fixtureRssi,route:'direct',online:true,enabled:true};
      }
      ws.send(JSON.stringify(message));
    });
  });
  await page.goto(base+'/?view=orbit-fixture',{waitUntil:'domcontentloaded'});
  const aircraft=page.getByTestId('aircraft-label');
  await aircraft.waitFor();
  await page.waitForTimeout(1500);
  const read=()=>aircraft.evaluate(e=>({rssi:e.textContent,position:JSON.parse(e.dataset.position),radius:Number(e.dataset.radius),target:Number(e.dataset.targetRadius),angle:Number(e.dataset.angle)}));
  const a=await read();fixtureRssi=-35;
  await page.waitForFunction(radius=>Number(document.querySelector('[data-testid="aircraft-label"]').dataset.targetRadius)>radius,a.target);
  await page.waitForTimeout(250);const b=await read();
  await page.waitForTimeout(900);const c=await read();
  if(!(b.target>a.target&&b.radius>a.radius&&c.radius>b.radius))throw Error('Strong RSSI change did not smoothly expand the orbit');
  for(const s of [a,b,c])if(Math.abs(s.position[1]-18)>.001)throw Error('Aircraft altitude not raised');
  if(Math.hypot(c.position[0]-a.position[0],c.position[2]-a.position[2])<1)throw Error('Circular flight stopped');
  report.samples=[a,b,c];report.passed=true;
} catch(e){report.errors.push(String(e));throw e;}
finally{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'orbit-rssi-fixture.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
