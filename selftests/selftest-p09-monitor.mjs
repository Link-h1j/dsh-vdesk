// P0.9 monitor-side self-check: policy-B observability (/vdesk/status window fields), the touch
// clock refreshed by forwarded input, and the flag lifecycle from the panel's window routes.
// Lives in %TEMP%; no session is started and no window can appear (no keeper is running).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out", "p09-mon");
const KEEPER_JSON = path.join(BASE, "keeper.json");
const WIN_FLAG = path.join(BASE, "keeper.window");
const WIN_TOUCH = path.join(BASE, "keeper.touch");
const HELP = 18800;
const MONI = 18820;

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}
const helperCalls = [];
const helper = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  helperCalls.push(u.pathname + u.search);
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, width: 1280, height: 800 }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: u.pathname }));
});
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));

function raw(method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: MONI, path: pathname, method, headers: headers || {} }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {}
        resolve({ status: res.statusCode, json, body: Buffer.concat(c).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const status = () => raw("GET", "/vdesk/status");
const ago = (sec) => new Date(Date.now() - sec * 1000);

const mon = spawn(process.execPath, [MONITOR_JS], {
  env: {
    ...process.env,
    DSH_VDESK_MONITOR_PORT: String(MONI),
    VDESK_HELPER_PORT: String(HELP),
    VDESK_KEEPER_JSON: KEEPER_JSON,
    VDESK_TASKS: BASE,
    VDESK_WINDOW_IDLE_MIN: "7",
  },
  stdio: "ignore",
});
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await status(); return true; } catch { await new Promise((r) => setTimeout(r, 120)); }
  }
  return false;
}

try {
  check(await waitUp(), "monitor is up on " + MONI);

  // ---- A: keeper running and window open -> keeper's own clock wins ----
  fs.writeFileSync(KEEPER_JSON, JSON.stringify({
    ok: true, pid: 111, phase: "holding", childId: 7, candidates: "7:s0",
    windowed: true, windowSince: "2026-10-02T10:00:00.000Z", windowIdleSec: 42, windowIdleMin: 15,
  }));
  fs.writeFileSync(WIN_FLAG, "x");
  fs.utimesSync(WIN_FLAG, ago(300), ago(300)); // opened 5 minutes ago
  fs.writeFileSync(WIN_TOUCH, "x");
  fs.utimesSync(WIN_TOUCH, ago(60), ago(60)); // last interaction a minute ago (newer than the flag)
  let st = await status();
  check(st.status === 200 && st.json.window === true, "status: window open", st.json && st.json.window);
  check(st.json.windowIdleSec === 42, "status: windowIdleSec comes from the keeper", st.json.windowIdleSec);
  check(st.json.windowIdleMin === 15, "status: windowIdleMin comes from the keeper", st.json.windowIdleMin);
  check(st.json.windowSince === "2026-10-02T10:00:00.000Z", "status: windowSince from the keeper", st.json.windowSince);
  check(typeof st.json.lastWindowTouch === "string" && !Number.isNaN(Date.parse(st.json.lastWindowTouch)), "status: lastWindowTouch is an ISO time", st.json.lastWindowTouch);

  // ---- B: keeper gone -> files are the fallback, env supplies the threshold ----
  fs.rmSync(KEEPER_JSON, { force: true });
  st = await status();
  check(st.json.window === true && st.json.windowIdleMin === 7, "status: env threshold used without a keeper", [st.json.window, st.json.windowIdleMin]);
  check(typeof st.json.windowIdleSec === "number" && st.json.windowIdleSec >= 55 && st.json.windowIdleSec <= 80, "status: idle derived from the newer file (~60s)", st.json.windowIdleSec);

  // ---- C: no flag -> nothing to report ----
  fs.rmSync(WIN_FLAG, { force: true });
  fs.rmSync(WIN_TOUCH, { force: true });
  st = await status();
  check(st.json.window === false, "status: window closed", st.json.window);
  check(st.json.windowIdleSec === null && st.json.windowSince === null && st.json.lastWindowTouch === null, "status: closed window reports nulls", [st.json.windowIdleSec, st.json.windowSince, st.json.lastWindowTouch]);

  // ---- D: the panel opens the window -> flag + touch seeded ----
  let r = await raw("POST", "/vdesk/window?on=1");
  check(r.status === 200 && JSON.parse(r.body).ok === true, "window on accepted", [r.status, r.body]);
  check(fs.existsSync(WIN_FLAG) && fs.existsSync(WIN_TOUCH), "window on creates flag + touch", [fs.existsSync(WIN_FLAG), fs.existsSync(WIN_TOUCH)]);
  st = await status();
  check(st.json.window === true && st.json.windowIdleSec <= 3, "status: freshly opened window is idle ~0s", st.json.windowIdleSec);

  // ---- E: forwarded input refreshes the touch clock; foreign origins still 403 ----
  fs.writeFileSync(WIN_TOUCH, "x");
  fs.utimesSync(WIN_TOUCH, ago(600), ago(600));
  const before = fs.statSync(WIN_TOUCH).mtimeMs;
  r = await raw("POST", "/mouse?action=move&x=1&y=2");
  check(r.status === 200 && JSON.parse(r.body).ok === true, "mouse forwarded to the helper", [r.status, r.body]);
  check(helperCalls.some((c) => c.startsWith("/mouse")), "helper received the injection", helperCalls.filter((c) => c.startsWith("/mouse")));
  check(fs.statSync(WIN_TOUCH).mtimeMs > before, "forwarded input refreshed keeper.touch", [before, fs.statSync(WIN_TOUCH).mtimeMs]);
  const evil = await raw("POST", "/mouse?action=move&x=1&y=2", { origin: "http://evil.example" });
  check(evil.status === 403, "foreign origin still refused on write routes", evil.status);

  // ---- F: the panel closes the window -> flag + touch both cleared ----
  r = await raw("POST", "/vdesk/window?on=0");
  check(r.status === 200, "window off accepted", r.status);
  check(!fs.existsSync(WIN_FLAG) && !fs.existsSync(WIN_TOUCH), "window off clears flag + touch", [fs.existsSync(WIN_FLAG), fs.existsSync(WIN_TOUCH)]);
  st = await status();
  check(st.json.window === false, "status: closed again", st.json.window);
} finally {
  mon.kill();
}
await new Promise((r) => helper.close(r));
fs.rmSync(BASE, { recursive: true, force: true });

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
