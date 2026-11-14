// P2-A self-check: vdesk_resolution (writes the target + triggers restart), the CLI resolution
// command, and /vdesk/status resolution precedence (helper > keeper > desired > default).
// Lives in %TEMP%; starts no session and opens no window.
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
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out", "p2a-node");
const DESIRED = path.join(BASE, "desired-resolution.json");
const CLI_DESIRED = path.join(BASE, "desired-cli.json");
const MON_BASE = path.join(BASE, "mon");
const KEEPER_JSON = path.join(MON_BASE, "keeper.json");
const DESIRED_MON = path.join(MON_BASE, "desired-resolution.json");
const HELP = 18901;
const MON = 18900;
const MONI = 18910;

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(MON_BASE, { recursive: true });

const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function json(res, obj, code = 200) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// mock monitor for the plugin / CLI restart calls
const monCalls = [];
const control = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  monCalls.push(req.method + " " + u.pathname);
  if (u.pathname === "/vdesk/status") return json(res, { ok: true, keeper: { phase: "stopped" }, resolution: { width: 1280, height: 800 } });
  return json(res, { ok: true, action: u.pathname.split("/").pop(), note: "mock" });
});
// mock helper: reports a desktop size for the monitor's /health probe
let helperDims = { ok: true, width: 1920, height: 1080 };
const helper = http.createServer((req, res) => {
  if (new URL(req.url, "http://x").pathname === "/health") return json(res, helperDims);
  return json(res, { ok: true });
});
await new Promise((r) => control.listen(MON, "127.0.0.1", r));
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));

/* ---------------- plugin tool ---------------- */
process.env.VDESK_NO_KEEPALIVE = "1";
process.env.VDESK_NO_LIFECYCLE = "1";
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_TASKS = path.join(BASE, "tasks");
process.env.VDESK_SHOTS = path.join(BASE, "shots");
process.env.VDESK_DESIRED_RES = DESIRED;
const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));
const call = (name, args) => byName[name].execute({ ...args }, { signal: undefined });

check(regs.length === 18, "plugin registers 18 tools", regs.map((d) => d.name));
check(regs.map((d) => d.name).join(",").endsWith("vdesk_resolution,vdesk_clipboard"), "resolution+clipboard are the newest tools", regs.map((d) => d.name).slice(-2));
check(JSON.stringify(byName.vdesk_resolution.parameters.required) === JSON.stringify(["width", "height"]), "vdesk_resolution requires width+height");
check(byName.vdesk_resolution.parameters.properties.width.type === "integer" && byName.vdesk_resolution.parameters.properties.height.type === "integer", "resolution params are integers");
check((byName.vdesk_resolution.description || "").includes("1920"), "description warns about the high-res cost");

{
  const before = monCalls.filter((c) => c === "POST /vdesk/restart").length;
  const r = await call("vdesk_resolution", { width: 1920, height: 1080 });
  check(r.ok === true && r.restarted === true && r.width === 1920 && r.height === 1080, "vdesk_resolution returns ok/restarted", r);
  check(monCalls.filter((c) => c === "POST /vdesk/restart").length === before + 1, "vdesk_resolution triggers POST /vdesk/restart", monCalls);
  const j = JSON.parse(fs.readFileSync(DESIRED, "utf8"));
  check(j.width === 1920 && j.height === 1080, "desired-resolution.json written", j);
  check(typeof j.ts === "string", "desired file carries a timestamp", j.ts);
}
{
  const before = monCalls.filter((c) => c === "POST /vdesk/restart").length;
  const r = await call("vdesk_resolution", { width: 100, height: 50 });
  check(r.ok === false && /out of range/.test(String(r.error)), "out-of-range resolution rejected", r);
  check(monCalls.filter((c) => c === "POST /vdesk/restart").length === before, "rejected resolution does not restart", monCalls);
  const j = JSON.parse(fs.readFileSync(DESIRED, "utf8"));
  check(j.width === 1920, "rejected resolution leaves the previous target intact", j);
}

