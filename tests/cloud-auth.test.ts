import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import { CloudAuth, type CloudSettings } from '../server/cloud-auth.js';
import { attachWebSocket } from '../server/http.js';

test('cloud login protects pages, stream, APIs and WebSocket; CSRF and logout work',async()=>{
  const salt='12'.repeat(16);
  const settings={public_host:'cloud.test',web_port:443,web_user:'tester',password_salt:salt,
    password_hash:scryptSync('test-password',salt,64).toString('hex')} as CloudSettings;
  const auth=new CloudAuth(settings);
  const app=express();app.use(express.json());auth.install(app);
  app.get('/',(_req,res)=>res.send('protected UI'));
  app.get('/api/esp/stream',(_req,res)=>res.send('protected stream'));
  app.post('/api/mode',(_req,res)=>res.json({ok:true}));
  const server=http.createServer(app);const wss=attachWebSocket(server,null,auth);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as import('node:net').AddressInfo).port,base=`http://127.0.0.1:${port}`;
  const origin='https://cloud.test';
  try{
    assert.equal((await fetch(base,{redirect:'manual'})).status,302);
    assert.equal((await fetch(base+'/api/esp/stream')).status,401);
    assert.equal((await fetch(base+'/api/mode',{method:'POST',headers:{'Content-Type':'application/json',origin},body:'{}'})).status,401);
    const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify({username:'tester',password:'test-password'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie')!;
    assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
    assert.equal((await fetch(base,{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/mode',{method:'POST',headers:{cookie,origin:'https://evil.test'}})).status,403);
    assert.equal((await fetch(base+'/api/mode',{method:'POST',headers:{cookie,origin}})).status,200);
    await new Promise<void>((resolve,reject)=>{
      const socket=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin});
      socket.on('unexpected-response',(_req,response)=>{try{assert.equal(response.statusCode,401);response.resume();resolve();}catch(e){reject(e);}});
      socket.on('open',()=>{socket.close();reject(Error('Unauthenticated WS opened'));});socket.on('error',()=>{});
    });
    await new Promise<void>((resolve,reject)=>{
      const socket=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin,headers:{cookie}});
      socket.on('message',()=>{socket.close();resolve();});socket.on('error',reject);
    });
    assert.equal((await fetch(base+'/auth/logout',{method:'POST',headers:{cookie,origin}})).status,200);
    assert.equal((await fetch(base+'/api/esp/stream',{headers:{cookie}})).status,401);
    for(let i=0;i<12;i++)await fetch(base+'/auth/login',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:'{"username":"tester","password":"wrong"}'});
    assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:'{}'})).status,429);
  }finally{wss.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
