// vdesk-monitor.mjs -- live view + takeover window for the CHILD SESSION virtual desktop.
// Generated from the isolated-desktop monitor.mjs by make-vdesk-monitor.mjs.
// Serves a dark-card page on 127.0.0.1:8791; frames and input go to the in-session helper
// (127.0.0.1:8790). VIEW-ONLY until the user presses 接管 -- nothing touches the host's own
// mouse or keyboard.
// Live monitor + remote control window for the isolated guest desktop.
//
// Why not VMConnect: with Enhanced Session Mode enabled, VMConnect connects over
// RDP, so what the user sees can be a DIFFERENT desktop from the console screen
// the in-guest agent captures. This monitor serves the agent's own frames, so
// the user and the AI are guaranteed to be looking at the same screen.
//
// Serves:
//   /                      -> the page (dark card styling, auto-refreshing image)
//   /shot                  -> proxied PNG from the guest agent
//   /meta                  -> guest health (computer name, resolution)
//   /mouse?action=...&x=&y -> transparent pass-through to the agent (down / up /
//                             dragmove / click / scroll)
//   /key?action=...        -> transparent pass-through to the agent (text / vk /
//                             combo)
//
// Input model, matched to how a real mouse and keyboard behave:
//   * mousedown -> "down", throttled mousemove -> "dragmove", mouseup -> "up"
//   * keydown -> text for printable characters, vk for named keys (Backspace,
//     Enter, arrows, F-keys...), combo when Ctrl/Alt is held
//
// Read-only until the user actually presses a mouse button or a key. Nothing
// here touches the HOST's mouse or keyboard: every event is injected inside the
// virtual machine.

import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { readFileSync, openSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = Number(process.env.DSH_VDESK_MONITOR_PORT || 8791);
const AGENT_PORT = Number(process.env.VDESK_HELPER_PORT || 8790);
const AGENT_HOST = "127.0.0.1";

let cachedIp = null;
let cachedAt = 0;

async function guestIp() {
  return AGENT_HOST;
}

const TOKEN_FILE = process.env.VDESK_TOKEN_FILE || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/token";

// Every 8790 route except /health needs X-VDesk-Token. The file is re-read per call so a rotated
// token is picked up without restarting; a missing/invalid file omits the header, the helper
// answers 401 and the routes below pass that through as unauthorized.
function readToken() {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    return /^[0-9a-fA-F]{32}$/.test(t) ? t : null;
  } catch { return null; }
}

function vdeskHeaders() {
  const h = {};
  const t = readToken();
  if (t) h["X-VDesk-Token"] = t;
  return h;
}

// 8791 is for BROWSERS, which cannot read a local file and therefore cannot present a token, so
// the monitor authenticates itself to 8790 and guards the browser with an origin allowlist: the
// DSH UI origins, null (file:// pages) and the monitor own page (its toolbar is same-origin).
const ALLOWED_ORIGINS = new Set([
  "dsh-app://app",
  "http://127.0.0.1:19387",
  "http://localhost:19387",
  "null",
  "http://127.0.0.1:" + PORT
]);
// Only these routes change machine state. Read-only routes (/shot, /meta, /vdesk/status,
// /vdesk/task) stay open so the panel and the screenshot flow keep working for the UI.
const WRITE_ROUTES = new Set(["/vdesk/start", "/vdesk/stop", "/vdesk/restart", "/vdesk/window", "/mouse", "/key", "/click", "/input"]);

const CERT_PIN_FILE = process.env.VDESK_CERT_PIN || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/helper-cert.sha256";
const TRANSPORT_TTL_MS = 5000;
let helperTransport = { scheme: null, pin: null, at: 0, reason: "" };
let lastTransportNote = "";

// The helper serves a SELF-SIGNED certificate, so the trust anchor is the SHA-256 in
// helper-cert.sha256, not the chain. Any failure only drops back to plain http: the panel must
// never stop working because of the TLS rollout (the admin netsh binding may still be missing).
function readCertPin() {
  try {
    const t = readFileSync(CERT_PIN_FILE, "utf8").toLowerCase().replace(/[^0-9a-f]/g, "");
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch { return null; }
}

function noteTransport(t) {
  const key = t.scheme + ":" + t.reason;
  if (key === lastTransportNote) return;
  lastTransportNote = key;
  const line = "vdesk-monitor: helper transport -> " + t.scheme + " (" + t.reason + ")";
  // probe/fallback chatter is debug-only; a pin REFUSAL is always printed
  if (t.refused) console.log("vdesk-monitor: REFUSED " + line);
  else if (process.env.VDESK_DEBUG === "1") console.log(line);
}

function resetTransport(why) {
  helperTransport = { scheme: null, pin: null, at: 0, reason: why || "" };
}

function rawAgentRequest(ip, t, pathQuery, timeoutMs, method, body) {
  return new Promise((resolve, reject) => {
    const mod = t.scheme === "https" ? https : http;
    const headers = vdeskHeaders();
    if (body) { headers["content-type"] = "application/json; charset=utf-8"; headers["content-length"] = String(body.length); }
    const options = { host: ip, port: AGENT_PORT, path: pathQuery, method: method || "GET", headers: headers };
    if (t.scheme === "https") {
      options.rejectUnauthorized = false;
      options.checkServerIdentity = () => undefined;
    }
    let done = false;
    const fail = (e) => { if (done) return; done = true; resetTransport("transport error: " + String((e && e.message) || e)); reject(e); };
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, contentType: res.headers["content-type"] || "", body: Buffer.concat(chunks) });
      });
    });
    if (t.scheme === "https") {
      req.on("socket", (s) => {
        s.on("secureConnect", () => {
          try {
            const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : null;
            const fp = String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase();
            if (!fp || fp !== t.pin) req.destroy(new Error("certificate pin mismatch (got " + (fp ? fp.slice(0, 16) : "none") + "..., pinned " + String(t.pin).slice(0, 16) + "...)"));
          } catch (e) { req.destroy(new Error("pin check failed: " + String((e && e.message) || e))); }
        });
      });
    }
    req.setTimeout(timeoutMs, () => req.destroy(new Error("agent timeout after " + timeoutMs + "ms")));
    req.on("error", fail);
    req.end(body || undefined);
  });
}