/* ---------------- CLI ---------------- */
// P4 copy note (tools-dev): piped stdio is refused by the DSH file sandbox (spawn EPERM), so the
// child's stdout goes to a real file instead of a pipe. Command/env/assertions are unchanged.
const CLI_SCRATCH = path.join(ROOT, "selftests", ".scratch", "p2a-cli");
fs.mkdirSync(CLI_SCRATCH, { recursive: true });
let cliSeq = 0;
function runCli(args) {
  return new Promise((resolve) => {
    const outFile = path.join(CLI_SCRATCH, "c" + cliSeq + ".out");
    cliSeq++;
    const o = fs.openSync(outFile, "w");
    const done = (v) => {
      try { fs.closeSync(o); } catch {}
      resolve(v);
    };
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, VDESK_MONITOR: "http://127.0.0.1:" + MON, VDESK_DESIRED_RES: CLI_DESIRED },
      stdio: ["ignore", o, "ignore"],
    });
    p.on("error", () => done(null));
    p.on("close", () => {
      const out = fs.readFileSync(outFile, "utf8");
      let j = null;
      try { j = JSON.parse(out); } catch {}
      done(j);
    });
  });
}
{
  const before = monCalls.filter((c) => c === "POST /vdesk/restart").length;
  const j = await runCli(["resolution", "1920", "1080"]);
  check(j && j.ok === true && j.restarted === true && j.width === 1920 && j.height === 1080, "CLI resolution returns ok/restarted", j);
  check(monCalls.filter((c) => c === "POST /vdesk/restart").length === before + 1, "CLI resolution POSTs /vdesk/restart", monCalls);
  const f = JSON.parse(fs.readFileSync(CLI_DESIRED, "utf8"));
  check(f.width === 1920 && f.height === 1080, "CLI writes the desired file", f);
}
{
  const before = monCalls.filter((c) => c === "POST /vdesk/restart").length;
  const j = await runCli(["resolution", "99999", "10"]);
  check(j && j.ok === false && /usage/.test(String(j.error)), "CLI rejects an absurd size", j);
  check(monCalls.filter((c) => c === "POST /vdesk/restart").length === before, "CLI rejection does not restart", monCalls);
}

/* ---------------- monitor /vdesk/status resolution ---------------- */
const mi = spawn(process.execPath, [MONITOR_JS], {
  env: { ...process.env, DSH_VDESK_MONITOR_PORT: String(MONI), VDESK_HELPER_PORT: String(HELP), VDESK_KEEPER_JSON: KEEPER_JSON, VDESK_TASKS: MON_BASE },
  stdio: "ignore",
});
function monStatus() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: MONI, path: "/vdesk/status", method: "GET" }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}
async function statusUntil(pred, ms = 6000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { last = await monStatus(); if (pred(last)) return last; } catch {}
    await sleep(250);
  }
  return last;
}
try {
  let st = await statusUntil((s) => s && s.resolution && s.resolution.source === "helper");
  check(!!st && st.resolution.width === 1920 && st.resolution.height === 1080, "status resolution from the helper (real desktop)", st && st.resolution);

  // keeper only (helper stops reporting a size)
  helperDims = { ok: true };
  fs.writeFileSync(KEEPER_JSON, JSON.stringify({ ok: true, phase: "holding", width: 1600, height: 900, candidates: "7:s0" }));
  st = await statusUntil((s) => s && s.resolution && s.resolution.source === "keeper");
  check(!!st && st.resolution.width === 1600 && st.resolution.height === 900, "status resolution from the keeper", st && st.resolution);

  // desired only (no helper, no keeper)
  await new Promise((r) => helper.close(r));
  fs.rmSync(KEEPER_JSON, { force: true });
  fs.writeFileSync(DESIRED_MON, JSON.stringify({ width: 1920, height: 1080, ts: "2026-10-02T11:00:00.000Z" }));
  st = await statusUntil((s) => s && s.resolution && s.resolution.source === "desired");
  check(!!st && st.resolution.width === 1920 && st.resolution.height === 1080, "status resolution from desired-resolution.json", st && st.resolution);

  // nothing at all
  fs.rmSync(DESIRED_MON, { force: true });
  st = await statusUntil((s) => s && s.resolution && s.resolution.source === "default");
  check(!!st && st.resolution.width === 1280 && st.resolution.height === 800, "status resolution falls back to 1280x800", st && st.resolution);

  // P0.9 fields must still be there
  check(!!st && "window" in st && "windowIdleSec" in st && "windowIdleMin" in st, "status keeps the window fields", st && Object.keys(st).filter((k) => k.startsWith("window")));
} finally {
  mi.kill();
}

await new Promise((r) => control.close(r));
fs.rmSync(BASE, { recursive: true, force: true });
fs.rmSync(CLI_SCRATCH, { recursive: true, force: true });

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
