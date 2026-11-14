// make-vdesk-monitor.mjs -- derive vdesk-monitor.mjs from the working isolated-desktop
// monitor.mjs, retargeted at the CHILD SESSION helper (127.0.0.1:8790) and extended with an
// explicit takeover lock (view-only until the user presses 接管).
//
// Run:  node make-vdesk-monitor.mjs

import { readFileSync, writeFileSync } from "node:fs";

const SRC = "C:\\Users\\Administrator\\.dsh\\isolated-desktop\\monitor.mjs";
const DST = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\vdesk-monitor.mjs";

let t = readFileSync(SRC, "utf8");
const before = t.length;
const misses = [];

function rep(from, to, tag) {
  if (!t.includes(from)) { misses.push(tag); return; }
  t = t.split(from).join(to);
}

// 0) (moved to the end -- these strings only exist after the takeover feature is inserted)

// 1) retarget the agent: the helper runs inside the child session on 127.0.0.1:8790
rep(
  'const PORT = Number(process.env.DSH_ISOVM_MONITOR_PORT || 8799);',
  'const PORT = Number(process.env.DSH_VDESK_MONITOR_PORT || 8791);',
  "port"
);
rep(
  'const AGENT_PORT = 8765;\nconst IP_FILE = "B:\\\\HyperV\\\\guest-ip.txt";',
  'const AGENT_PORT = 8790;\nconst AGENT_HOST = "127.0.0.1";',
  "agent port/host"
);
t = t.replace(/async function guestIp\(\) \{[\s\S]*?\n\}/, "async function guestIp() {\n  return AGENT_HOST;\n}");
rep(
  "console.log(`isolated-desktop monitor listening on http://127.0.0.1:${PORT}/ (keyboard enabled)`);",
  "console.log(`vdesk child-session monitor listening on http://127.0.0.1:${PORT}/ (view-only until 接管)`);",
  "log line"
);

// 2) page wording
rep('>DSH 隔离桌面<', '>DSH 虚拟桌面<', "title");
rep('id=\\"host\\">连接中…<', 'id=\\"host\\">子会话 · 连接中…<', "subtitle");

// 3) page: takeover pill + button + logic
rep(
  '"      <span class=\\"pill ok\\" id=\\"kbPill\\">键盘已接入</span>",',
  '"      <span class=\\"pill ok\\" id=\\"kbPill\\">键盘已接入</span>",\n' +
  '"      <span class=\\"pill\\" id=\\"takePill\\">只读</span>",',
  "takePill"
);
rep(
  '"      <button class=\\"tool\\" id=\\"btnFull\\" title=\\"全屏 / 退出全屏\\">全屏</button>",',
  '"      <button class=\\"tool\\" id=\\"btnFull\\" title=\\"全屏 / 退出全屏\\">全屏</button>",\n' +
  '"      <button class=\\"tool\\" id=\\"btnTake\\" title=\\"允许把本窗口的鼠标/键盘送进这个桌面\\">接管</button>",',
  "btnTake"
);
rep(
  "\"  var dot = document.getElementById('dot');\",",
  [
    "\"  var dot = document.getElementById('dot');\",",
    "\"  var takePill = document.getElementById('takePill');\",",
    "\"  var btnTake = document.getElementById('btnTake');\",",
    "\"  var taking = false;\",",
    "\"  function renderTake() { takePill.textContent = taking ? '接管中' : '只读'; takePill.className = 'pill ' + (taking ? 'act' : 'ok'); btnTake.textContent = taking ? '交还' : '接管'; }\",",
    "\"  function toggleTake() {\",",
    "\"    var next = !taking;\",",
    "\"    fetch('/takeover?on=' + (next ? '1' : '0')).then(function () { taking = next; renderTake(); flash(next ? '已接管：鼠标键盘会送进这个桌面' : '已交还：恢复只读查看'); }).catch(function () {});\",",
    "\"  }\",",
    "\"  btnTake.addEventListener('click', toggleTake);\",",
    "\"  renderTake();\","
  ].join("\n"),
  "takeover js"
);
rep(
  '"    <span id=\\"hint\\">左键点击 / 拖拽 · 右键点击 · 滚轮滚动 · 直接打字</span>",',
  '"    <span id=\\"hint\\">直接操作（点「交还」切回只读）· 左键点击 / 拖拽 · 右键 · 滚轮 · 直接打字</span>",',
  "hint"
);

// 4) server: takeover flag, route and guard
rep(
  "const server = http.createServer(async (req, res) => {",
  "let takeover = false;\n\nconst server = http.createServer(async (req, res) => {",
  "flag"
);
rep(
  '    if (route === "/mouse" || route === "/key") {',
  [
    '    if (route === "/takeover") {',
    '      takeover = url.searchParams.get("on") === "1";',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify({ ok: true, takeover: takeover }));',
    '      return;',
    '    }',
    '',
    '    if ((route === "/mouse" || route === "/key" || route === "/click") && !takeover) {',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify({ ok: false, error: "view-only", hint: "press 接管 in the toolbar first" }));',
    '      return;',
    '    }',
    '',
    '    if (route === "/mouse" || route === "/key") {'
  ].join("\n"),
  "route+guard"
);

// 5) header comment
t = "// vdesk-monitor.mjs -- live view + takeover window for the CHILD SESSION virtual desktop.\n" +
    "// Generated from the isolated-desktop monitor.mjs by make-vdesk-monitor.mjs.\n" +
    "// Serves a dark-card page on 127.0.0.1:8791; frames and input go to the in-session helper\n" +
    "// (127.0.0.1:8790). VIEW-ONLY until the user presses 接管 -- nothing touches the host's own\n" +
    "// mouse or keyboard.\n" +
    t.slice(t.indexOf("\n") + 1);

// 6) takeover is ON by default: the user should be able to just click and type (feedback 2026-10-01)
rep("let takeover = false;", "let takeover = true;", "takeover default ON");
rep("  var taking = false;", "  var taking = true;", "page state default ON");

// 7) latency fix (feedback 2026-10-01 "延迟非常的严重"): the live view must pull JPEG, not PNG.
//    Full-size PNG was ~1.3 MB / ~440 ms per frame -> ~2 fps and visible lag; JPEG q70 is
//    ~215 KB / ~108 ms, and the helper can also downscale for even faster frames.
rep(
  "\"    probe.src = '/shot?t=' + Date.now();\",",
  "\"    probe.src = '/shot?format=jpg&quality=70&scale=' + frameScale + '&t=' + Date.now();\",",
  "live frames use jpeg + scale"
);
rep(
  "const r = await agentRequest(\"/screenshot\", 30000);",
  "const r = await agentRequest(\"/screenshot\" + url.search, 30000);",
  "forward shot query"
);
rep(
  "\"content-type\": \"image/png\",",
  "\"content-type\": r.contentType || \"image/png\",",
  "pass through content type"
);
// tighter pacing: frames are cheap now, so pull the next one sooner (was 200 ms)
rep(
  "\"      setTimeout(tick, 200);\",",
  "\"      setTimeout(tick, 40);\",",
  "pacing 40ms"
);

