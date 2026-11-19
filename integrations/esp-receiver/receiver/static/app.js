"use strict";
const el = id => document.getElementById(id);
const names = {direct: "直连", relay: "中继"};
const modeNames = {auto: "自动切换", direct: "强制直连", relay: "强制中继"};
const cameraNames = {mipi: "OV5647"};
const cameras = {
  mipi: {image: "video", empty: "empty", title: "empty-title", note: "empty-note", count: "received", source: "source", age: "age"},
};
let busy = false;
let controlsEnabled = false;
let selectedMode = null;
let eventKey = "";
const allButtons = () => document.querySelectorAll("button[data-mode], button[data-camera]");
for (const [id, c] of Object.entries(cameras)) {
  c.open = false; c.failed = false; c.status = null;
  el(c.image).addEventListener("error", () => { c.failed = true; });
  document.querySelector(`button[data-camera="${id}"]`).addEventListener("click", () => toggleCamera(id));
}
function stopStream(c) {
  if (c.open) el(c.image).removeAttribute("src");
  c.open = false;
  el(c.image).hidden = true;
  el(c.empty).hidden = false;
}
function renderCamera(id, s) {
  const c = cameras[id];
  c.status = s;
  const enabled = s.enabled !== false;
  const online = enabled && s.online;
  const state = el(`${id}-state`);
  state.textContent = !enabled ? "传输已关闭" : online ? "正在接收" : s.received ? "连接中断" : "等待连接";
  state.dataset.state = !enabled ? "paused" : online ? "online" : "offline";
  const button = document.querySelector(`button[data-camera="${id}"]`);
  button.setAttribute("aria-checked", String(enabled));
  button.setAttribute("aria-label", `${enabled ? "关闭" : "开启"}${cameraNames[id]}传输`);
  button.querySelector(".switch-label").textContent = enabled ? "开启" : "关闭";
  el(`${id}-fps`).textContent = online ? s.fps.toFixed(1) : enabled ? "0.0" : "—";
  const loss = el(`${id}-loss`);
  loss.textContent = online && s.frame_loss_percent != null ? s.frame_loss_percent.toFixed(1) : "—";
  loss.dataset.warning = String(online && s.frame_loss_percent > 25);
  el(c.count).textContent = new Intl.NumberFormat("zh-CN").format(s.received || 0);
  el(c.source).textContent = `${s.codec || "H.264"}${s.ssid ? ` · ${s.ssid}` : ""}`;
  el(c.age).textContent = !enabled ? "板端传输已暂停" : s.age_ms == null ? "等待图像" : s.age_ms < 1000 ? `更新于 ${s.age_ms} ms 前` : `更新于 ${(s.age_ms / 1000).toFixed(1)} s 前`;
  el(`${id}-resolution`).textContent = (s.resolution || "—").replace("x", " × ");
  if (online) {
    if (!c.open || c.failed) {
      el(c.image).src = `/stream?camera=${id}&t=${Date.now()}`;
      c.open = true; c.failed = false;
    }
    const loaded = el(c.image).naturalWidth > 0;
    el(c.image).hidden = !loaded;
    el(c.empty).hidden = loaded;
    el(c.title).textContent = "正在接收画面";
    el(c.note).textContent = "等待浏览器解码第一帧";
    el(`${id}-live`).hidden = !loaded;
  } else {
    stopStream(c);
    el(`${id}-live`).hidden = true;
    el(c.title).textContent = !enabled ? "传输已关闭" : s.received ? "图像连接已中断" : "等待第一帧";
    el(c.note).textContent = !enabled ? "打开上方开关，恢复这一路画面" : s.received ? "连接恢复后自动继续" : "摄像头连接后自动显示画面";
  }
}
function renderLink() {
  const list = Object.values(cameras).map(c => c.status).filter(Boolean);
  const online = list.filter(s => s.online && s.enabled !== false);
  const allPaused = list.length === 1 && list.every(s => s.enabled === false);
  const active = online[0] || list.find(s => s.route);
  el("connection").textContent = allPaused ? "传输已关闭" : online.length ? "OV5647 在线" : "等待摄像头连接";
  el("global-dot").dataset.state = online.length ? "online" : "offline";
  el("route").textContent = online.length ? names[active.route] : allPaused ? "已暂停传图" : "未连接";
  el("topology").dataset.route = online.length ? active.route : "offline";
  el("topology").setAttribute("aria-label", online.length ? active.route === "relay" ? "摄像头经中继、路由器传输到本机" : "摄像头经路由器直连本机，中继待机" : "当前未收到图像");
  el("relay-node-state").textContent = online.length && active.route === "relay" ? "转发中" : "待机";
  el("router-name").textContent = active && active.ssid !== "DEMO_RELAY" ? active.ssid || "路由器" : "路由器";
  el("rssi").textContent = online.length ? `${active.rssi} dBm` : "—";
  const events = Object.entries(cameras).flatMap(([id, c]) => (c.status?.events || []).map(e => ({...e, cameraId: id})));
  events.sort((a, b) => b.time.localeCompare(a.time));
  const latest = events.find(e => e.kind === "switch");
  el("gap").textContent = latest ? `${(latest.gap_ms / 1000).toFixed(2)} s` : "—";
  renderEvents(events.slice(0, 100));
}
function renderEvents(events) {
  const key = events.map(e => `${e.cameraId}:${e.time}:${e.id}`).join("|");
  if (key === eventKey) return;
  eventKey = key;
  if (!events.length) return;
  el("event-list").replaceChildren();
  const kinds = {session: "开始接收", switch: "切换路径", offline: "接收中断", resume: "恢复画面"};
  for (const e of events) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = e.time;
    time.textContent = new Date(e.time).toLocaleTimeString("zh-CN", {hour12: false});
    const label = document.createElement("span");
    label.textContent = `${e.cameraId.toUpperCase()} · ${kinds[e.kind] || e.kind}${e.route ? ` · ${names[e.route]}` : ""}`;
    const gap = document.createElement("span"); gap.className = "event-gap";
    gap.textContent = e.gap_ms != null ? `间隔 ${(e.gap_ms / 1000).toFixed(2)} s` : "";
    li.append(time, label, gap); el("event-list").append(li);
  }
}
async function getJSON(path, options = {}) {
  const response = await fetch(path, {cache: "no-store", signal: AbortSignal.timeout(8000), ...options});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
async function poll() {
  const results = await Promise.allSettled(Object.keys(cameras).map(async id => [id, await getJSON(`/status?camera=${id}`, {signal: AbortSignal.timeout(2000)})]));
  let good = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]; const id = Object.keys(cameras)[i];
    if (r.status === "fulfilled") { renderCamera(...r.value); good++; }
    else { renderCamera(id, {...cameras[id].status, online: false, events: cameras[id].status?.events || []}); }
  }
  renderLink();
  el("service-state").textContent = good === 1 ? "接收服务在线" : "接收服务不可达，请检查启动窗口";
  setTimeout(poll, 500);
}
function setBusy(value) {
  busy = value;
  allButtons().forEach(b => { b.disabled = value || !controlsEnabled; });
}
async function sendControl(path, data, button) {
  setBusy(true); button.setAttribute("aria-busy", "true"); button.dataset.state = "loading";
  try {
    const result = await getJSON(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
    if (!result.acknowledged) throw new Error("摄像头未确认无线指令，请检查网络连接");
    if (path === "/control/route" && data.mode !== "auto") {
      // The route ACK is deliberately sent before Wi-Fi disconnects. Wait
      // for a fresh poll after that departure, including with video paused.
      const started = performance.now();
      let settled = false;
      while (performance.now() - started < 25000) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const state = await getJSON("/control", {signal: AbortSignal.timeout(2000)});
        if (performance.now() - started >= 1500 && state.wireless_online &&
            state.heartbeat_age_ms < 750 && state.last_mode === data.mode) {
          settled = true; break;
        }
      }
      if (!settled) throw new Error("已确认选路，但无线连接尚未恢复，请等待后重试");
    }
    button.dataset.state = "success";
    return result;
  } catch (e) { button.dataset.state = "error"; throw e; }
  finally { button.removeAttribute("aria-busy"); setBusy(false); }
}
async function toggleCamera(id) {
  if (busy) return;
  const button = document.querySelector(`button[data-camera="${id}"]`);
  const status = cameras[id].status || {};
  const enabled = status.enabled === false;
  const text = el(`${id}-command`);
  text.dataset.error = "false"; text.textContent = `正在${enabled ? "开启" : "关闭"}板端传输…`;
  try {
    await sendControl("/control/camera", {camera: id, enabled}, button);
    renderCamera(id, {...status, enabled, online: false}); renderLink();
    text.textContent = "";
  } catch (e) {
    text.dataset.error = "true";
    text.textContent = e.name === "TimeoutError" ? "无线指令超时，请检查网络连接后重试" : e.message;
  }
}
for (const button of document.querySelectorAll("button[data-mode]")) {
  button.addEventListener("click", async () => {
    if (busy) return;
    const mode = button.dataset.mode; const text = el("control-result");
    text.dataset.error = "false"; text.textContent = `正在发送${modeNames[mode]}指令…`;
    try {
      await sendControl("/control/route", {mode}, button);
      selectedMode = mode;
      document.querySelectorAll("button[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === selectedMode)));
      text.textContent = mode === "auto" ? "已恢复自动选路，实际路径见上方链路" : `已连接${modeNames[mode]}，实际画面见上方`;
    } catch (e) {
      text.dataset.error = "true";
      text.textContent = e.name === "TimeoutError" ? "无线指令超时，请检查网络连接后重试" : e.message;
    }
  });
}
async function initControls() {
  try {
    const state = await getJSON("/control");
    if (!state.enabled) return;
    controlsEnabled = true; setBusy(false); el("route-controls").hidden = false;
    selectedMode = state.last_mode;
    if (selectedMode) {
      document.querySelectorAll("button[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === selectedMode)));
      el("control-result").textContent = `已确认：${modeNames[selectedMode]}，实际路径以上方为准`;
    }
  } catch { el("service-state").textContent = "控制不可用，请检查本机接收端"; }
}
el("history-link").addEventListener("click", () => { el("events").open = true; });

// Detection is asynchronous; video remains the original full-rate MJPEG feed.
let detectionStatus = null;
let detectionReceived = 0;
let detectionBusy = false;
let detectionConnected = false;
function drawPeople() {
  const overlay = el("person-overlay"), image = el("video");
  overlay.replaceChildren();
  const s = detectionStatus;
  if (!s?.fresh || !s.enabled || image.hidden || !image.naturalWidth ||
      cameras.mipi.status?.online === false || cameras.mipi.status?.enabled === false ||
      (cameras.mipi.status?.boot_id && cameras.mipi.status.boot_id !== s.boot_id) ||
      performance.now() - detectionReceived + s.age_ms >= s.ttl_ms) return;
  // Match object-fit:contain, including the short-screen letterbox layout.
  const scale = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  const ox = (image.clientWidth - w) / 2, oy = (image.clientHeight - h) / 2;
  for (const b of s.boxes) {
    const box = document.createElement("div"); box.className = "person-box";
    Object.assign(box.style, {left: `${ox + b.x * w}px`, top: `${oy + b.y * h}px`, width: `${b.width * w}px`, height: `${b.height * h}px`});
    const label = document.createElement("span"); label.className = "person-label";
    label.textContent = `人 · ${Math.round(b.confidence * 100)}%`;
    box.append(label); overlay.append(box);
  }
}
function renderDetection(s) {
  detectionStatus = s; detectionReceived = performance.now();
  const button = el("person-toggle"), state = el("person-state");
  button.disabled = detectionBusy || !detectionConnected;
  button.setAttribute("aria-checked", String(s.enabled));
  button.setAttribute("aria-label", `${s.enabled ? "关闭" : "开启"}人物框选`);
  button.querySelector(".switch-label").textContent = s.enabled ? "开启" : "关闭";
  const messages = {disabled: "已关闭", loading: "正在加载模型…", waiting: "等待摄像头画面", warming: "正在检测…", error: "检测不可用，请检查接收端"};
  state.textContent = s.fresh ? `检测到 ${s.count} 人` : messages[s.state] || "等待检测";
  state.dataset.state = s.state;
  state.title = s.error || "人物检测在本机运行；遮挡、暗光及小目标可能漏检或误检";
  el("person-rate").textContent = s.fresh ? `${s.fps.toFixed(1)} Hz · ${Math.round(s.inference_ms)} ms` : "—";
  drawPeople();
}
async function pollDetection() {
  try {
    const s = await getJSON("/detection", {signal: AbortSignal.timeout(2000)});
    detectionConnected = true;
    if (!detectionBusy) renderDetection(s);
  } catch {
    detectionConnected = false;
    detectionStatus = null; drawPeople();
    el("person-toggle").disabled = true;
    el("person-state").textContent = "检测服务未连接";
    el("person-rate").textContent = "—";
  }
  setTimeout(pollDetection, 100);
}
el("person-toggle").addEventListener("click", async () => {
  if (detectionBusy || !detectionStatus) return;
  detectionBusy = true;
  const button = el("person-toggle"); button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const s = await getJSON("/control/detection", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({enabled: !detectionStatus.enabled})});
    renderDetection(s);
  } catch (e) {
    el("person-state").textContent = e.message;
    el("person-state").dataset.state = "error";
  } finally {
    detectionBusy = false; button.disabled = !detectionConnected; button.removeAttribute("aria-busy");
  }
});
new ResizeObserver(drawPeople).observe(el("video"));
// Expire boxes even if the next HTTP poll hangs or the camera stops.
setInterval(drawPeople, 100);
pollDetection();
poll(); initControls();
