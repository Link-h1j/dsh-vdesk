// P2-B/C self-check: vdesk_apps pass-through (incl. blocked-by-policy), and the pinned-HTTPS
// transport of the plugin / CLI / monitor with its http fallbacks.
// Lives in %TEMP%; starts no session, opens no window. Uses the REAL helper certificate from
// task-15 to stand up a local HTTPS server (the helper itself is not touched).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const CLI = path.join(ROOT, "vdesk-cli.mjs");
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");
// P4 copy note (tools-dev): the sandbox cannot WRITE the real %TEMP%\dsh-childsession, so reads
// (cert artifacts, p2bc-run.mjs, plugin-host.log) use the literal real temp path while every
// writable artifact lands under this selftests/ scratch dir.
const REAL_TEMP = "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession";
const RUNNER = path.join(REAL_TEMP, "p2bc-run.mjs");
const OUT = path.join(REAL_TEMP, "out");
const PFX = path.join(OUT, "helper-cert.pfx");
const PWD = path.join(OUT, "helper-cert.pwd");
const PIN = path.join(OUT, "helper-cert.sha256");
const BASE = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\selftests\\.scratch\\p2bc";
const TOKEN_FILE = path.join(BASE, "token");
const BAD_PIN_FILE = path.join(BASE, "bad.pin");
const NO_PIN_FILE = path.join(BASE, "missing.pin");
const GOOD = "0123456789abcdef0123456789abcdef";

const HTTPS_PORT = 18930;
const HTTP_PORT = 18931;
const MON_HTTPS = 18932;
const MON_HTTP = 18933;
// host-half log: writable scratch, injected into the spawned plugin via VDESK_PLUGIN_LOG
const CLI_SCRATCH = path.join(ROOT, "selftests", ".scratch", "p2bc-cli");
const PLUGIN_LOG = path.join(CLI_SCRATCH, "plugin-host.log");