// 8) a 清晰/流畅/极速 switch, and -- crucially -- coordinate mapping by the REAL desktop size
//    from /meta instead of img.naturalWidth. Without this, any scale < 1 would send clicks to
//    the wrong place (naturalWidth would be 960 while the helper expects 1280-wide coords).
rep(
  "\"  var frames = 0, lastFps = Date.now(), fps = 0, failures = 0;\",",
  [
    "\"  var frames = 0, lastFps = Date.now(), fps = 0, failures = 0;\",",
    "\"  var deskW = 1280, deskH = 800, frameScale = 1.0;\",",
    "\"  var qNames = ['清晰', '流畅', '极速'], qScales = [1.0, 0.75, 0.5], qIdx = 0;\","
  ].join("\n"),
  "declare desk size + quality state"
);
rep(
  "\"    hostEl.textContent = m.computer\",",
  [
    "\"    if (m.width) { deskW = m.width; deskH = m.height; }\",",
    "\"    hostEl.textContent = m.computer\","
  ].join("\n"),
  "capture real desktop size"
);
rep(
  "\"      x: Math.max(0, Math.min(img.naturalWidth  - 1, Math.round((ev.clientX - r.left) * (img.naturalWidth  / r.width)))),\"",
  "\"      x: Math.max(0, Math.min(deskW - 1, Math.round((ev.clientX - r.left) * (deskW / r.width)))),\"",
  "map x by desktop width"
);
rep(
  "\"      y: Math.max(0, Math.min(img.naturalHeight - 1, Math.round((ev.clientY - r.top ) * (img.naturalHeight / r.height))))\"",
  "\"      y: Math.max(0, Math.min(deskH - 1, Math.round((ev.clientY - r.top ) * (deskH / r.height))))\"",
  "map y by desktop height"
);
rep(
  "\"      <button class=\\\"tool\\\" id=\\\"btnFull\\\" title=\\\"全屏 / 退出全屏\\\">全屏</button>\",",
  [
    "\"      <button class=\\\"tool\\\" id=\\\"btnFull\\\" title=\\\"全屏 / 退出全屏\\\">全屏</button>\",",
    "\"      <button class=\\\"tool\\\" id=\\\"btnQ\\\" title=\\\"清晰度 / 帧率取舍\\\">清晰</button>\","
  ].join("\n"),
  "quality button"
);
rep(
  "\"  btnTake.addEventListener('click', toggleTake);\",",
  [
    "\"  btnTake.addEventListener('click', toggleTake);\",",
    "\"  document.getElementById('btnQ').addEventListener('click', function () {\",",
    "\"    qIdx = (qIdx + 1) % qNames.length;\",",
    "\"    frameScale = qScales[qIdx];\",",
    "\"    this.textContent = qNames[qIdx];\",",
    "\"    flash('画质：' + qNames[qIdx] + (frameScale < 1 ? '（更流畅）' : '（最清晰）'));\",",
    "\"  });\","
  ].join("\n"),
  "quality button logic"
);
// sizePill should show the desktop size, not the (possibly scaled) frame size
rep(
  "\"      sizePill.textContent = probe.naturalWidth + '×' + probe.naturalHeight;\",",
  "\"      sizePill.textContent = deskW + '×' + deskH + (frameScale < 1 ? ' · ' + probe.naturalWidth + '×' + probe.naturalHeight : '');\",",
  "size pill shows desktop size"
);

// 9) control API for the DSH plugin half: the Harness Web page (origin 127.0.0.1:19387) drives the
//    virtual desktop from the browser, so the monitor needs CORS plus /vdesk/{status,start,stop}.
rep(
  'import { readFile } from "node:fs/promises";',
  'import { readFile } from "node:fs/promises";\nimport { readFileSync, openSync } from "node:fs";\nimport { spawn } from "node:child_process";',
  "imports for control api"
);

rep(
  'const server = http.createServer(async (req, res) => {',
  [
    'const VDESK = "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\Documents\\\\\\\\deepseek-harness\\\\\\\\默认工作区\\\\\\\\tools\\\\\\\\vdesk-childsession\\\\\\\\vdesk.ps1";',
    'const KEEPER_JSON = "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\dsh-childsession\\\\\\\\out\\\\\\\\keeper.json";',
    'const VDESK_LOG = process.env.VDESK_LOG || "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\dsh-childsession\\\\\\\\out\\\\\\\\plugin-control.log";',
    '',
    'let healthAt = 0, healthBody = null;',
    'function healthCache() {',
    '  if (Date.now() - healthAt < 1500) return healthBody;',
    '  healthAt = Date.now(); healthBody = null;',
    '  try {',
    '    const req = http.request({ host: "127.0.0.1", port: AGENT_PORT, path: "/health", method: "GET", timeout: 1500 },',
    '      (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { healthBody = JSON.parse(Buffer.concat(c).toString("utf8")); } catch { healthBody = null; } }); });',
    '    req.on("error", () => { });',
    '    req.on("timeout", () => { req.destroy(); });',
    '    req.end();',
    '  } catch { }',
    '  return healthBody;',
    '}',
    '',
    'function vdeskStatus() {',
    '  let keeper = null;',
    '  try { keeper = JSON.parse(readFileSync(KEEPER_JSON, "utf8")); } catch { }',
    '  return { ok: true, keeper: keeper, helper: healthCache(), monitorPort: PORT, agentPort: AGENT_PORT };',
    '}',
    '',
    'function vdeskRun(action) {',
    '  try {',
    '    const out = openSync(VDESK_LOG, "a");',
    '    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, action];',
    '    if (action === "start") { args.push("-Minutes", "240"); }',
    '    const p = spawn("powershell.exe", args, { detached: false, stdio: ["ignore", out, out], windowsHide: true, windowsVerbatimArguments: false });',
    '    p.unref();',
    '    return { ok: true, note: "spawned pid " + p.pid };',
    '  } catch (e) { return { ok: false, note: String((e && e.message) || e) }; }',
    '}',
    '',
    'const server = http.createServer(async (req, res) => {',
    '  res.setHeader("Access-Control-Allow-Origin", "*");',
    '  res.setHeader("Access-Control-Allow-Headers", "content-type");',
    '  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }'
  ].join("\n"),
  "helpers + cors"
);

rep(
  '    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });\n    res.end("not found");',
  [
    '    if (route === "/vdesk/status") {',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify(vdeskStatus()));',
    '      return;',
    '    }',
    '',
    '    if (route === "/vdesk/start" || route === "/vdesk/stop") {',
    '      const action = route === "/vdesk/start" ? "start" : "stop";',
    '      const r = vdeskRun(action);',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify({ ok: r.ok, action: action, note: r.note }));',
    '      return;',
    '    }',
    '',
    '    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });',
    '    res.end("not found");'
  ].join("\n"),
  "vdesk routes"
);

