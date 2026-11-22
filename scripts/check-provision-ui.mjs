import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'buffer/provision/ui');
fs.mkdirSync(out,{recursive:true});
const pageSource=fs.readFileSync(path.join(root,'integrations/esp-firmware/common/provision.html'));
const state={active:true,testing:false,online:false,remaining_s:25,hotspot:'DEMO_CAM_SETUP_TEST',ip:'192.168.5.1',ssid:'',message:'等待手机添加网络',saved:['<img src=x onerror=alert(1)>'],token:'fixture-only'};
const submitted=[];
const server=http.createServer(async(req,res)=>{
 if(req.url==='/wifi/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
 if(req.url==='/wifi/config'){const chunks=[];for await(const chunk of req)chunks.push(chunk);submitted.push(JSON.parse(Buffer.concat(chunks)));state.testing=true;state.message='正在连接';res.setHeader('Content-Type','application/json');res.end('{"accepted":true}');return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(pageSource);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;const errors=[];
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.getByText('DEMO_CAM_SETUP_TEST',{exact:true}).waitFor();
 assert.equal(await page.locator('#saved img').count(),0);
 for(const width of [320,375,414,768]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(out,`setup-${width}.png`),fullPage:true});
 }
 await page.getByLabel('Wi-Fi 名称',{exact:true}).fill('场馆临时热点');
 await page.getByLabel('Wi-Fi 密码',{exact:true}).fill('short');
 await page.getByRole('button',{name:'连接并保存',exact:true}).click();
 await page.getByText('请检查密码长度；开放网络可留空。',{exact:true}).waitFor();assert.equal(submitted.length,0);
 await page.getByLabel('Wi-Fi 密码',{exact:true}).fill('demo-test-password');
 await page.getByLabel('显示密码',{exact:true}).check();
 assert.equal(await page.locator('#password').getAttribute('type'),'text');
 await page.getByRole('button',{name:'连接并保存',exact:true}).click();
 await page.getByRole('button',{name:'正在连接…',exact:true}).waitFor();
 assert.equal(submitted.length,1);assert.equal(submitted[0].ssid,'场馆临时热点');assert.equal(submitted[0].token,'fixture-only');
 assert.equal(await page.getByRole('button',{name:'正在连接…',exact:true}).isDisabled(),true);
 state.testing=false;state.active=false;state.online=true;state.ssid='场馆临时热点';state.message='已连接并保存';state.remaining_s=0;
 await page.getByText(/已联网，配网窗口已关闭/).waitFor();
 assert.equal(await page.locator('#submit').isDisabled(),true);
 assert.equal(await page.locator('#password').inputValue(),'');assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,widths:[320,375,414,768],checks:['untrusted SSID stays text','client byte/password validation','Chinese SSID submission','no duplicate while connecting','closed setup read-only','cleared submitted password'],errors},null,2));
 console.log('Provision UI: mobile layouts, validation, safe SSIDs, submit, busy and success states passed');
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