fs.rmSync(BASE, { recursive: true, force: true });
fs.rmSync(CLI_SCRATCH, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(CLI_SCRATCH, { recursive: true });
fs.writeFileSync(PLUGIN_LOG, "");
fs.writeFileSync(TOKEN_FILE, GOOD);
fs.writeFileSync(BAD_PIN_FILE, "a".repeat(64) + "\n");

const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- the task-15 certificate ---------------- */
check(fs.existsSync(PFX) && fs.existsSync(PWD) && fs.existsSync(PIN), "task-15 cert artifacts exist", [fs.existsSync(PFX), fs.existsSync(PWD), fs.existsSync(PIN)]);
const pin = fs.readFileSync(PIN, "utf8").trim().toLowerCase();
check(/^[0-9a-f]{64}$/.test(pin), "helper-cert.sha256 is 64 hex chars", pin.slice(0, 16));
const pfx = fs.readFileSync(PFX);
const passphrase = fs.readFileSync(PWD, "utf8").trim();

/* ---------------- mock helpers (https + http) ---------------- */
const APPS = [
  { name: "记事本", target: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", source: "appx" },
  { name: "画图", target: "mspaint.exe", source: "apppaths" },
  { name: "计算器", target: "calc.exe", source: "startmenu" },
];
const seen = { https: [], http: [] };
function appsResponse(u, token) {
  if (u.pathname === "/health") return { code: 200, body: { ok: true, width: 1280, height: 800, tls: true, pointer: { x: 1, y: 2 } } };
  if (token !== GOOD) return { code: 401, body: { ok: false, error: "unauthorized" } };
  if (u.pathname === "/apps") {
    const action = u.searchParams.get("action");
    if (action === "list") return { code: 200, body: { ok: true, count: APPS.length, apps: APPS } };
    const name = u.searchParams.get("name") || "";
    if (/doubao|豆包/i.test(name)) return { code: 200, body: { ok: false, error: "blocked-by-policy" } };
    if (name === "记事本") return { code: 200, body: { ok: true, matched: "记事本", pid: 4242, source: "appx" } };
    return { code: 200, body: { ok: false, error: "no-match", candidates: ["画图", "计算器"] } };
  }
  return { code: 200, body: { ok: true, path: u.pathname } };
}
const makeHandler = (bucket) => (req, res) => {
  const u = new URL(req.url, "http://x");
  bucket.push({ path: u.pathname + u.search, token: req.headers["x-vdesk-token"] || null });
  const r = appsResponse(u, req.headers["x-vdesk-token"]);
  res.writeHead(r.code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(r.body));
};
const httpsHelper = https.createServer({ pfx, passphrase }, makeHandler(seen.https));
const httpHelper = http.createServer(makeHandler(seen.http));
await new Promise((r) => httpsHelper.listen(HTTPS_PORT, "127.0.0.1", r));
await new Promise((r) => httpHelper.listen(HTTP_PORT, "127.0.0.1", r));

// cross-check: what a TLS client actually sees must equal the pin file task-15 wrote
const realFp = await new Promise((resolve, reject) => {
  const req = https.request({ host: "127.0.0.1", port: HTTPS_PORT, path: "/health", method: "GET", rejectUnauthorized: false }, (res) => {
    const cert = res.socket.getPeerCertificate();
    res.resume();
    resolve(String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase());
  });
  req.on("error", reject);
  req.end();
});
check(realFp === pin, "pin file matches the certificate a client sees", [realFp.slice(0, 16), pin.slice(0, 16)]);

function envFor(opts) {
  return {
    ...process.env,
    VDESK_NO_KEEPALIVE: "1",
    VDESK_NO_LIFECYCLE: "1",
    VDESK_HELPER_PORT: String(opts.port),
    VDESK_HELPER: "http://127.0.0.1:" + opts.port,
    VDESK_MONITOR_PORT: "18999",
    VDESK_MONITOR: "http://127.0.0.1:18999",
    VDESK_TOKEN_FILE: TOKEN_FILE,
    VDESK_CERT_PIN: opts.pinFile,
    VDESK_TASKS: path.join(BASE, "tasks"),
    VDESK_SHOTS: path.join(BASE, "shots"),
    VDESK_DESIRED_RES: path.join(BASE, "desired.json"),
    VDESK_PLUGIN_LOG: PLUGIN_LOG,
    ...(opts.httpOnly ? { VDESK_HTTP_ONLY: "1" } : {}),
    ...(opts.debug ? { VDESK_DEBUG: "1" } : {}),
  };
}
// P4 copy note (tools-dev): piped stdio is refused by the DSH file sandbox (spawn EPERM), so the
// child's stdout/stderr are handed over as real files. Command/env/assertions are unchanged.
let nodeSeq = 0;
function runNode(script, args, env) {
  return new Promise((resolve) => {
    const outFile = path.join(CLI_SCRATCH, "n" + nodeSeq + ".out");
    const errFile = path.join(CLI_SCRATCH, "n" + nodeSeq + ".err");
    nodeSeq++;
    const o = fs.openSync(outFile, "w");
    const e = fs.openSync(errFile, "w");
    const done = (v) => {
      try { fs.closeSync(o); } catch {}
      try { fs.closeSync(e); } catch {}
      resolve(v);
    };
    const p = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", o, e] });
    p.on("error", (err) => done({ json: null, out: "", err: String((err && err.message) || err) }));
    p.on("close", () => {
      const out = fs.readFileSync(outFile, "utf8");
      const err = fs.readFileSync(errFile, "utf8");
      let j = null;
      try { j = JSON.parse(out); } catch {}
      done({ json: j, out, err });
    });
  });
}
const runPlugin = (which, opts) => runNode(RUNNER, [which], envFor(opts));
const runCli = (args, opts) => runNode(CLI, args, envFor(opts));

/* ============ C1: pinned HTTPS works end to end ============ */
{
  const n = seen.https.length;
  const r = await runPlugin("apps-list", { port: HTTPS_PORT, pinFile: PIN });
  const calls = seen.https.slice(n);
  check(r.json && r.json.ok === true && r.json.count === 3, "plugin apps list over pinned HTTPS", r.json);
  check(calls.some((c) => c.path === "/apps?action=list" && c.token === GOOD), "plugin sent the request + token over HTTPS", calls);
  check(calls.every((c) => c.path === "/health" || c.path.startsWith("/apps")), "only the transport probe + the call went out", calls);
  check(seen.http.length === 0, "nothing leaked to plain HTTP", seen.http.length);
}
{
  const n = seen.https.length;
  const r = await runCli(["apps", "list"], { port: HTTPS_PORT, pinFile: PIN });
  const calls = seen.https.slice(n);
  check(r.json && r.json.ok === true && r.json.count === 3, "CLI apps list over pinned HTTPS", r.json);
  check(calls.some((c) => c.path === "/apps?action=list" && c.token === GOOD), "CLI sent the token over HTTPS", calls);
  check(r.err.trim() === "", "healthy https call: CLI stderr is SILENT (no probe noise)", r.err.trim());
  check(r.out.trim().startsWith("{"), "stdout stays pure JSON", r.out.slice(0, 40));
  const d = await runCli(["apps", "list"], { port: HTTPS_PORT, pinFile: PIN, debug: true });
  check(/pinned https/.test(d.err), "VDESK_DEBUG=1 restores the transport note", d.err.trim());
}
{
  // the health probe must ride the same transport (task requirement)
  const n = seen.https.length;
  const r = await runPlugin("status-health", { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.ok === true, "vdesk_status works over pinned HTTPS", r.json && r.json.ok);
  check(seen.https.slice(n).some((c) => c.path === "/health"), "status health probe used HTTPS", seen.https.slice(n));
}

/* ============ C2: wrong pin -> refused, helper never reached ============ */
{
  const n = seen.https.length;
  const logBefore = fs.existsSync(PLUGIN_LOG) ? fs.readFileSync(PLUGIN_LOG, "utf8").length : 0;
  const r = await runPlugin("apps-list", { port: HTTPS_PORT, pinFile: BAD_PIN_FILE });
  check(!r.json || r.json.ok === false, "wrong pin -> the tool fails instead of trusting it", r.json);
  check(seen.https.length === n, "wrong pin: no request ever reached the helper", seen.https.length - n);
  const logTail = fs.existsSync(PLUGIN_LOG) ? fs.readFileSync(PLUGIN_LOG, "utf8").slice(logBefore) : "";
  check(/pin mismatch/i.test(logTail), "wrong pin: plugin log names the mismatch", logTail.trim().split("\n").pop());
}
{
  const n = seen.https.length;
  const r = await runCli(["apps", "list"], { port: HTTPS_PORT, pinFile: BAD_PIN_FILE });
  check(!r.json || r.json.ok === false, "CLI wrong pin -> failure", r.json);
  check(/pin mismatch/i.test(r.err), "CLI wrong pin -> LOUD on stderr even without VDESK_DEBUG", r.err.trim().split("\n")[0]);
  check(!/-> plain http/.test(r.err), "pin mismatch never downgrades to plain http", r.err.trim());
  check(seen.https.length === n, "CLI wrong pin: helper never reached", seen.https.length - n);
}

/* ============ C3/C4/C5: the three http fallbacks ============ */
{
  const n = seen.http.length;
  const r = await runPlugin("apps-list", { port: HTTP_PORT, pinFile: NO_PIN_FILE });
  check(r.json && r.json.ok === true, "no pin file -> http fallback works", r.json && r.json.ok);
  check(seen.http.slice(n).some((c) => c.path === "/apps?action=list"), "fallback used plain HTTP", seen.http.slice(n));
}
{
  const n = seen.http.length;
  const r = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: NO_PIN_FILE });
  check(r.json && r.json.ok === true, "CLI no pin file -> http fallback works", r.json && r.json.ok);
  check(r.err.trim() === "", "no pin file: CLI is silent by default", r.err.trim());
  const d = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: NO_PIN_FILE, debug: true });
  check(/no helper-cert\.sha256/.test(d.err), "VDESK_DEBUG=1 names the missing pin file", d.err.trim());
  check(seen.http.slice(n).some((c) => c.path === "/apps?action=list"), "CLI fallback used plain HTTP", true);
}
{
  const r = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: PIN, httpOnly: true });
  check(r.json && r.json.ok === true, "VDESK_HTTP_ONLY=1 -> http", r.json && r.json.ok);
  check(r.err.trim() === "", "VDESK_HTTP_ONLY=1: CLI is silent by default", r.err.trim());
  const d = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: PIN, httpOnly: true, debug: true });
  check(/VDESK_HTTP_ONLY=1/.test(d.err), "VDESK_DEBUG=1 says why (VDESK_HTTP_ONLY=1)", d.err.trim());
}
{
  // the real machine before the netsh binding: pin exists, helper itself on http
  const n = seen.http.length;
  const r = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: PIN });
  check(r.json && r.json.ok === true, "pin present but helper on http -> fallback works", r.json && r.json.ok);
  check(r.err.trim() === "", "https probe failure: CLI is silent by default (the reported noise)", r.err.trim());
  const d = await runCli(["apps", "list"], { port: HTTP_PORT, pinFile: PIN, debug: true });
  check(/https probe failed/.test(d.err), "VDESK_DEBUG=1 explains the failed https probe", d.err.trim().split("\n")[0]);
  check(seen.http.slice(n).some((c) => c.path === "/apps?action=list"), "fallback request went out over http", true);
}