async function resolveTransport(force) {
  const now = Date.now();
  if (!force && helperTransport.scheme && now - helperTransport.at < TRANSPORT_TTL_MS) return helperTransport;
  if (process.env.VDESK_HTTP_ONLY === "1") {
    helperTransport = { scheme: "http", pin: null, at: now, reason: "VDESK_HTTP_ONLY=1" };
    noteTransport(helperTransport);
    return helperTransport;
  }
  const pin = readCertPin();
  if (!pin) {
    helperTransport = { scheme: "http", pin: null, at: now, reason: "no helper-cert.sha256 yet -- plain http" };
    noteTransport(helperTransport);
    return helperTransport;
  }
  try {
    await rawAgentRequest("127.0.0.1", { scheme: "https", pin: pin }, "/health", 2500);
    helperTransport = { scheme: "https", pin: pin, at: now, reason: "pinned https" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/pin mismatch|pin check failed/i.test(msg)) {
      helperTransport = { scheme: "https", pin: pin, at: now, reason: msg, refused: true };
    } else {
      helperTransport = { scheme: "http", pin: null, at: now, reason: "https probe failed (" + msg + ") -> plain http" };
    }
  }
  noteTransport(helperTransport);
  return helperTransport;
}

// P4: live MJPEG cannot go through agentRequest() -- that buffers the whole body and a
// stream never ends. This pipes the helper's multipart response straight through, passes
// a non-200 (401 unauthorized) out as JSON, and destroys the upstream request when the
// browser goes away (that is what ends the helper's capture loop and releases it).
function pipeAgentStream(pathQuery, res) {
  return resolveTransport(false).then((t) => new Promise((resolve) => {
    const mod = t.scheme === "https" ? https : http;
    const options = { host: AGENT_HOST, port: AGENT_PORT, path: pathQuery, method: "GET", headers: vdeskHeaders() };
    if (t.scheme === "https") { options.rejectUnauthorized = false; options.checkServerIdentity = () => undefined; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const upstream = mod.request(options, (r) => {
      if (r.statusCode !== 200) {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          res.writeHead(r.statusCode || 502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(Buffer.concat(chunks));
          finish();
        });
        return;
      }
      res.writeHead(200, {
        "content-type": r.headers["content-type"] || "multipart/x-mixed-replace; boundary=dshframe",
        "cache-control": "no-store",
      });
      r.pipe(res);
      r.on("end", finish);
      r.on("error", finish);
    });
    if (t.scheme === "https") {
      upstream.on("socket", (s) => s.on("secureConnect", () => {
        try {
          const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : null;
          const fp = String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase();
          if (!fp || fp !== t.pin) upstream.destroy(new Error("certificate pin mismatch"));
        } catch (e) { upstream.destroy(e); }
      }));
    }
    // browser closed the tab / img -> drop the helper request so its loop exits
    res.on("close", () => { try { upstream.destroy(); } catch { } finish(); });
    upstream.on("error", () => {
      if (!res.headersSent) {
        try { res.writeHead(502, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "stream unavailable" })); } catch { }
      }
      finish();
    });
    upstream.end();
  })).catch(() => {
    if (!res.headersSent) {
      try { res.writeHead(502, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "helper unreachable" })); } catch { }
    }
  });
}

// P4: /input is a normal buffered request, so it reuses rawAgentRequest with a body.
async function agentInput(pathQuery, body) {
  const ip = await guestIp();
  const t = await resolveTransport(false);
  return rawAgentRequest(ip, t, pathQuery, 30000, "POST", body);
}

function readRequestBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n <= (limit || 1048576)) chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

// P4 click mapping: the panel sends NORMALISED coordinates (px / rect.width); <=1 is a
// fraction of the desktop, >1 stays pixels -- the same px() rule vdesk-cli/plugin use --
// clamped into the desktop size the helper reports.
function resolveNorm(v, dim) {
  const d = dim > 0 ? dim : 1280;
  const n = v <= 1 ? Math.round(v * d) : Math.round(v);
  return Math.max(0, Math.min(d - 1, n));
}

