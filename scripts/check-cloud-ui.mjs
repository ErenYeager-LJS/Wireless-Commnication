import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {scryptSync} from 'node:crypto';
import {chromium} from 'playwright-core';

const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'buffer/cloud-ui');fs.mkdirSync(out,{recursive:true});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const settings=JSON.parse(fs.readFileSync(path.join(root,'deploy/private/cloud.json'),'utf8'));
Object.assign(settings,{public_host:'127.0.0.1',web_port:port,certificate:path.join(root,'deploy/private/server-cert.pem'),private_key:path.join(root,'deploy/private/server-key.pem'),web_user:'test',password_salt:'12'.repeat(16),password_hash:scryptSync('test-password','12'.repeat(16),64).toString('hex')});
const config=path.join(out,'cloud.json');fs.writeFileSync(config,JSON.stringify(settings));
const log=fs.openSync(path.join(out,'web.log'),'w');
const report={scope:'local browser fixture; TLS trust separately checked by Python TLS test',errors:[],widths:[]};
let browser;
try{
  // Use the actual compiled entry point with an absolute path.
  const child=spawn(process.execPath,[path.join(root,'buffer/cloud-runtime/server/index.js')],{cwd:root,env:{...process.env,PROJECT_ROOT:root,CLOUD_CONFIG:config,PLATFORM_BACKEND:'esp32',ESP_RECEIVER_URL:'http://127.0.0.1:1'},stdio:['ignore',log,log]});
  report.pid=child.pid;
  try{
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>report.errors.push(e.message));
    let ready=false;
    for(let i=0;i<30;i++){try{await page.goto(`https://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded',timeout:1500});ready=true;break;}catch{await page.waitForTimeout(100);}}
    if(!ready)throw Error('Local cloud UI failed to start');
    await page.getByRole('heading',{name:'登录云端工作台'}).waitFor();
    await page.setViewportSize({width:320,height:800});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Login overflow');
    await page.screenshot({path:path.join(out,'login-320.png'),fullPage:true});
    await page.getByLabel('账号').fill('test');await page.getByLabel('密码').fill('test-password');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.locator('.esp-platform').waitFor({timeout:20000});
    await page.getByRole('button',{name:'退出登录'}).waitFor();
    for(const width of [1920,1440,768,414,375,320]){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(150);
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Cloud UI overflow '+width);
      report.widths.push(width);
    }
    await page.screenshot({path:path.join(out,'cloud-320.png'),fullPage:true});
    await page.getByRole('button',{name:'退出登录'}).click();
    await page.getByRole('heading',{name:'登录云端工作台'}).waitFor();
    report.logout=true;report.passed=!report.errors.length;
    if(!report.passed)throw Error(report.errors.join('\n'));
  }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
}finally{
  await browser?.close();fs.closeSync(log);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
