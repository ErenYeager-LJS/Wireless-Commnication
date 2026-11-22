import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction, Express } from 'express';

export interface CloudSettings {
  public_host: string; web_port: number; device_port: number; control_port: number;
  device_id: string; device_token: string; control_key: string;
  web_user: string; password_salt: string; password_hash: string;
  certificate: string; private_key: string; detection_enabled: boolean;
}
export function loadCloudSettings(filename = process.env.CLOUD_CONFIG): CloudSettings | null {
  if (!filename) return null;
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8')) as CloudSettings;
  if (!raw.public_host || !raw.web_user || !/^[a-f0-9]{128}$/.test(raw.password_hash) ||
      !/^[a-f0-9]{32}$/.test(raw.password_salt) || !/^[a-f0-9]{64}$/.test(raw.device_token) ||
      !/^[a-f0-9]{64}$/.test(raw.control_key) || raw.detection_enabled !== false) {
    throw new Error('Invalid cloud configuration; first-stage detection must be disabled');
  }
  for (const name of ['web_port','device_port','control_port'] as const) {
    if (!Number.isInteger(raw[name]) || raw[name] < 1 || raw[name] > 65535) throw new Error('Invalid cloud port');
  }
  for (const name of ['certificate','private_key'] as const) raw[name] = path.resolve(path.dirname(filename), raw[name]);
  return raw;
}

const cookieName = '__Host-relay_session';
export class CloudAuth {
  private sessions = new Map<string, number>();
  private attempts = new Map<string, {count: number; until: number}>();
  constructor(readonly settings: CloudSettings) {}
  sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    const port = this.settings.web_port === 443 ? '' : `:${this.settings.web_port}`;
    return origin === `https://${this.settings.public_host}${port}`;
  }
  authorized(req: IncomingMessage): boolean {
    const token = /(?:^|;\s*)__Host-relay_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const expiry = token && this.sessions.get(token);
    if (!expiry || expiry <= Date.now()) {if (token) this.sessions.delete(token); return false;}
    return true;
  }
  install(app: Express): void {
    app.use((_req, res, next) => {
      res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
      next();
    });
    app.get('/login', (_req, res) => res.type('html').send(loginPage));
    app.post('/auth/login', (req, res) => {
      if (!this.sameOrigin(req)) return res.status(403).json({error:'请从当前 HTTPS 登录页提交'});
      const key = req.socket.remoteAddress ?? '?', now = Date.now();
      for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
      if (this.attempts.size > 256) return res.status(429).json({error:'请稍后再试'});
      const attempt = this.attempts.get(key) ?? {count:0,until:now+600_000};
      this.attempts.set(key, attempt);
      if (++attempt.count > 10) return res.status(429).json({error:'尝试次数过多，请十分钟后重试'});
      const {username,password} = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) return res.status(401).json({error:'账号或密码错误'});
      const hash = scryptSync(password, this.settings.password_salt, 64);
      if (username !== this.settings.web_user || !timingSafeEqual(hash, Buffer.from(this.settings.password_hash,'hex'))) return res.status(401).json({error:'账号或密码错误'});
      for (const [k,v] of this.sessions) if (v < now) this.sessions.delete(k);
      if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
      const token = randomBytes(32).toString('hex'); this.sessions.set(token, now+8*3600_000);
      res.cookie(cookieName,token,{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:8*3600_000});
      return res.json({ok:true});
    });
    app.get('/login.js', (_req,res)=>res.type('js').send(loginScript));
    app.get('/login.css', (_req,res)=>res.type('css').send(loginCss));
    app.use((req: Request,res: Response,next: NextFunction)=>{
      if (!this.authorized(req)) {
        if (req.method==='GET' && !req.path.startsWith('/api/')) return res.redirect('/login');
        return res.status(401).json({error:'请登录后继续'});
      }
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && !this.sameOrigin(req)) return res.status(403).json({error:'请求来源无效'});
      next();
    });
    app.post('/auth/logout',(req,res)=>{
      const token=/(?:^|;\s*)__Host-relay_session=([a-f0-9]{64})/.exec(req.headers.cookie??'')?.[1];
      if(token)this.sessions.delete(token);
      res.clearCookie(cookieName,{secure:true,httpOnly:true,sameSite:'strict',path:'/'}).json({ok:true});
    });
  }
}
const loginPage=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>麟盾 · 登录</title><link rel="stylesheet" href="/login.css"></head><body><main><p>麟盾 / 无人机图传</p><h1>登录云端工作台</h1><form><label>账号<input name="username" autocomplete="username" required maxlength="80"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>登录</button><output role="status"></output></form></main><script src="/login.js"></script></body></html>`;
const loginScript=`document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button'),out=form.querySelector('output');button.disabled=true;out.textContent='正在登录…';try{const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});const data=await r.json();if(!r.ok)throw Error(data.error);location.replace('/');}catch(e){out.textContent=e.message;}finally{button.disabled=false;}});`;
const loginCss=`:root{color-scheme:dark;font-family:'Segoe UI','Microsoft YaHei',sans-serif;background:#071019;color:#edf5f1}*{box-sizing:border-box}body{margin:0;min-width:320px;display:grid;min-height:100dvh;place-items:center;padding:24px}main{width:min(100%,400px)}p{color:#60e3b1}h1{font-size:28px;font-weight:600;margin:24px 0 32px}form,label{display:grid;gap:12px}form{gap:24px}input,button{font:inherit;min-height:48px;border:1px solid #425954;border-radius:6px;padding:12px;background:#122329;color:inherit;width:100%}button{background:#60e3b1;color:#10241e;cursor:pointer;font-weight:600}button:hover{filter:brightness(1.07)}button:disabled{opacity:.5;cursor:wait}input:focus-visible,button:focus-visible{outline:2px solid #a2f3d4;outline-offset:3px}output{min-height:24px;color:#ecc17c;font-size:14px}`;