function helperDesktopSize() {
  const h = healthCache();
  if (h && h.width > 0 && h.height > 0) return { width: h.width, height: h.height };
  return { width: 1280, height: 800 };
}

async function agentRequest(pathQuery, timeoutMs = 20000) {
  const ip = await guestIp();
  const t = await resolveTransport(false);
  return rawAgentRequest(ip, t, pathQuery, timeoutMs);
}

const PAGE = [
  "<!doctype html>",
  "<html lang=\"zh-CN\">",
  "<head>",
  "<meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
  "<title>DSH 虚拟桌面</title>",
  "<style>",
  "  :root {",
  "    color-scheme: dark;",
  "    --bg:#0D0F14; --panel:#171A21; --panel2:#12151B; --line:#232833;",
  "    --ink:#D6DCE8; --muted:#7B8496; --dim:#5A6273;",
  "    --ok:#38D39F; --warn:#FFB020; --bad:#FF6B5E; --accent:#6FA8FF;",
  "  }",
  "  * { box-sizing:border-box; }",
  "  html, body {",
  "    margin:0; height:100%; overflow:hidden; background:var(--bg); color:var(--ink);",
  "    font:13px/1.5 \"Segoe UI\", system-ui, sans-serif;",
  "    user-select:none; -webkit-user-select:none;",
  "  }",
  "  body { display:flex; flex-direction:column; }",
  "",
  "  /* 顶部一条品牌渐变线：把窗口和「运载窗口」的深色卡片语言接上 */",
  "  #brandline { height:2px; flex:0 0 auto;",
  "    background:linear-gradient(90deg, var(--ok), var(--accent) 58%, #B58BFF); opacity:.85; }",
  "",
  "  header { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:10px 14px;",
  "    background:linear-gradient(180deg,#171A21,#0D0F14); border-bottom:1px solid var(--line); }",
  "  #dot { width:10px; height:10px; border-radius:50%; background:var(--ok);",
  "    box-shadow:0 0 10px var(--ok); transition:background .2s ease, box-shadow .2s ease; }",
  "  #dot.stale { background:var(--warn); box-shadow:0 0 10px var(--warn); }",
  "  #dot.dead  { background:var(--bad);  box-shadow:0 0 10px var(--bad); }",
  "  .titles { display:flex; flex-direction:column; gap:1px; min-width:0; }",
  "  .title { font-weight:650; font-size:14px; letter-spacing:.02em; }",
  "  .sub { color:var(--muted); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
  "  .pills { margin-left:auto; display:flex; gap:8px; align-items:center; }",
  "  .pill { font-size:11.5px; padding:3px 9px; border-radius:999px; border:1px solid var(--line);",
  "    background:var(--panel2); color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }",
  "  .pill.ok  { color:var(--ok);     border-color:#24463A; background:#12241D; }",
  "  .pill.act { color:var(--accent); border-color:#26364F; background:#121A26; }",
  "",
  "  main { flex:1 1 auto; min-height:0; display:flex; align-items:center; justify-content:center; padding:12px; }",
  "  #frame { position:relative; display:flex; max-width:100%; max-height:100%; border-radius:10px;",
  "    border:1px solid #2A303C; background:#0A0C10; overflow:hidden;",
  "    box-shadow:0 14px 44px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.02); }",
  "  #screen { max-width:100%; max-height:100%; display:block; cursor:default; -webkit-user-drag:none; }",
  "  #screen.grabbing { cursor:grabbing; }",
  "",
  "  footer { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:9px 14px; font-size:12px;",
  "    color:var(--muted); border-top:1px solid var(--line); background:var(--panel2); }",
  "  #status.act { color:var(--ok); }",
  "  #status.bad { color:var(--bad); }",
  "  #hint { color:var(--dim); }",
  "  .tools { margin-left:auto; display:flex; gap:8px; }",
  "  button.tool { font:inherit; font-size:12px; color:var(--ink); background:var(--panel);",
  "    border:1px solid var(--line); border-radius:7px; padding:4px 11px; cursor:pointer;",
  "    transition:border-color .15s ease, background .15s ease, transform .06s ease; }",
  "  button.tool:hover { border-color:#3A4252; background:#1D212A; }",
  "  button.tool:active { transform:translateY(1px); }",
  "</style>",
  "</head>",
  "<body>",
  "  <div id=\"brandline\"></div>",
  "  <header>",
  "    <span id=\"dot\"></span>",
  "    <span class=\"titles\">",
  "      <span class=\"title\">DSH 虚拟桌面</span>",
  "      <span class=\"sub\" id=\"host\">子会话 · 连接中…</span>",
  "    </span>",
  "    <span class=\"pills\">",
  "      <span class=\"pill ok\" id=\"kbPill\">键盘已接入</span>",
"      <span class=\"pill\" id=\"takePill\">只读</span>",
  "      <span class=\"pill\" id=\"sizePill\">—</span>",
  "      <span class=\"pill\" id=\"fpsPill\">— fps</span>",
  "    </span>",
  "  </header>",
  "  <main>",
  "    <div id=\"frame\"><img id=\"screen\" alt=\"waiting for first frame\"></div>",
  "  </main>",
  "  <footer>",
  "    <span id=\"status\">连接中…</span>",
  "    <span id=\"hint\">直接操作（点「交还」切回只读）· 左键点击 / 拖拽 · 右键 · 滚轮 · 直接打字</span>",
  "    <span class=\"tools\">",
  "      <button class=\"tool\" id=\"btnShot\" title=\"把当前这一帧存成 PNG\">截一帧</button>",
  "      <button class=\"tool\" id=\"btnFull\" title=\"全屏 / 退出全屏\">全屏</button>",
"      <button class=\"tool\" id=\"btnQ\" title=\"清晰度 / 帧率取舍\">清晰</button>",
"      <button class=\"tool\" id=\"btnTake\" title=\"允许把本窗口的鼠标/键盘送进这个桌面\">接管</button>",
  "    </span>",
  "  </footer>",
  "<script>",
  "  var img = document.getElementById('screen');",
  "  var statusEl = document.getElementById('status');",
  "  var hostEl = document.getElementById('host');",
  "  var dot = document.getElementById('dot');",
"  var takePill = document.getElementById('takePill');",
"  var btnTake = document.getElementById('btnTake');",
"  var taking = true;",
"  function renderTake() { takePill.textContent = taking ? '接管中' : '只读'; takePill.className = 'pill ' + (taking ? 'act' : 'ok'); btnTake.textContent = taking ? '交还' : '接管'; }",
"  function toggleTake() {",
"    var next = !taking;",
"    fetch('/takeover?on=' + (next ? '1' : '0')).then(function () { taking = next; renderTake(); flash(next ? '已接管：鼠标键盘会送进这个桌面' : '已交还：恢复只读查看'); }).catch(function () {});",
"  }",
"  btnTake.addEventListener('click', toggleTake);",
"  document.getElementById('btnQ').addEventListener('click', function () {",
"    qIdx = (qIdx + 1) % qNames.length;",
"    frameScale = qScales[qIdx];",
"    this.textContent = qNames[qIdx];",
"    flash('画质：' + qNames[qIdx] + (frameScale < 1 ? '（更流畅）' : '（最清晰）'));",
"  });",
"  renderTake();",
  "  var fpsPill = document.getElementById('fpsPill');",
  "  var sizePill = document.getElementById('sizePill');",
  "  var frames = 0, lastFps = Date.now(), fps = 0, failures = 0;",
"  var deskW = 1280, deskH = 800, frameScale = 1.0;",
"  var qNames = ['清晰', '流畅', '极速'], qScales = [1.0, 0.75, 0.5], qIdx = 0;",
  "  var busyUntil = 0;",
  "",
  "  function flash(msg) {",
  "    statusEl.textContent = msg;",
  "    statusEl.className = 'act';",
  "    busyUntil = Date.now() + 1200;",
  "  }",
  "",
  "  fetch('/meta').then(function (r) { return r.json(); }).then(function (m) {",
  "    if (m.width) { deskW = m.width; deskH = m.height; }",
"    hostEl.textContent = m.computer",
  "      ? (m.computer + ' · ' + m.user + ' · 原生 ' + m.width + '×' + m.height)",
  "      : '';",
  "  }).catch(function () {});",
  "",
  "  function tick() {",
  "    var probe = new Image();",
  "    probe.onload = function () {",
  "      img.src = probe.src;",
  "      failures = 0;",
  "      if (!dragging) { dot.className = ''; }",
  "      frames++;",
  "      var now = Date.now();",
  "      if (now - lastFps >= 2000) {",
  "        fps = frames / ((now - lastFps) / 1000);",
  "        frames = 0; lastFps = now;",
  "        fpsPill.textContent = fps.toFixed(1) + ' fps';",
  "      }",
  "      sizePill.textContent = deskW + '×' + deskH + (frameScale < 1 ? ' · ' + probe.naturalWidth + '×' + probe.naturalHeight : '');",
  "      if (!dragging && now > busyUntil) {",
  "        statusEl.textContent = new Date().toLocaleTimeString() + ' · 画面实时';",
  "        statusEl.className = '';",
  "      }",
  "      setTimeout(tick, 40);",
  "    };",
  "    probe.onerror = function () {",
  "      failures++;",
  "      dot.className = failures > 3 ? 'dead' : 'stale';",
  "      statusEl.textContent = '拉取失败 ' + failures + ' 次，2 秒后重试…';",
  "      statusEl.className = 'bad';",
  "      setTimeout(tick, 2000);",
  "    };",
  "    probe.src = '/shot?format=jpg&quality=70&scale=' + frameScale + '&t=' + Date.now();",
  "  }",
  "  tick();",
  "",
  "  function toGuest(ev) {",
  "    var r = img.getBoundingClientRect();",
  "    return {",
  "      x: Math.max(0, Math.min(deskW - 1, Math.round((ev.clientX - r.left) * (deskW / r.width)))),",
  "      y: Math.max(0, Math.min(deskH - 1, Math.round((ev.clientY - r.top ) * (deskH / r.height))))",
  "    };",
  "  }",
  "",
  "  var dragging = false, dragButton = 'left', moveBusy = false, moveCount = 0, lastX = -1, lastY = -1;",
  "  function buttonName(b) { return b === 2 ? 'right' : (b === 1 ? 'middle' : 'left'); }",
  "  img.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });",
  "  img.addEventListener('wheel', function (ev) {",
  "    ev.preventDefault();",
  "    var p = toGuest(ev);",
  "    var d = ev.deltaY > 0 ? -120 : 120;",
  "    statusEl.className = 'act';",
  "    statusEl.textContent = '滚轮' + (d < 0 ? '下' : '上') + ' @ (' + p.x + ', ' + p.y + ')';",
  "    fetch('/mouse?action=scroll&x=' + p.x + '&y=' + p.y + '&delta=' + d).catch(function () {});",
  "  }, { passive: false });",
  "  img.addEventListener('mousedown', function (ev) {",
  "    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) { return; }",
  "    var p = toGuest(ev);",
  "    dragging = true;",
  "    dragButton = buttonName(ev.button);",
  "    moveCount = 0;",
  "    lastX = p.x; lastY = p.y;",
  "    img.className = 'grabbing';",
  "    statusEl.className = 'act';",
  "    statusEl.textContent = '按住 ' + dragButton + ' (' + p.x + ', ' + p.y + ') …';",
  "    fetch('/mouse?action=down&x=' + p.x + '&y=' + p.y + '&button=' + dragButton).catch(function () {});",
  "    ev.preventDefault();",
  "  });",
  "  window.addEventListener('mousemove', function (ev) {",
  "    if (!dragging) { return; }",
  "    if (dragButton !== 'left') { return; }",
  "    if (moveBusy) { return; }",
  "    var p = toGuest(ev);",
  "    if (p.x === lastX && p.y === lastY) { return; }",
  "    lastX = p.x; lastY = p.y;",
  "    moveBusy = true;",
  "    moveCount++;",
  "    statusEl.textContent = '拖拽中 → (' + p.x + ', ' + p.y + ')  已发 ' + moveCount + ' 次移动';",
  "    fetch('/mouse?action=dragmove&x=' + p.x + '&y=' + p.y)",
  "      .catch(function () {})",
  "      .then(function () { moveBusy = false; });",
  "  });",
  "  window.addEventListener('mouseup', function (ev) {",
  "    if (!dragging) { return; }",
  "    dragging = false;",
  "    var upButton = dragButton;",
  "    dragButton = 'left';",
  "    img.className = '';",
  "    var p = toGuest(ev);",
  "    statusEl.textContent = moveCount > 0",
  "      ? ('拖拽完成: ' + lastX + ', ' + lastY + '  (' + moveCount + ' 步)')",
  "      : (upButton + ' 点击 (' + p.x + ', ' + p.y + ')');",
  "    statusEl.className = 'act';",
  "    fetch('/mouse?action=up&x=' + p.x + '&y=' + p.y + '&button=' + upButton).catch(function () {});",
  "  });",
  "  window.addEventListener('blur', function () {",
  "    if (!dragging) { return; }",
  "    dragging = false;",
  "    var upButton = dragButton;",
  "    dragButton = 'left';",
  "    img.className = '';",
  "    fetch('/mouse?action=up&x=' + lastX + '&y=' + lastY + '&button=' + upButton).catch(function () {});",
  "    statusEl.textContent = '窗口失焦，已松开按键';",
  "  });",
  "",
  "  // --- keyboard forwarding ---",
  "  var VK = {",
  "    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32,",
  "    PageUp: 33, PageDown: 34, End: 35, Home: 36,",
  "    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,",
  "    Insert: 45, Delete: 46,",
  "    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,",
  "    F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123",
  "  };",
  "  function vkFor(key) {",
  "    if (VK[key] !== undefined) { return VK[key]; }",
  "    if (key.length === 1) {",
  "      var c = key.toUpperCase().charCodeAt(0);",
  "      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) { return c; }",
  "    }",
  "    return 0;",
  "  }",
  "  window.addEventListener('keydown', function (ev) {",
  "    if (ev.metaKey) { return; }",
  "    if (ev.ctrlKey || ev.altKey) {",
  "      var mods = [];",
  "      if (ev.ctrlKey) { mods.push(17); }",
  "      if (ev.altKey) { mods.push(18); }",
  "      if (ev.shiftKey) { mods.push(16); }",
  "      var mvk = vkFor(ev.key);",
  "      if (mvk) {",
  "        ev.preventDefault();",
  "        var all = mods.concat([mvk]).join(',');",
  "        flash('组合键 ' + all);",
  "        fetch('/key?action=combo&vks=' + all).catch(function () {});",
  "      }",
  "      return;",
  "    }",
  "    var named = VK[ev.key];",
  "    if (named !== undefined) {",
  "      ev.preventDefault();",
  "      if (ev.key === 'Backspace') { flash('退格'); }",
  "      else if (ev.key === 'Enter') { flash('回车'); }",
  "      else { flash('按键 ' + ev.key); }",
  "      fetch('/key?action=vk&vk=' + named).catch(function () {});",
  "      return;",
  "    }",
  "    if (ev.key.length === 1) {",
  "      ev.preventDefault();",
  "      fetch('/key?action=text&text=' + encodeURIComponent(ev.key)).catch(function () {});",
  "    }",
  "  });",
  "",
  "  // --- tools ---",
  "  document.getElementById('btnShot').addEventListener('click', function () {",
  "    if (!img.naturalWidth) { flash('还没有画面'); return; }",
  "    var cv = document.createElement('canvas');",
  "    cv.width = img.naturalWidth;",
  "    cv.height = img.naturalHeight;",
  "    cv.getContext('2d').drawImage(img, 0, 0);",
  "    cv.toBlob(function (b) {",
  "      if (!b) { flash('保存失败'); return; }",
  "      var a = document.createElement('a');",
  "      a.href = URL.createObjectURL(b);",
  "      a.download = 'iso-desktop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';",
  "      a.click();",
  "      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);",
  "      flash('已保存当前帧');",
  "    }, 'image/png');",
  "  });",
  "  document.getElementById('btnFull').addEventListener('click', function () {",
  "    if (document.fullscreenElement) { document.exitFullscreen(); }",
  "    else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }",
  "  });",
  "</script>",
  "</body>",
  "</html>",
  ""
].join("\n");