// 12) native-window toggle + restart, and the fs helpers they need
rep(
  'import { readFileSync, openSync } from "node:fs";',
  'import { readFileSync, openSync, writeFileSync, unlinkSync } from "node:fs";',
  "fs helpers for window flag"
);
rep(
  '    if (route === "/vdesk/start" || route === "/vdesk/stop") {',
  [
    '    if (route === "/vdesk/window") {',
    '      const on = url.searchParams.get("on") !== "0";',
    '      const winFlag = KEEPER_JSON.replace(/keeper\\.json$/, "keeper.window");',
    '      try { if (on) { writeFileSync(winFlag, String(Date.now())); } else { try { unlinkSync(winFlag); } catch { } } } catch { }',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify({ ok: true, window: on }));',
    '      return;',
    '    }',
    '',
    '    if (route === "/vdesk/start" || route === "/vdesk/stop" || route === "/vdesk/restart") {'
  ].join("\n"),
  "window route + restart route"
);
rep(
  '      const action = route === "/vdesk/start" ? "start" : "stop";',
  '      const action = route === "/vdesk/start" ? "start" : (route === "/vdesk/stop" ? "stop" : "restart");',
  "restart action"
);
rep(
  '    if (action === "start") { args.push("-Minutes", "240"); }',
  '    if (action === "start" || action === "restart") { args.push("-Minutes", "240"); }',
  "minutes for start and restart"
);

// 13) expose the native-window flag through /vdesk/status so the UI can label its button
rep(
  'import { readFileSync, openSync, writeFileSync, unlinkSync } from "node:fs";',
  'import { readFileSync, openSync, writeFileSync, unlinkSync, existsSync } from "node:fs";',
  "existsSync import"
);
rep(
  '  return { ok: true, keeper: keeper, helper: healthCache(), monitorPort: PORT, agentPort: AGENT_PORT };',
  '  let win = false;\n' +
  '  try { win = existsSync(KEEPER_JSON.replace(/keeper\\.json$/, "keeper.window")); } catch { }\n' +
  '  return { ok: true, keeper: keeper, helper: healthCache(), window: win, monitorPort: PORT, agentPort: AGENT_PORT };',
  "status includes window"
);

// 14) P1 task panel: GET /vdesk/task serves the newest task journal so the sidebar fold-out can
//     show "current task · step n" plus the last ten steps. The journal is written by the DSH
//     plugin half (out\tasks\<taskId>.jsonl); this endpoint only reads it.
rep(
  'import { readFileSync, openSync, writeFileSync, unlinkSync, existsSync } from "node:fs";',
  'import { readFileSync, openSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";',
  "task reader imports"
);
rep(
  "function vdeskStatus() {",
  [
    'const TASKS_DIR = process.env.VDESK_TASKS || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/tasks";',
    '',
    '// Newest .jsonl by mtime -> { ok, task: { taskId, goal, startedAt, planned, steps, summary, active, path } }.',
    '// `active` is derived from the absence of a summary line, so the panel can tell "running" from "done".',
    'function readLatestTask() {',
    '  try {',
    '    if (!existsSync(TASKS_DIR)) return { ok: true, task: null };',
    '    const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".jsonl"));',
    '    if (!files.length) return { ok: true, task: null };',
    '    let best = null, bestM = -1;',
    '    for (const f of files) {',
    '      try { const m = statSync(TASKS_DIR + "/" + f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { }',
    '    }',
    '    if (!best) return { ok: true, task: null };',
    '    const file = TASKS_DIR + "/" + best;',
    '    const lines = readFileSync(file, "utf8").split("\\n").map((s) => s.trim()).filter(Boolean);',
    '    const steps = [];',
    '    let taskId = best.endsWith(".jsonl") ? best.slice(0, -6) : best;',
    '    let goal = null, startedAt = null, planned = [], summary = null;',
    '    for (const line of lines) {',
    '      let o = null;',
    '      try { o = JSON.parse(line); } catch { continue; }',
    '      if (o.type === "task") {',
    '        if (o.taskId) taskId = o.taskId;',
    '        if (o.goal) goal = o.goal;',
    '        if (o.startedAt) startedAt = o.startedAt;',
    '        if (Array.isArray(o.planned)) planned = o.planned;',
    '        continue;',
    '      }',
    '      if (o.type === "summary") { summary = o; continue; }',
    '      steps.push(o);',
    '    }',
    '    return { ok: true, task: { taskId: taskId, goal: goal, startedAt: startedAt, planned: planned, steps: steps, summary: summary, active: !summary, path: file } };',
    '  } catch (e) {',
    '    return { ok: false, error: String((e && e.message) || e) };',
    '  }',
    '}',
    '',
    "function vdeskStatus() {"
  ].join("\n"),
  "task reader"
);
rep(
  '    if (route === "/vdesk/status") {',
  [
    '    if (route === "/vdesk/task") {',
    '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(JSON.stringify(readLatestTask()));',
    '      return;',
    '    }',
    '',
    '    if (route === "/vdesk/status") {'
  ].join("\n"),
  "task route"
);

// 15) P0.6 host-side auth: the monitor is a client of the token-protected 8790 helper, and its own
//     8791 endpoint swaps blanket CORS for an origin allowlist (a browser cannot hold the token).
//     VDESK_HELPER_PORT only exists so an offline mock can stand in for the in-session helper
//     (same override the CLI and the plugin already honour); production never sets it.
rep(
  "const AGENT_PORT = 8790;",
  "const AGENT_PORT = Number(process.env.VDESK_HELPER_PORT || 8790);",
  "agent port override"
);
rep(
  "function agentRequest(pathQuery, timeoutMs = 20000) {",
  [
    'const TOKEN_FILE = process.env.VDESK_TOKEN_FILE || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/token";',
    '',
    '// Every 8790 route except /health needs X-VDesk-Token. The file is re-read per call so a rotated',
    '// token is picked up without restarting; a missing/invalid file omits the header, the helper',
    '// answers 401 and the routes below pass that through as unauthorized.',
    'function readToken() {',
    '  try {',
    '    const t = readFileSync(TOKEN_FILE, "utf8").trim();',
    '    return /^[0-9a-fA-F]{32}$/.test(t) ? t : null;',
    '  } catch { return null; }',
    '}',
    '',
    'function vdeskHeaders() {',
    '  const h = {};',
    '  const t = readToken();',
    '  if (t) h["X-VDesk-Token"] = t;',
    '  return h;',
    '}',
    '',
    '// 8791 is for BROWSERS, which cannot read a local file and therefore cannot present a token, so',
    '// the monitor authenticates itself to 8790 and guards the browser with an origin allowlist: the',
    '// DSH UI origins, null (file:// pages) and the monitor own page (its toolbar is same-origin).',
    'const ALLOWED_ORIGINS = new Set([',
    '  "dsh-app://app",',
    '  "http://127.0.0.1:19387",',
    '  "http://localhost:19387",',
    '  "null",',
    '  "http://127.0.0.1:" + PORT',
    ']);',
    '// Only these routes change machine state. Read-only routes (/shot, /meta, /vdesk/status,',
    '// /vdesk/task) stay open so the panel and the screenshot flow keep working for the UI.',
    'const WRITE_ROUTES = new Set(["/vdesk/start", "/vdesk/stop", "/vdesk/restart", "/vdesk/window", "/mouse", "/key", "/click"]);',
    '',
    "function agentRequest(pathQuery, timeoutMs = 20000) {"
  ].join("\n"),
  "token + origin helpers"
);
rep(
  '{ host: ip, port: AGENT_PORT, path: pathQuery, method: "GET" },',
  '{ host: ip, port: AGENT_PORT, path: pathQuery, method: "GET", headers: vdeskHeaders() },',
  "agent request token header"
);
rep(
  '  res.setHeader("Access-Control-Allow-Origin", "*");\n' +
  '  res.setHeader("Access-Control-Allow-Headers", "content-type");\n' +
  '  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }',
  [
    '  const reqOrigin = req.headers.origin;',
    '  const originOk = !reqOrigin || ALLOWED_ORIGINS.has(reqOrigin);',
    '  if (reqOrigin && ALLOWED_ORIGINS.has(reqOrigin)) {',
    '    res.setHeader("Access-Control-Allow-Origin", reqOrigin);',
    '    res.setHeader("Vary", "Origin");',
    '    res.setHeader("Access-Control-Allow-Headers", "content-type, x-vdesk-token");',
    '  }',
    '  if (req.method === "OPTIONS") {',
    '    if (!originOk) { res.writeHead(403, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "forbidden origin" })); return; }',
    '    res.writeHead(204); res.end(); return;',
    '  }'
  ].join("\n"),
  "cors allowlist"
);
rep(
  "  const route = url.pathname;",
  [
    "  const route = url.pathname;",
    '',
    "  // 轻量来源校验 (CSRF, not process auth): a browser that is not the DSH UI can still fire a",
    "  // simple POST, so refuse the state-changing routes outright. No-Origin callers are local",
    "  // non-browser clients (the DSH host half, vdesk-cli) and stay trusted; the real control-plane",
    "  // credential is the 8790 token above.",
    "  if (WRITE_ROUTES.has(route) && !originOk) {",
    '    res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '    res.end(JSON.stringify({ ok: false, error: "forbidden origin", origin: reqOrigin || null, hint: "browser callers must be the DSH UI (dsh-app://app / http://127.0.0.1:19387)" }));',
    '    return;',
    '  }'
  ].join("\n"),
  "origin write guard"
);
rep(
  '      const r = await agentRequest("/screenshot" + url.search, 30000);',
  [
    '      const r = await agentRequest("/screenshot" + url.search, 30000);',
    '      if (r.status === 401) {',
    '        res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));',
    '        return;',
    '      }'
  ].join("\n"),
  "shot unauthorized passthrough"
);
rep(
  '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n      res.end(r.body);',
  '      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n      res.end(r.body);',
  "agent status passthrough"
);

