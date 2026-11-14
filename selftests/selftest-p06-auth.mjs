// P0.6 host-side self-check: token on every 8790 call (CLI + plugin), no token to 8791, monitor's
// allowlist (403 on foreign-origin writes, read-only still open) and its token forward to 8790.
// Lives in %TEMP% on purpose. No virtual desktop is started; a mock helper enforces the protocol.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const CLI = path.join(ROOT, "vdesk-cli.mjs");
const INDEX = path.join(ROOT, "plugin", "dsh-vdesk", "index.js");
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");

const GOOD = "0123456789abcdef0123456789abcdef";
const BAD = "ffffffffffffffffffffffffffffffff";
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out", "p06-selftest");
const SHOTS = path.join(BASE, "shots");
const TASKS = path.join(BASE, "tasks");
const GOOD_FILE = path.join(BASE, "good.token");
const BAD_FILE = path.join(BASE, "bad.token");
const MISSING_FILE = path.join(BASE, "does-not-exist.token");

const HELP = 18800;
const MON = 18801;
const MONI = 18802; // generated monitor, good token
const MONI2 = 18803; // generated monitor, bad token
const HELPER_ORIGIN = "http://127.0.0.1:" + MONI;

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
fs.writeFileSync(GOOD_FILE, GOOD + "\n");
fs.writeFileSync(BAD_FILE, BAD + "\n");

const seen = { helper: [], monitor: [] };
const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}
function json(res, obj, code = 200) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function png() {
  const b = Buffer.alloc(40);
  b[0] = 0x89; b.write("PNG", 1, "ascii");
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1200, 16); b.writeUInt32BE(675, 20);
  return b;
}

const helper = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const token = req.headers["x-vdesk-token"] || null;
  seen.helper.push({ path: u.pathname + u.search, token });
  // /health is the one exempt route (task-10), everything else must present the token
  if (u.pathname === "/health") return json(res, { ok: true, width: 1600, height: 900 });
  if (token !== GOOD) return json(res, { ok: false, error: "unauthorized" }, 401);
  if (u.pathname === "/screenshot") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png());
  }
  if (u.pathname === "/clipboard") return json(res, { ok: true, chars: 5 });
  return json(res, { ok: true, path: u.pathname, query: Object.fromEntries(u.searchParams) });
});
const monitor = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.monitor.push({ path: u.pathname, token: req.headers["x-vdesk-token"] || null });
  if (u.pathname === "/vdesk/status") return json(res, { ok: true, keeper: { phase: "stopped" }, monitorPort: MON });
  return json(res, { ok: true, action: "mock" });
});
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));
await new Promise((r) => monitor.listen(MON, "127.0.0.1", r));

function runCli(args, tokenFile) {
  return new Promise((resolve) => {
    // P4 sandbox note: the DSH file sandbox denies the named pipes Node creates for
    // stdio:"pipe" (spawn EPERM), so this copy redirects the CLI's stdout/stderr to files
    // and reads them back. Semantics are unchanged: same process, same env, same output.
    const outFile = path.join(BASE, "cli-out.txt");
    const errFile = path.join(BASE, "cli-err.txt");
    const fo = fs.openSync(outFile, "w");
    const fe = fs.openSync(errFile, "w");
    const p = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        VDESK_HELPER: "http://127.0.0.1:" + HELP,
        VDESK_MONITOR: "http://127.0.0.1:" + MON,
        VDESK_SHOTS: SHOTS,
        VDESK_TOKEN_FILE: tokenFile,
      },
      stdio: ["ignore", fo, fe],
    });
    p.on("close", () => {
      try { fs.closeSync(fo); } catch {}
      try { fs.closeSync(fe); } catch {}
      let out = "", err = "";
      try { out = fs.readFileSync(outFile, "utf8"); } catch {}
      try { err = fs.readFileSync(errFile, "utf8"); } catch {}
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      resolve({ out, err, json: parsed });
    });
  });
}
function raw(port, method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: headers || {} }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { await raw(port, "GET", "/vdesk/status"); return true; } catch { await new Promise((r) => setTimeout(r, 120)); }
  }
  return false;
}