let takeover = true;

const VDESK = process.env.VDESK_PS1 || "C:\\\\Users\\\\Administrator\\\\Documents\\\\deepseek-harness\\\\默认工作区\\\\tools\\\\vdesk-childsession\\\\vdesk.ps1";
const KEEPER_JSON = process.env.VDESK_KEEPER_JSON || "C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\Temp\\\\dsh-childsession\\\\out\\\\keeper.json";
const VDESK_LOG = process.env.VDESK_LOG || "C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\Temp\\\\dsh-childsession\\\\out\\\\plugin-control.log";

let healthAt = 0, healthBody = null;
function healthCache() {
  if (Date.now() - healthAt < 1500) return healthBody;
  healthAt = Date.now(); healthBody = null;
  try {
    resolveTransport(false)
      .then((t) => rawAgentRequest("127.0.0.1", t, "/health", 1500))
      .then(
        (r) => { try { healthBody = JSON.parse(r.body.toString("utf8")); } catch { healthBody = null; } },
        () => { healthBody = null; }
      );
  } catch { }
  return healthBody;
}

const TASKS_DIR = process.env.VDESK_TASKS || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/tasks";

// Newest .jsonl by mtime -> { ok, task: { taskId, goal, startedAt, planned, steps, summary, active, path } }.
// `active` is derived from the absence of a summary line, so the panel can tell "running" from "done".
function readLatestTask() {
  try {
    if (!existsSync(TASKS_DIR)) return { ok: true, task: null };
    const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return { ok: true, task: null };
    let best = null, bestM = -1;
    for (const f of files) {
      try { const m = statSync(TASKS_DIR + "/" + f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { }
    }
    if (!best) return { ok: true, task: null };
    const file = TASKS_DIR + "/" + best;
    const lines = readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    const steps = [];
    let taskId = best.endsWith(".jsonl") ? best.slice(0, -6) : best;
    let goal = null, startedAt = null, planned = [], summary = null;
    for (const line of lines) {
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "task") {
        if (o.taskId) taskId = o.taskId;
        if (o.goal) goal = o.goal;
        if (o.startedAt) startedAt = o.startedAt;
        if (Array.isArray(o.planned)) planned = o.planned;
        continue;
      }
      if (o.type === "summary") { summary = o; continue; }
      steps.push(o);
    }
    return { ok: true, task: { taskId: taskId, goal: goal, startedAt: startedAt, planned: planned, steps: steps, summary: summary, active: !summary, path: file } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// The native window interaction clock (policy B): input that the panel injects THROUGH the monitor
// refreshes out\keeper.touch; the keeper owns the flag and closes an idle window itself.
function touchWindow(clear) {
  const f = KEEPER_JSON.replace(/keeper\.json$/, "keeper.touch");
  try { if (clear) { unlinkSync(f); } else { writeFileSync(f, String(Date.now())); } } catch { }
}

function vdeskStatus() {
  let keeper = null;
  try { keeper = JSON.parse(readFileSync(KEEPER_JSON, "utf8")); } catch { }
  const winFlag = KEEPER_JSON.replace(/keeper\.json$/, "keeper.window");
  const winTouch = KEEPER_JSON.replace(/keeper\.json$/, "keeper.touch");
  let win = false, winSince = null, lastTouchMs = null;
  try {
    if (existsSync(winFlag)) {
      win = true;
      const st = statSync(winFlag);
      winSince = st.mtime.toISOString();
      lastTouchMs = st.mtimeMs;
    }
  } catch { }
  try {
    if (existsSync(winTouch)) {
      const m = statSync(winTouch).mtimeMs;
      if (lastTouchMs === null || m > lastTouchMs) lastTouchMs = m;
    }
  } catch { }
  // while the keeper runs it owns the interaction clock; the files are the fallback (keeper gone)
  let winIdleSec = null, winIdleMin = Number(process.env.VDESK_WINDOW_IDLE_MIN || 10);
  if (keeper && keeper.windowSince) winSince = keeper.windowSince;
  if (keeper && typeof keeper.windowIdleMin === "number") winIdleMin = keeper.windowIdleMin;
  if (keeper && typeof keeper.windowIdleSec === "number") winIdleSec = keeper.windowIdleSec;
  else if (win && lastTouchMs !== null) winIdleSec = Math.max(0, Math.round((Date.now() - lastTouchMs) / 1000));
  if (!win) { winSince = null; winIdleSec = null; }
  // resolution: the helper measures the real desktop inside the session, so it wins; then the
  // size the keeper asked for; then the remembered target; then the 1280x800 fallback
  // P3-B: startup-isolation proof from the last start (hermetic === no singleton suite leaked in)
  let guest = null;
  try {
    const guard = KEEPER_JSON.replace(/keeper\.json$/, "startup-guard.json");
    if (existsSync(guard)) guest = JSON.parse(readFileSync(guard, "utf8"));
  } catch { }
  let res = { width: 1280, height: 800, source: "default" };
  try {
    const hc = healthCache();
    const desired = KEEPER_JSON.replace(/keeper\.json$/, "desired-resolution.json");
    let dw = 0, dh = 0;
    if (existsSync(desired)) { const j = JSON.parse(readFileSync(desired, "utf8")); dw = Number(j.width) || 0; dh = Number(j.height) || 0; }
    if (hc && hc.width > 0 && hc.height > 0) res = { width: Number(hc.width), height: Number(hc.height), source: "helper" };
    else if (keeper && keeper.width > 0 && keeper.height > 0) res = { width: Number(keeper.width), height: Number(keeper.height), source: "keeper" };
    else if (dw > 0 && dh > 0) res = { width: dw, height: dh, source: "desired" };
  } catch { }
  return { ok: true, keeper: keeper, helper: healthCache(), window: win, windowSince: winSince, lastWindowTouch: win && lastTouchMs !== null ? new Date(lastTouchMs).toISOString() : null, windowIdleSec: winIdleSec, windowIdleMin: winIdleMin, resolution: res, guest: guest, conflict: conflictForStatus(), monitorPort: PORT, agentPort: AGENT_PORT };
}

// Read-only singleton-conflict probe: run `vdesk.ps1 probe` and parse its one JSON line. The
// probe action has no side effects, so this can never start or stop a session.
function conflictProbe() {
  return new Promise((resolve) => {
    let out = "";
    try {
      const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, "probe"], { windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch { } }, 20000);
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => { clearTimeout(timer); resolve(parseConflict(out)); });
      p.on("error", () => { clearTimeout(timer); resolve(null); });
    } catch { resolve(null); }
  });
}

function parseConflict(text) {
  try {
    const line = String(text).trim().split("\n").filter(Boolean).pop();
    const o = JSON.parse(line.replace(/^CONFLICT\s+/, ""));
    return { ok: true, checkedAt: o.checkedAt, found: Array.isArray(o.found) ? o.found : [], watchlist: o.watchlist || [], refused: !!o.refused };
  } catch { return null; }
}

let conflictCache = { at: 0, value: null, pending: false };
// status must stay fast: serve the cache and refresh it in the background when it is stale
function conflictForStatus() {
  const fresh = conflictCache.value && Date.now() - conflictCache.at < 60000;
  if (!fresh && !conflictCache.pending) {
    conflictCache.pending = true;
    conflictProbe().then((v) => { if (v) conflictCache = { at: Date.now(), value: v, pending: false }; else conflictCache.pending = false; }, () => { conflictCache.pending = false; });
  }
  let rec = null;
  try { const f = KEEPER_JSON.replace(/keeper\.json$/, "conflict.json"); if (existsSync(f)) rec = JSON.parse(readFileSync(f, "utf8")); } catch { }
  const live = conflictCache.value;
  if (!live && !rec) return null;
  return {
    checkedAt: (live && live.checkedAt) || (rec && rec.checkedAt) || null,
    found: (live && live.found) || (rec && rec.found) || [],
    forced: !!(rec && rec.forced),
    refused: !!(rec && rec.refused),
  };
}

function vdeskRun(action, force) {
  try {
    const out = openSync(VDESK_LOG, "a");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, action];
    if (action === "start" || action === "restart") { args.push("-Minutes", "240"); }
    if (force && action === "start") { args.push("-Force"); }
    const p = spawn("powershell.exe", args, { detached: false, stdio: ["ignore", out, out], windowsHide: true, windowsVerbatimArguments: false });
    p.unref();
    return { ok: true, note: "spawned pid " + p.pid };
  } catch (e) { return { ok: false, note: String((e && e.message) || e) }; }
}