// 16) P0.9 native-window policy B: the status exposes how long the window has been open and idle,
//     the panel's own injected input refreshes the interaction clock, and the keeper json path can
//     be redirected so an offline test never touches the real out\keeper.json.
rep(
  'const KEEPER_JSON = "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\dsh-childsession\\\\\\\\out\\\\\\\\keeper.json";',
  'const KEEPER_JSON = process.env.VDESK_KEEPER_JSON || "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\AppData\\\\\\\\Local\\\\\\\\Temp\\\\\\\\dsh-childsession\\\\\\\\out\\\\\\\\keeper.json";',
  "keeper json override"
);
rep(
  "function vdeskStatus() {",
  [
    '// The native window interaction clock (policy B): input that the panel injects THROUGH the monitor',
    '// refreshes out\\keeper.touch; the keeper owns the flag and closes an idle window itself.',
    'function touchWindow(clear) {',
    '  const f = KEEPER_JSON.replace(/keeper\\.json$/, "keeper.touch");',
    '  try { if (clear) { unlinkSync(f); } else { writeFileSync(f, String(Date.now())); } } catch { }',
    '}',
    '',
    "function vdeskStatus() {"
  ].join("\n"),
  "window touch helper"
);
rep(
  '  let win = false;\n' +
  '  try { win = existsSync(KEEPER_JSON.replace(/keeper\\.json$/, "keeper.window")); } catch { }\n' +
  '  return { ok: true, keeper: keeper, helper: healthCache(), window: win, monitorPort: PORT, agentPort: AGENT_PORT };',
  [
    '  const winFlag = KEEPER_JSON.replace(/keeper\\.json$/, "keeper.window");',
    '  const winTouch = KEEPER_JSON.replace(/keeper\\.json$/, "keeper.touch");',
    '  let win = false, winSince = null, lastTouchMs = null;',
    '  try {',
    '    if (existsSync(winFlag)) {',
    '      win = true;',
    '      const st = statSync(winFlag);',
    '      winSince = st.mtime.toISOString();',
    '      lastTouchMs = st.mtimeMs;',
    '    }',
    '  } catch { }',
    '  try {',
    '    if (existsSync(winTouch)) {',
    '      const m = statSync(winTouch).mtimeMs;',
    '      if (lastTouchMs === null || m > lastTouchMs) lastTouchMs = m;',
    '    }',
    '  } catch { }',
    '  // while the keeper runs it owns the interaction clock; the files are the fallback (keeper gone)',
    '  let winIdleSec = null, winIdleMin = Number(process.env.VDESK_WINDOW_IDLE_MIN || 10);',
    '  if (keeper && keeper.windowSince) winSince = keeper.windowSince;',
    '  if (keeper && typeof keeper.windowIdleMin === "number") winIdleMin = keeper.windowIdleMin;',
    '  if (keeper && typeof keeper.windowIdleSec === "number") winIdleSec = keeper.windowIdleSec;',
    '  else if (win && lastTouchMs !== null) winIdleSec = Math.max(0, Math.round((Date.now() - lastTouchMs) / 1000));',
    '  if (!win) { winSince = null; winIdleSec = null; }',
    '  return { ok: true, keeper: keeper, helper: healthCache(), window: win, windowSince: winSince, lastWindowTouch: win && lastTouchMs !== null ? new Date(lastTouchMs).toISOString() : null, windowIdleSec: winIdleSec, windowIdleMin: winIdleMin, monitorPort: PORT, agentPort: AGENT_PORT };'
  ].join("\n"),
  "status window idle fields"
);
rep(
  '      try { if (on) { writeFileSync(winFlag, String(Date.now())); } else { try { unlinkSync(winFlag); } catch { } } } catch { }',
  '      try { if (on) { writeFileSync(winFlag, String(Date.now())); } else { try { unlinkSync(winFlag); } catch { } } } catch { }\n      touchWindow(!on);',
  "window route touch reset"
);
rep(
  '      const r = await agentRequest(route + url.search, 15000);',
  '      const r = await agentRequest(route + url.search, 15000);\n      touchWindow(false);',
  "touch on forwarded mouse/key"
);
rep(
  '      const r = await agentRequest(`/mouse?action=click&x=${x}&y=${y}&button=${button}&count=1`, 15000);',
  '      const r = await agentRequest(`/mouse?action=click&x=${x}&y=${y}&button=${button}&count=1`, 15000);\n      touchWindow(false);',
  "touch on forwarded click"
);