/* ============ B: vdesk_apps semantics ============ */
{
  const r = await runPlugin("apps-limit", { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.ok === true && r.json.count === 3 && r.json.apps.length === 2, "limit trims the array but keeps count", r.json);
}
{
  const r = await runPlugin("apps-launch-notepad", { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.ok === true && r.json.matched === "记事本" && r.json.pid === 4242 && r.json.source === "appx", "launch 记事本 returns the helper JSON verbatim", r.json);
}
{
  const n = seen.https.length;
  const r = await runPlugin("apps-launch-doubao", { port: HTTPS_PORT, pinFile: PIN });
  const calls = seen.https.slice(n).filter((c) => c.path.startsWith("/apps"));
  check(r.json && r.json.ok === false && r.json.error === "blocked-by-policy", "launch doubao -> blocked-by-policy passed through", r.json);
  check(calls.length === 1, "blocked-by-policy is not retried by the host", calls);
  check(JSON.stringify(r.json) === JSON.stringify({ ok: false, error: "blocked-by-policy" }), "policy response byte-identical to the helper's", r.json);
}
{
  const r = await runPlugin("apps-launch-zzz", { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.ok === false && r.json.error === "no-match" && Array.isArray(r.json.candidates), "no-match + candidates passed through", r.json);
}
{
  const r = await runCli(["apps", "launch", "记事本"], { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.ok === true && r.json.pid === 4242, "CLI apps launch 记事本", r.json);
}
{
  const r = await runCli(["apps", "launch", "doubao"], { port: HTTPS_PORT, pinFile: PIN });
  check(r.json && r.json.error === "blocked-by-policy", "CLI apps launch doubao stays blocked", r.json);
}

/* ============ monitor transport ============ */
function waitUp(port) {
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.request({ host: "127.0.0.1", port, path: "/vdesk/status", method: "GET" }, (res) => { res.resume(); resolve(true); });
      req.on("error", () => setTimeout(tryOnce, 150));
      req.end();
    };
    tryOnce();
  });
}
function meta(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/meta", method: "GET" }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
{
  const n = seen.https.length;
  const mon = spawn(process.execPath, [MONITOR_JS], {
    env: { ...envFor({ port: HTTPS_PORT, pinFile: PIN }), DSH_VDESK_MONITOR_PORT: String(MON_HTTPS) },
    stdio: "ignore",
  });
  try {
    await waitUp(MON_HTTPS);
    const r = await meta(MON_HTTPS);
    check(r.status === 200 && /"tls":true/.test(r.body), "monitor /meta over pinned HTTPS", r.body.slice(0, 80));
    check(seen.https.slice(n).some((c) => c.path === "/health"), "monitor health probe used HTTPS", seen.https.slice(n));
  } finally { mon.kill(); }
}
{
  const n = seen.http.length;
  const mon = spawn(process.execPath, [MONITOR_JS], {
    env: { ...envFor({ port: HTTP_PORT, pinFile: PIN, httpOnly: true }), DSH_VDESK_MONITOR_PORT: String(MON_HTTP) },
    stdio: "ignore",
  });
  try {
    await waitUp(MON_HTTP);
    const r = await meta(MON_HTTP);
    check(r.status === 200, "monitor /meta with VDESK_HTTP_ONLY=1", r.status);
    check(seen.http.slice(n).some((c) => c.path === "/health"), "monitor fell back to plain HTTP", seen.http.slice(n));
  } finally { mon.kill(); }
}

await new Promise((r) => httpsHelper.close(r));
await new Promise((r) => httpHelper.close(r));
fs.rmSync(BASE, { recursive: true, force: true });
fs.rmSync(CLI_SCRATCH, { recursive: true, force: true });

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