const server = http.createServer(async (req, res) => {
  const reqOrigin = req.headers.origin;
  const originOk = !reqOrigin || ALLOWED_ORIGINS.has(reqOrigin);
  if (reqOrigin && ALLOWED_ORIGINS.has(reqOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-vdesk-token");
  }
  if (req.method === "OPTIONS") {
    if (!originOk) { res.writeHead(403, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "forbidden origin" })); return; }
    res.writeHead(204); res.end(); return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route = url.pathname;

  // 轻量来源校验 (CSRF, not process auth): a browser that is not the DSH UI can still fire a
  // simple POST, so refuse the state-changing routes outright. No-Origin callers are local
  // non-browser clients (the DSH host half, vdesk-cli) and stay trusted; the real control-plane
  // credential is the 8790 token above.
  if (WRITE_ROUTES.has(route) && !originOk) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "forbidden origin", origin: reqOrigin || null, hint: "browser callers must be the DSH UI (dsh-app://app / http://127.0.0.1:19387)" }));
    return;
  }

  try {
    if (route === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }

    if (route === "/shot") {
      const r = await agentRequest("/screenshot" + url.search, 30000);
      if (r.status === 401) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (r.status !== 200 || !r.body.length) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("agent did not return an image");
        return;
      }
      res.writeHead(200, {
        "content-type": r.contentType || "image/png",
        "cache-control": "no-store",
        "content-length": r.body.length
      });
      res.end(r.body);
      return;
    }

    if (route === "/meta") {
      const r = await agentRequest("/health", 10000);
      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(r.body);
      return;
    }

    if (route === "/stream") {
      // P4 live view: the query string is copied verbatim to the helper (frozen
      // contract) and the multipart body is piped through untouched; a helper 401 is
      // surfaced as JSON instead of being framed as an image.
      await pipeAgentStream(route + url.search, res);
      return;
    }

    if (route === "/takeover") {
      takeover = url.searchParams.get("on") === "1";
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, takeover: takeover }));
      return;
    }

    if ((route === "/mouse" || route === "/key" || route === "/click" || route === "/input") && !takeover) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "view-only", hint: "press 接管 in the toolbar first" }));
      return;
    }

    if (route === "/mouse" || route === "/key") {
      const r = await agentRequest(route + url.search, 15000);
      touchWindow(false);
      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(r.body);
      return;
    }

    if (route === "/click") {
      const rawX = Number(url.searchParams.get("x"));
      const rawY = Number(url.searchParams.get("y"));
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end('{"ok":false,"error":"x and y required"}');
        return;
      }
      // P4: accept NORMALISED coordinates (px / rect.width) as well as pixels, so the
      // DSH panel can post its image-relative click straight through.
      const size = helperDesktopSize();
      const x = resolveNorm(rawX, size.width);
      const y = resolveNorm(rawY, size.height);
      const button = url.searchParams.get("button") || "left";
      const r = await agentRequest(`/mouse?action=click&x=${x}&y=${y}&button=${button}&count=1`, 15000);
      touchWindow(false);
      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(r.body);
      return;
    }

    if (route === "/input") {
      // P4 batch input: the JSON body (or ?events=) is forwarded verbatim; the helper
      // runs the event list in order on one thread. Reachable only after the origin
      // guard and the takeover lock above.
      const payload = req.method === "POST" ? await readRequestBody(req) : null;
      const r = payload === null ? await agentRequest(route + url.search, 30000) : await agentInput(route + url.search, payload);
      touchWindow(false);
      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(r.body);
      return;
    }

    if (route === "/vdesk/task") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(readLatestTask()));
      return;
    }

    if (route === "/vdesk/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(vdeskStatus()));
      return;
    }

    if (route === "/vdesk/window") {
      const on = url.searchParams.get("on") !== "0";
      const winFlag = KEEPER_JSON.replace(/keeper\.json$/, "keeper.window");
      try { if (on) { writeFileSync(winFlag, String(Date.now())); } else { try { unlinkSync(winFlag); } catch { } } } catch { }
      touchWindow(!on);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, window: on }));
      return;
    }

    if (route === "/vdesk/conflict") {
      const v = await conflictProbe();
      conflictCache = { at: Date.now(), value: v, pending: false };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(v || { ok: false, error: "probe-failed", found: [] }));
      return;
    }

    if (route === "/vdesk/start" || route === "/vdesk/stop" || route === "/vdesk/restart") {
      const action = route === "/vdesk/start" ? "start" : (route === "/vdesk/stop" ? "stop" : "restart");
      const force = url.searchParams.get("force") === "1";
      // P4.1: vdeskRun() is fire-and-forget (it spawns the script, unrefs and returns at once), so
      // the P3-C refusal ("singleton-conflict", exit 4) used to be INVISIBLE: the UI got ok:true and
      // the desktop simply never appeared -- which reads as "the button does nothing" (user report,
      // 2026-10-02 14:47). Probe first (read-only, cached) and answer honestly WITHOUT spawning.
      if (action === "start" && !force) {
        const c = await conflictProbe();
        if (c && Array.isArray(c.found) && c.found.length > 0) {
          conflictCache = { at: Date.now(), value: c, pending: false };
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, action: action, force: false, error: "singleton-conflict", found: c.found, advice: "检测到机器级单例程序正在运行：子会话登录时会再起一份并与它们抢单例（本机已两次导致桌面双崩）。请先退出它们，或确认接受风险后用 force=1（面板「强制启动」按钮）。" }));
          return;
        }
      }
      const r = vdeskRun(action, force);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: r.ok, action: action, force: force, note: r.note }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String((error && error.message) || error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`vdesk child-session monitor listening on http://127.0.0.1:${PORT}/ (view-only until 接管)`);
});