// 17) P2-A resolution: /vdesk/status reports the desktop size the session is running at (the
//     helper's own measurement wins, then the size the keeper asked for, then the remembered target).
rep(
  '  if (!win) { winSince = null; winIdleSec = null; }',
  [
    '  if (!win) { winSince = null; winIdleSec = null; }',
    '  // resolution: the helper measures the real desktop inside the session, so it wins; then the',
    '  // size the keeper asked for; then the remembered target; then the 1280x800 fallback',
    '  let res = { width: 1280, height: 800, source: "default" };',
    '  try {',
    '    const hc = healthCache();',
    '    const desired = KEEPER_JSON.replace(/keeper\\.json$/, "desired-resolution.json");',
    '    let dw = 0, dh = 0;',
    '    if (existsSync(desired)) { const j = JSON.parse(readFileSync(desired, "utf8")); dw = Number(j.width) || 0; dh = Number(j.height) || 0; }',
    '    if (hc && hc.width > 0 && hc.height > 0) res = { width: Number(hc.width), height: Number(hc.height), source: "helper" };',
    '    else if (keeper && keeper.width > 0 && keeper.height > 0) res = { width: Number(keeper.width), height: Number(keeper.height), source: "keeper" };',
    '    else if (dw > 0 && dh > 0) res = { width: dw, height: dh, source: "desired" };',
    '  } catch { }'
  ].join("\n"),
  "status resolution"
);
rep(
  'windowIdleMin: winIdleMin, monitorPort: PORT, agentPort: AGENT_PORT };',
  'windowIdleMin: winIdleMin, resolution: res, monitorPort: PORT, agentPort: AGENT_PORT };',
  "status includes resolution"
);

// 18) P2-C pinned HTTPS: the monitor is a client of 8790 too (frames + health), so it makes the
//     same transport decision as the CLI/plugin -- pinned https when helper-cert.sha256 exists and
//     the handshake succeeds, plain http otherwise (VDESK_HTTP_ONLY=1, no cert, or probe failure),
//     with the reason printed once.
rep(
  'import http from "node:http";',
  'import http from "node:http";\nimport https from "node:https";',
  "https import"
);
rep(
  "function agentRequest(pathQuery, timeoutMs = 20000) {",
  [
    'const CERT_PIN_FILE = process.env.VDESK_CERT_PIN || "C:/Users/Administrator/AppData/Local/Temp/dsh-childsession/out/helper-cert.sha256";',
    'const TRANSPORT_TTL_MS = 5000;',
    'let helperTransport = { scheme: null, pin: null, at: 0, reason: "" };',
    'let lastTransportNote = "";',
    '',
    '// The helper serves a SELF-SIGNED certificate, so the trust anchor is the SHA-256 in',
    '// helper-cert.sha256, not the chain. Any failure only drops back to plain http: the panel must',
    '// never stop working because of the TLS rollout (the admin netsh binding may still be missing).',
    'function readCertPin() {',
    '  try {',
    '    const t = readFileSync(CERT_PIN_FILE, "utf8").toLowerCase().replace(/[^0-9a-f]/g, "");',
    '    return /^[0-9a-f]{64}$/.test(t) ? t : null;',
    '  } catch { return null; }',
    '}',
    '',
    'function noteTransport(t) {',
    '  const key = t.scheme + ":" + t.reason;',
    '  if (key === lastTransportNote) return;',
    '  lastTransportNote = key;',
    '  console.log("vdesk-monitor: helper transport -> " + t.scheme + " (" + t.reason + ")");',
    '}',
    '',
    'function resetTransport(why) {',
    '  helperTransport = { scheme: null, pin: null, at: 0, reason: why || "" };',
    '}',
    '',
    'function rawAgentRequest(ip, t, pathQuery, timeoutMs) {',
    '  return new Promise((resolve, reject) => {',
    '    const mod = t.scheme === "https" ? https : http;',
    '    const options = { host: ip, port: AGENT_PORT, path: pathQuery, method: "GET", headers: vdeskHeaders() };',
    '    if (t.scheme === "https") {',
    '      options.rejectUnauthorized = false;',
    '      options.checkServerIdentity = () => undefined;',
    '    }',
    '    let done = false;',
    '    const fail = (e) => { if (done) return; done = true; resetTransport("transport error: " + String((e && e.message) || e)); reject(e); };',
    '    const req = mod.request(options, (res) => {',
    '      const chunks = [];',
    '      res.on("data", (c) => chunks.push(c));',
    '      res.on("end", () => {',
    '        if (done) return;',
    '        done = true;',
    '        resolve({ status: res.statusCode, contentType: res.headers["content-type"] || "", body: Buffer.concat(chunks) });',
    '      });',
    '    });',
    '    if (t.scheme === "https") {',
    '      req.on("socket", (s) => {',
    '        s.on("secureConnect", () => {',
    '          try {',
    '            const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : null;',
    '            const fp = String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase();',
    '            if (!fp || fp !== t.pin) req.destroy(new Error("certificate pin mismatch (got " + (fp ? fp.slice(0, 16) : "none") + "..., pinned " + String(t.pin).slice(0, 16) + "...)"));',
    '          } catch (e) { req.destroy(new Error("pin check failed: " + String((e && e.message) || e))); }',
    '        });',
    '      });',
    '    }',
    '    req.setTimeout(timeoutMs, () => req.destroy(new Error("agent timeout after " + timeoutMs + "ms")));',
    '    req.on("error", fail);',
    '    req.end();',
    '  });',
    '}',
    '',
    'async function resolveTransport(force) {',
    '  const now = Date.now();',
    '  if (!force && helperTransport.scheme && now - helperTransport.at < TRANSPORT_TTL_MS) return helperTransport;',
    '  if (process.env.VDESK_HTTP_ONLY === "1") {',
    '    helperTransport = { scheme: "http", pin: null, at: now, reason: "VDESK_HTTP_ONLY=1" };',
    '    noteTransport(helperTransport);',
    '    return helperTransport;',
    '  }',
    '  const pin = readCertPin();',
    '  if (!pin) {',
    '    helperTransport = { scheme: "http", pin: null, at: now, reason: "no helper-cert.sha256 yet -- plain http" };',
    '    noteTransport(helperTransport);',
    '    return helperTransport;',
    '  }',
    '  try {',
    '    await rawAgentRequest("127.0.0.1", { scheme: "https", pin: pin }, "/health", 2500);',
    '    helperTransport = { scheme: "https", pin: pin, at: now, reason: "pinned https" };',
    '  } catch (e) {',
    '    helperTransport = { scheme: "http", pin: null, at: now, reason: "https probe failed (" + String((e && e.message) || e) + ") -> plain http" };',
    '  }',
    '  noteTransport(helperTransport);',
    '  return helperTransport;',
    '}',
    '',
    "function agentRequest(pathQuery, timeoutMs = 20000) {"
  ].join("\n"),
  "helper transport helpers"
);
rep(
  [
    "function agentRequest(pathQuery, timeoutMs = 20000) {",
    "  return new Promise((resolve, reject) => {",
    "    guestIp().then((ip) => {",
    "      const req = http.request(",
    '        { host: ip, port: AGENT_PORT, path: pathQuery, method: "GET", headers: vdeskHeaders() },',
    "        (res) => {",
    "          const chunks = [];",
    '          res.on("data", (c) => chunks.push(c));',
    '          res.on("end", () =>',
    "            resolve({",
    "              status: res.statusCode,",
    '              contentType: res.headers["content-type"] || "",',
    "              body: Buffer.concat(chunks)",
    "            })",
    "          );",
    "        }",
    "      );",
    '      req.setTimeout(timeoutMs, () => req.destroy(new Error(`agent timeout after ${timeoutMs}ms`)));',
    '      req.on("error", reject);',
    "      req.end();",
    "    }, reject);",
    "  });",
    "}"
  ].join("\n"),
  [
    "async function agentRequest(pathQuery, timeoutMs = 20000) {",
    "  const ip = await guestIp();",
    "  const t = await resolveTransport(false);",
    "  return rawAgentRequest(ip, t, pathQuery, timeoutMs);",
    "}"
  ].join("\n"),
  "agentRequest uses the transport"
);
rep(
  [
    '    const req = http.request({ host: "127.0.0.1", port: AGENT_PORT, path: "/health", method: "GET", timeout: 1500 },',
    '      (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => { try { healthBody = JSON.parse(Buffer.concat(c).toString("utf8")); } catch { healthBody = null; } }); });',
    '    req.on("error", () => { });',
    '    req.on("timeout", () => { req.destroy(); });',
    '    req.end();'
  ].join("\n"),
  [
    '    resolveTransport(false)',
    '      .then((t) => rawAgentRequest("127.0.0.1", t, "/health", 1500))',
    '      .then(',
    '        (r) => { try { healthBody = JSON.parse(r.body.toString("utf8")); } catch { healthBody = null; } },',
    '        () => { healthBody = null; }',
    '      );'
  ].join("\n"),
  "health cache uses the transport"
);