/* ============================ CLI ============================ */
{
  const n = seen.helper.length;
  const r = await runCli(["key", "ctrl+s", "--no-after"], GOOD_FILE);
  const calls = seen.helper.slice(n);
  check(r.json && r.json.ok === true, "CLI ok with the correct token", r.json);
  check(calls.length === 1 && calls[0].token === GOOD, "CLI sends X-VDesk-Token to 8790", calls);
  check(!/401/.test(r.err), "CLI does not warn when authorized", r.err);
}
{
  const n = seen.monitor.length;
  const r = await runCli(["status"], GOOD_FILE);
  const calls = seen.monitor.slice(n);
  check(r.json && r.json.ok === true, "CLI status (8791) works", r.json);
  check(calls.length === 1 && calls[0].token === null, "CLI does not leak the token to 8791", calls);
}
{
  const n = seen.helper.length;
  const r = await runCli(["key", "ctrl+s", "--no-after"], BAD_FILE);
  const calls = seen.helper.slice(n);
  check(r.json && r.json.ok === false && /unauthorized/.test(r.json.error || ""), "CLI wrong token -> ok:false/unauthorized", r.json);
  check(/401/.test(r.err) && /token/.test(r.err), "CLI wrong token warns on stderr", r.err.trim());
  check(calls.length === 1 && calls[0].token === BAD, "CLI sent the wrong token (not a hidden fallback)", calls);
}
{
  const n = seen.helper.length;
  const r = await runCli(["key", "ctrl+s", "--no-after"], MISSING_FILE);
  const calls = seen.helper.slice(n);
  check(r.json && r.json.ok === false && /unauthorized/.test(r.json.error || ""), "CLI missing token file -> unauthorized", r.json);
  check(calls.length === 1 && calls[0].token === null, "CLI missing token file sends NO header", calls);
  check(/401/.test(r.err), "CLI missing token file warns on stderr", r.err.trim());
}
{
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const r = await runCli(["shot"], BAD_FILE);
  check(r.json && r.json.ok === false && r.json.error === "unauthorized", "CLI shot on 401 does not pretend to be an image", r.json);
  check(!fs.existsSync(SHOTS) || fs.readdirSync(SHOTS).length === 0, "CLI 401 screenshot writes no bogus file", fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []);
}

/* ============================ plugin ============================ */
process.env.VDESK_NO_KEEPALIVE = "1";
process.env.VDESK_NO_LIFECYCLE = "1";
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_SHOTS = SHOTS;
process.env.VDESK_TASKS = TASKS;
process.env.VDESK_TOKEN_FILE = GOOD_FILE;
const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));
const call = (name, args) => byName[name].execute({ ...args }, { signal: undefined });
check(regs.length === 18, "plugin still registers 18 tools (P4: + vdesk_clipboard)", regs.length);

{
  const n = seen.helper.length;
  const r = await call("vdesk_click", { x: 0.5, y: 0.5, after: false });
  const calls = seen.helper.slice(n);
  check(r.ok === true, "plugin click ok with token", r);
  check(calls.length >= 1 && calls.every((c) => c.token === GOOD), "plugin tool sends the token on 8790 calls", calls);
}
{
  const n = seen.helper.length;
  const r = await call("vdesk_screenshot", {});
  const calls = seen.helper.slice(n);
  check(r.ok === true && fs.existsSync(r.path), "plugin screenshot ok (token on /screenshot)", r.path);
  check(calls.some((c) => c.path.startsWith("/screenshot") && c.token === GOOD), "plugin screenshot carries the token", calls);
}
{
  const n = seen.helper.length;
  const r = await call("vdesk_type", { text: "hello", after: false });
  const calls = seen.helper.slice(n);
  check(r.ok === true && r.via === "clipboard+ctrl+v", "plugin type still works", r.via);
  check(calls.filter((c) => c.token === GOOD).length === 2, "both clipboard set and ctrl+v carry the token", calls);
}
{
  const n = seen.monitor.length;
  await call("vdesk_status", {});
  const calls = seen.monitor.slice(n);
  check(calls.length === 1 && calls[0].token === null, "plugin does not leak the token to 8791", calls);
}
{
  process.env.VDESK_TOKEN_FILE = BAD_FILE;
  const n = seen.helper.length;
  const r = await call("vdesk_key", { combo: "ctrl+s", after: false });
  const calls = seen.helper.slice(n);
  check(r.ok === false && /unauthorized/.test(String(r.error)), "plugin wrong token -> readable unauthorized error", r);
  check(calls.length === 1 && calls[0].token === BAD, "plugin re-read the token file per call (rotation)", calls);
}
{
  process.env.VDESK_TOKEN_FILE = MISSING_FILE;
  const n = seen.helper.length;
  const r = await call("vdesk_move", { x: 0.5, y: 0.5, after: false });
  const calls = seen.helper.slice(n).filter((c) => !c.path.startsWith("/health"));
  check(r.ok === false && /unauthorized/.test(String(r.error)), "plugin missing token file -> unauthorized", r);
  check(calls.length === 1 && calls[0].token === null, "plugin missing token file sends no header", calls);
}
{
  process.env.VDESK_TOKEN_FILE = MISSING_FILE;
  const n = seen.helper.length;
  const r = await call("vdesk_type", { text: "中文", after: false });
  const calls = seen.helper.slice(n);
  check(r.ok === false && /unauthorized/.test(String(r.error)), "plugin clipboard path reports unauthorized", r);
  check(calls.length >= 1 && calls[0].token === null, "plugin clipboard path sent no header", calls);
}
{
  process.env.VDESK_TOKEN_FILE = GOOD_FILE;
  const n = seen.helper.length;
  const r = await call("vdesk_drag", { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, after: false });
  const calls = seen.helper.slice(n);
  check(r.ok === true && calls.every((c) => c.token === GOOD), "plugin drag carries the token after restore", calls);
}