// 19) keep the probe/fallback chatter quiet: it is debug-only (VDESK_DEBUG=1) so a healthy run does
//     not print "EPROTO wrong version number" style noise; a pin REFUSAL is still printed, and a
//     mismatch never downgrades to plain http.
rep(
  [
    'function noteTransport(t) {',
    '  const key = t.scheme + ":" + t.reason;',
    '  if (key === lastTransportNote) return;',
    '  lastTransportNote = key;',
    '  console.log("vdesk-monitor: helper transport -> " + t.scheme + " (" + t.reason + ")");',
    '}'
  ].join("\n"),
  [
    'function noteTransport(t) {',
    '  const key = t.scheme + ":" + t.reason;',
    '  if (key === lastTransportNote) return;',
    '  lastTransportNote = key;',
    '  const line = "vdesk-monitor: helper transport -> " + t.scheme + " (" + t.reason + ")";',
    '  // probe/fallback chatter is debug-only; a pin REFUSAL is always printed',
    '  if (t.refused) console.log("vdesk-monitor: REFUSED " + line);',
    '  else if (process.env.VDESK_DEBUG === "1") console.log(line);',
    '}'
  ].join("\n"),
  "transport note is debug-gated"
);
rep(
  [
    '  try {',
    '    await rawAgentRequest("127.0.0.1", { scheme: "https", pin: pin }, "/health", 2500);',
    '    helperTransport = { scheme: "https", pin: pin, at: now, reason: "pinned https" };',
    '  } catch (e) {',
    '    helperTransport = { scheme: "http", pin: null, at: now, reason: "https probe failed (" + String((e && e.message) || e) + ") -> plain http" };',
    '  }'
  ].join("\n"),
  [
    '  try {',
    '    await rawAgentRequest("127.0.0.1", { scheme: "https", pin: pin }, "/health", 2500);',
    '    helperTransport = { scheme: "https", pin: pin, at: now, reason: "pinned https" };',
    '  } catch (e) {',
    '    const msg = String((e && e.message) || e);',
    '    if (/pin mismatch|pin check failed/i.test(msg)) {',
    '      helperTransport = { scheme: "https", pin: pin, at: now, reason: msg, refused: true };',
    '    } else {',
    '      helperTransport = { scheme: "http", pin: null, at: now, reason: "https probe failed (" + msg + ") -> plain http" };',
    '    }',
    '  }'
  ].join("\n"),
  "transport refuses on a pin mismatch"
);

// 20) P3-B: expose the post-start startup-isolation proof (out\startup-guard.json, written by
//     vdesk.ps1 start) as status.guest, e.g. { hermetic: true, found: [] }.
rep(
  '  let res = { width: 1280, height: 800, source: "default" };',
  [
    '  // P3-B: startup-isolation proof from the last start (hermetic === no singleton suite leaked in)',
    '  let guest = null;',
    '  try {',
    '    const guard = KEEPER_JSON.replace(/keeper\\.json$/, "startup-guard.json");',
    '    if (existsSync(guard)) guest = JSON.parse(readFileSync(guard, "utf8"));',
    '  } catch { }',
    '  let res = { width: 1280, height: 800, source: "default" };'
  ].join("\n"),
  "status guest guard"
);
rep(
  'windowIdleMin: winIdleMin, resolution: res, monitorPort: PORT, agentPort: AGENT_PORT };',
  'windowIdleMin: winIdleMin, resolution: res, guest: guest, monitorPort: PORT, agentPort: AGENT_PORT };',
  "status includes guest"
);

// 21) P3-C conflict detect-and-yield: the monitor probes vdesk.ps1 (read-only) so the plugin/CLI/UI
//     can refuse a start while machine-wide singleton programs are running; force=1 overrides.
rep(
  'const VDESK = "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\Documents\\\\\\\\deepseek-harness\\\\\\\\默认工作区\\\\\\\\tools\\\\\\\\vdesk-childsession\\\\\\\\vdesk.ps1";',
  'const VDESK = process.env.VDESK_PS1 || "C:\\\\\\\\Users\\\\\\\\Administrator\\\\\\\\Documents\\\\\\\\deepseek-harness\\\\\\\\默认工作区\\\\\\\\tools\\\\\\\\vdesk-childsession\\\\\\\\vdesk.ps1";',
  "vdesk ps1 override"
);
rep(
  "function vdeskRun(action) {",
  [
    "// Read-only singleton-conflict probe: run `vdesk.ps1 probe` and parse its one JSON line. The",
    "// probe action has no side effects, so this can never start or stop a session.",
    "function conflictProbe() {",
    "  return new Promise((resolve) => {",
    '    let out = "";',
    "    try {",
    '      const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, "probe"], { windowsHide: true });',
    '      const timer = setTimeout(() => { try { p.kill(); } catch { } }, 20000);',
    '      p.stdout.on("data", (d) => (out += d));',
    '      p.on("close", () => { clearTimeout(timer); resolve(parseConflict(out)); });',
    '      p.on("error", () => { clearTimeout(timer); resolve(null); });',
    "    } catch { resolve(null); }",
    "  });",
    "}",
    "",
    "function parseConflict(text) {",
    "  try {",
    '    const line = String(text).trim().split("\\n").filter(Boolean).pop();',
    '    const o = JSON.parse(line.replace(/^CONFLICT\\s+/, ""));',
    "    return { ok: true, checkedAt: o.checkedAt, found: Array.isArray(o.found) ? o.found : [], watchlist: o.watchlist || [], refused: !!o.refused };",
    "  } catch { return null; }",
    "}",
    "",
    "let conflictCache = { at: 0, value: null, pending: false };",
    "// status must stay fast: serve the cache and refresh it in the background when it is stale",
    "function conflictForStatus() {",
    "  const fresh = conflictCache.value && Date.now() - conflictCache.at < 60000;",
    "  if (!fresh && !conflictCache.pending) {",
    "    conflictCache.pending = true;",
    "    conflictProbe().then((v) => { if (v) conflictCache = { at: Date.now(), value: v, pending: false }; else conflictCache.pending = false; }, () => { conflictCache.pending = false; });",
    "  }",
    "  let rec = null;",
    '  try { const f = KEEPER_JSON.replace(/keeper\\.json$/, "conflict.json"); if (existsSync(f)) rec = JSON.parse(readFileSync(f, "utf8")); } catch { }',
    "  const live = conflictCache.value;",
    "  if (!live && !rec) return null;",
    "  return {",
    "    checkedAt: (live && live.checkedAt) || (rec && rec.checkedAt) || null,",
    "    found: (live && live.found) || (rec && rec.found) || [],",
    "    forced: !!(rec && rec.forced),",
    "    refused: !!(rec && rec.refused),",
    "  };",
    "}",
    "",
    "function vdeskRun(action, force) {"
  ].join("\n"),
  "conflict probe helpers"
);
rep(
  '    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, action];\n' +
  '    if (action === "start" || action === "restart") { args.push("-Minutes", "240"); }',
  '    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VDESK, action];\n' +
  '    if (action === "start" || action === "restart") { args.push("-Minutes", "240"); }\n' +
  '    if (force && action === "start") { args.push("-Force"); }',
  "vdeskRun force"
);
rep(
  '    if (route === "/vdesk/start" || route === "/vdesk/stop" || route === "/vdesk/restart") {\n' +
  '      const action = route === "/vdesk/start" ? "start" : (route === "/vdesk/stop" ? "stop" : "restart");\n' +
  "      const r = vdeskRun(action);\n" +
  '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n' +
  '      res.end(JSON.stringify({ ok: r.ok, action: action, note: r.note }));\n' +
  "      return;\n" +
  "    }",
  '    if (route === "/vdesk/conflict") {\n' +
  "      const v = await conflictProbe();\n" +
  "      conflictCache = { at: Date.now(), value: v, pending: false };\n" +
  '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n' +
  '      res.end(JSON.stringify(v || { ok: false, error: "probe-failed", found: [] }));\n' +
  "      return;\n" +
  "    }\n" +
  "\n" +
  '    if (route === "/vdesk/start" || route === "/vdesk/stop" || route === "/vdesk/restart") {\n' +
  '      const action = route === "/vdesk/start" ? "start" : (route === "/vdesk/stop" ? "stop" : "restart");\n' +
  '      const force = url.searchParams.get("force") === "1";\n' +
  '      // P4.1: vdeskRun() is fire-and-forget (it spawns the script, unrefs and returns at once), so\n' +
  '      // the P3-C refusal ("singleton-conflict", exit 4) used to be INVISIBLE: the UI got ok:true and\n' +
  '      // the desktop simply never appeared -- which reads as "the button does nothing" (user report,\n' +
  '      // 2026-10-02 14:47). Probe first (read-only, cached) and answer honestly WITHOUT spawning.\n' +
  '      if (action === "start" && !force) {\n' +
  '        const c = await conflictProbe();\n' +
  '        if (c && Array.isArray(c.found) && c.found.length > 0) {\n' +
  '          conflictCache = { at: Date.now(), value: c, pending: false };\n' +
  '          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n' +
  '          res.end(JSON.stringify({ ok: false, action: action, force: false, error: "singleton-conflict", found: c.found, advice: "检测到机器级单例程序正在运行：子会话登录时会再起一份并与它们抢单例（本机已两次导致桌面双崩）。请先退出它们，或确认接受风险后用 force=1（面板「强制启动」按钮）。" }));\n' +
  '          return;\n' +
  '        }\n' +
  '      }\n' +
  "      const r = vdeskRun(action, force);\n" +
  '      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n' +
  '      res.end(JSON.stringify({ ok: r.ok, action: action, force: force, note: r.note }));\n' +
  "      return;\n" +
  "    }",
  "conflict route + force pass-through"
);
rep(
  'resolution: res, guest: guest, monitorPort: PORT, agentPort: AGENT_PORT };',
  'resolution: res, guest: guest, conflict: conflictForStatus(), monitorPort: PORT, agentPort: AGENT_PORT };',
  "status includes conflict"
);