/* ============================ monitor ============================ */
const spawnMonitor = (port, tokenFile) =>
  spawn(process.execPath, [MONITOR_JS], {
    env: { ...process.env, DSH_VDESK_MONITOR_PORT: String(port), VDESK_HELPER_PORT: String(HELP), VDESK_TOKEN_FILE: tokenFile, VDESK_TASKS: TASKS },
    stdio: "ignore",
  });
const mi = spawnMonitor(MONI, GOOD_FILE);
const mi2 = spawnMonitor(MONI2, BAD_FILE);
try {
  check(await waitUp(MONI), "monitor (good token) is up on " + MONI);
  check(await waitUp(MONI2), "monitor (bad token) is up on " + MONI2);

  // forwarding to 8790 carries the token
  const n1 = seen.helper.length;
  const shot = await raw(MONI, "GET", "/shot?format=jpg&scale=0.5");
  check(shot.status === 200 && shot.headers["content-type"] === "image/png", "monitor /shot returns the helper image", shot.status);
  check(seen.helper.slice(n1).some((c) => c.path.startsWith("/screenshot") && c.token === GOOD), "monitor /shot carries the token to 8790", seen.helper.slice(n1));

  // read-only routes stay open for any origin, but only allowed origins get CORS headers
  const metaEvil = await raw(MONI, "GET", "/meta", { origin: "http://evil.example" });
  check(metaEvil.status === 200, "read-only /meta still answers a foreign origin", metaEvil.status);
  check(!metaEvil.headers["access-control-allow-origin"], "foreign origin gets no CORS header", metaEvil.headers["access-control-allow-origin"]);
  const metaOk = await raw(MONI, "GET", "/meta", { origin: "http://127.0.0.1:19387" });
  check(metaOk.status === 200 && metaOk.headers["access-control-allow-origin"] === "http://127.0.0.1:19387", "DSH UI origin is echoed in CORS", metaOk.headers["access-control-allow-origin"]);
  const statusEvil = await raw(MONI, "GET", "/vdesk/status", { origin: "http://evil.example" });
  check(statusEvil.status === 200, "read-only /vdesk/status still answers a foreign origin", statusEvil.status);

  // preflight
  const optEvil = await raw(MONI, "OPTIONS", "/mouse", { origin: "http://evil.example" });
  check(optEvil.status === 403, "OPTIONS from a foreign origin -> 403", optEvil.status);
  const optOk = await raw(MONI, "OPTIONS", "/mouse", { origin: "dsh-app://app" });
  check(optOk.status === 204 && optOk.headers["access-control-allow-origin"] === "dsh-app://app", "OPTIONS from the app origin -> 204 + CORS", [optOk.status, optOk.headers["access-control-allow-origin"]]);

  // write routes: foreign origin refused, allowed origins (and no-Origin local clients) pass
  const before = seen.helper.length;
  const evilPost = await raw(MONI, "POST", "/mouse?action=move&x=1&y=1", { origin: "http://evil.example" });
  check(evilPost.status === 403 && /forbidden origin/.test(evilPost.body), "foreign-origin write -> 403", [evilPost.status, evilPost.body]);
  check(seen.helper.length === before, "refused write never reaches 8790", seen.helper.length - before);
  const okPost = await raw(MONI, "POST", "/mouse?action=move&x=2&y=2", { origin: "dsh-app://app" });
  check(okPost.status === 200 && JSON.parse(okPost.body).ok === true, "app-origin write passes through", [okPost.status, okPost.body]);
  check(seen.helper.slice(before).some((c) => c.path.startsWith("/mouse") && c.token === GOOD), "forwarded write carries the token", seen.helper.slice(before));
  const noOrigin = await raw(MONI, "POST", "/mouse?action=move&x=3&y=3", {});
  check(noOrigin.status === 200 && JSON.parse(noOrigin.body).ok === true, "no-Origin local client write passes", [noOrigin.status, noOrigin.body]);
  const ownPage = await raw(MONI, "POST", "/key?action=combo&vks=17,83", { origin: HELPER_ORIGIN });
  check(ownPage.status === 200 && JSON.parse(ownPage.body).ok === true, "monitor's own page (same-origin) write passes", [ownPage.status, ownPage.body]);
  const localUi = await raw(MONI, "POST", "/click?x=10&y=10", { origin: "http://localhost:19387" });
  check(localUi.status === 200, "localhost:19387 click passes", localUi.status);

  // the panel's own read routes are unaffected
  const task = await raw(MONI, "GET", "/vdesk/task", { origin: "http://127.0.0.1:19387" });
  check(task.status === 200 && JSON.parse(task.body).ok === true, "panel /vdesk/task still readable", task.status);

  // helper 401 is surfaced instead of being rendered as an image
  const badShot = await raw(MONI2, "GET", "/shot");
  check(badShot.status === 401 && JSON.parse(badShot.body).error === "unauthorized", "bad token -> monitor /shot 401 unauthorized", [badShot.status, badShot.body]);
  const badMeta = await raw(MONI2, "GET", "/meta");
  check(badMeta.status === 200, "/health stays exempt even with a bad token", badMeta.status);
} finally {
  mi.kill();
  mi2.kill();
}

await new Promise((r) => helper.close(r));
await new Promise((r) => monitor.close(r));
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