// 22) P4/B1: live MJPEG (/stream) and the batch input channel (/input) on 8791.
//
//     /stream is a long-lived multipart response, so it cannot use agentRequest() (that
//     buffers a whole body); pipeAgentStream pipes it through frame by frame and destroys
//     the upstream request when the browser goes away -- which is what ends the helper's
//     capture loop. /input forwards a POST body (or the ?events= query) verbatim and is
//     added to the origin allowlist AND to the takeover guard, so a view-only monitor
//     cannot be used as a back door around the 接管 lock.
rep(
  "function rawAgentRequest(ip, t, pathQuery, timeoutMs) {\n" +
  "  return new Promise((resolve, reject) => {\n" +
  "    const mod = t.scheme === \"https\" ? https : http;\n" +
  "    const options = { host: ip, port: AGENT_PORT, path: pathQuery, method: \"GET\", headers: vdeskHeaders() };",
  [
    "function rawAgentRequest(ip, t, pathQuery, timeoutMs, method, body) {",
    "  return new Promise((resolve, reject) => {",
    "    const mod = t.scheme === \"https\" ? https : http;",
    "    const headers = vdeskHeaders();",
    "    if (body) { headers[\"content-type\"] = \"application/json; charset=utf-8\"; headers[\"content-length\"] = String(body.length); }",
    "    const options = { host: ip, port: AGENT_PORT, path: pathQuery, method: method || \"GET\", headers: headers };"
  ].join("\n"),
  "rawAgentRequest method/body"
);
rep(
  '    req.setTimeout(timeoutMs, () => req.destroy(new Error("agent timeout after " + timeoutMs + "ms")));\n' +
  '    req.on("error", fail);\n' +
  "    req.end();",
  '    req.setTimeout(timeoutMs, () => req.destroy(new Error("agent timeout after " + timeoutMs + "ms")));\n' +
  '    req.on("error", fail);\n' +
  "    req.end(body || undefined);",
  "rawAgentRequest sends the body"
);
rep(
  "async function agentRequest(pathQuery, timeoutMs = 20000) {",
  [
    "// P4: live MJPEG cannot go through agentRequest() -- that buffers the whole body and a",
    "// stream never ends. This pipes the helper's multipart response straight through, passes",
    "// a non-200 (401 unauthorized) out as JSON, and destroys the upstream request when the",
    "// browser goes away (that is what ends the helper's capture loop and releases it).",
    "function pipeAgentStream(pathQuery, res) {",
    "  return resolveTransport(false).then((t) => new Promise((resolve) => {",
    "    const mod = t.scheme === \"https\" ? https : http;",
    "    const options = { host: AGENT_HOST, port: AGENT_PORT, path: pathQuery, method: \"GET\", headers: vdeskHeaders() };",
    "    if (t.scheme === \"https\") { options.rejectUnauthorized = false; options.checkServerIdentity = () => undefined; }",
    "    let settled = false;",
    "    const finish = () => { if (!settled) { settled = true; resolve(); } };",
    "    const upstream = mod.request(options, (r) => {",
    "      if (r.statusCode !== 200) {",
    "        const chunks = [];",
    "        r.on(\"data\", (c) => chunks.push(c));",
    "        r.on(\"end\", () => {",
    "          res.writeHead(r.statusCode || 502, { \"content-type\": \"application/json; charset=utf-8\", \"cache-control\": \"no-store\" });",
    "          res.end(Buffer.concat(chunks));",
    "          finish();",
    "        });",
    "        return;",
    "      }",
    "      res.writeHead(200, {",
    "        \"content-type\": r.headers[\"content-type\"] || \"multipart/x-mixed-replace; boundary=dshframe\",",
    "        \"cache-control\": \"no-store\",",
    "      });",
    "      r.pipe(res);",
    "      r.on(\"end\", finish);",
    "      r.on(\"error\", finish);",
    "    });",
    "    if (t.scheme === \"https\") {",
    "      upstream.on(\"socket\", (s) => s.on(\"secureConnect\", () => {",
    "        try {",
    "          const cert = typeof s.getPeerCertificate === \"function\" ? s.getPeerCertificate() : null;",
    "          const fp = String((cert && cert.fingerprint256) || \"\").replace(/:/g, \"\").toLowerCase();",
    "          if (!fp || fp !== t.pin) upstream.destroy(new Error(\"certificate pin mismatch\"));",
    "        } catch (e) { upstream.destroy(e); }",
    "      }));",
    "    }",
    "    // browser closed the tab / img -> drop the helper request so its loop exits",
    "    res.on(\"close\", () => { try { upstream.destroy(); } catch { } finish(); });",
    "    upstream.on(\"error\", () => {",
    "      if (!res.headersSent) {",
    "        try { res.writeHead(502, { \"content-type\": \"application/json; charset=utf-8\" }); res.end(JSON.stringify({ ok: false, error: \"stream unavailable\" })); } catch { }",
    "      }",
    "      finish();",
    "    });",
    "    upstream.end();",
    "  })).catch(() => {",
    "    if (!res.headersSent) {",
    "      try { res.writeHead(502, { \"content-type\": \"application/json; charset=utf-8\" }); res.end(JSON.stringify({ ok: false, error: \"helper unreachable\" })); } catch { }",
    "    }",
    "  });",
    "}",
    "",
    "// P4: /input is a normal buffered request, so it reuses rawAgentRequest with a body.",
    "async function agentInput(pathQuery, body) {",
    "  const ip = await guestIp();",
    "  const t = await resolveTransport(false);",
    "  return rawAgentRequest(ip, t, pathQuery, 30000, \"POST\", body);",
    "}",
    "",
    "function readRequestBody(req, limit) {",
    "  return new Promise((resolve) => {",
    "    const chunks = [];",
    "    let n = 0;",
    "    req.on(\"data\", (c) => { n += c.length; if (n <= (limit || 1048576)) chunks.push(c); });",
    "    req.on(\"end\", () => resolve(Buffer.concat(chunks)));",
    "    req.on(\"error\", () => resolve(Buffer.concat(chunks)));",
    "  });",
    "}",
    "",
    "// P4 click mapping: the panel sends NORMALISED coordinates (px / rect.width); <=1 is a",
    "// fraction of the desktop, >1 stays pixels -- the same px() rule vdesk-cli/plugin use --",
    "// clamped into the desktop size the helper reports.",
    "function resolveNorm(v, dim) {",
    "  const d = dim > 0 ? dim : 1280;",
    "  const n = v <= 1 ? Math.round(v * d) : Math.round(v);",
    "  return Math.max(0, Math.min(d - 1, n));",
    "}",
    "",
    "function helperDesktopSize() {",
    "  const h = healthCache();",
    "  if (h && h.width > 0 && h.height > 0) return { width: h.width, height: h.height };",
    "  return { width: 1280, height: 800 };",
    "}",
    "",
    "async function agentRequest(pathQuery, timeoutMs = 20000) {"
  ].join("\n"),
  "stream + input helpers"
);
rep(
  'const WRITE_ROUTES = new Set(["/vdesk/start", "/vdesk/stop", "/vdesk/restart", "/vdesk/window", "/mouse", "/key", "/click"]);',
  'const WRITE_ROUTES = new Set(["/vdesk/start", "/vdesk/stop", "/vdesk/restart", "/vdesk/window", "/mouse", "/key", "/click", "/input"]);',
  "input is a write route"
);
rep(
  '    if ((route === "/mouse" || route === "/key" || route === "/click") && !takeover) {',
  '    if ((route === "/mouse" || route === "/key" || route === "/click" || route === "/input") && !takeover) {',
  "input respects the takeover lock"
);
rep(
  '    if (route === "/takeover") {',
  [
    '    if (route === "/stream") {',
    '      // P4 live view: the query string is copied verbatim to the helper (frozen',
    '      // contract) and the multipart body is piped through untouched; a helper 401 is',
    '      // surfaced as JSON instead of being framed as an image.',
    '      await pipeAgentStream(route + url.search, res);',
    '      return;',
    '    }',
    '',
    '    if (route === "/takeover") {'
  ].join("\n"),
  "stream route"
);
rep(
  '    if (route === "/click") {\n' +
  '      const x = Number(url.searchParams.get("x"));\n' +
  '      const y = Number(url.searchParams.get("y"));\n' +
  '      if (!Number.isFinite(x) || !Number.isFinite(y)) {\n' +
  '        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });\n' +
  '        res.end(\'{"ok":false,"error":"x and y required"}\');\n' +
  '        return;\n' +
  '      }\n' +
  '      const button = url.searchParams.get("button") || "left";\n' +
  '      const r = await agentRequest(`/mouse?action=click&x=${x}&y=${y}&button=${button}&count=1`, 15000);',
  [
    '    if (route === "/click") {',
    '      const rawX = Number(url.searchParams.get("x"));',
    '      const rawY = Number(url.searchParams.get("y"));',
    '      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {',
    '        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });',
    '        res.end(\'{"ok":false,"error":"x and y required"}\');',
    '        return;',
    '      }',
    '      // P4: accept NORMALISED coordinates (px / rect.width) as well as pixels, so the',
    '      // DSH panel can post its image-relative click straight through.',
    '      const size = helperDesktopSize();',
    '      const x = resolveNorm(rawX, size.width);',
    '      const y = resolveNorm(rawY, size.height);',
    '      const button = url.searchParams.get("button") || "left";',
    '      const r = await agentRequest(`/mouse?action=click&x=${x}&y=${y}&button=${button}&count=1`, 15000);'
  ].join("\n"),
  "click accepts normalised coordinates"
);
rep(
  '    if (route === "/vdesk/task") {',
  [
    '    if (route === "/input") {',
    '      // P4 batch input: the JSON body (or ?events=) is forwarded verbatim; the helper',
    '      // runs the event list in order on one thread. Reachable only after the origin',
    '      // guard and the takeover lock above.',
    '      const payload = req.method === "POST" ? await readRequestBody(req) : null;',
    '      const r = payload === null ? await agentRequest(route + url.search, 30000) : await agentInput(route + url.search, payload);',
    '      touchWindow(false);',
    '      res.writeHead(r.status || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });',
    '      res.end(r.body);',
    '      return;',
    '    }',
    '',
    '    if (route === "/vdesk/task") {'
  ].join("\n"),
  "input route"
);

writeFileSync(DST, t, "utf8");
console.log("written:", DST, `(${before} -> ${t.length} chars)`);
if (misses.length) { console.log("MISSES:", misses.join(", ")); process.exitCode = 2; }
else { console.log("all replacements applied"); }
