// P1 offline self-check: task runner (vdesk_task / vdesk_task_end / vdesk_keepalive), the task
// journal, the monitor's GET /vdesk/task endpoint, auto-destroy and idle reclaim.
// Lives in %TEMP% on purpose. No virtual desktop is started; the monitor is spawned on a test port.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const INDEX = path.join(ROOT, "plugin", "dsh-vdesk", "index.js");
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out");
const SHOTS = path.join(BASE, "shots-selftest-p1");
const TASKS = path.join(BASE, "tasks-selftest");

const HELP = 18796;
const MON = 18797;
const MON2 = 18798;

fs.rmSync(TASKS, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });

process.env.VDESK_NO_KEEPALIVE = "1"; // keep the real panel/service out of this run
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_SHOTS = SHOTS;
process.env.VDESK_TASKS = TASKS;
process.env.VDESK_IDLE_CHECK_MS = "40";

const calls = { helper: [], monitor: [] };
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
  calls.helper.push(u.pathname + u.search);
  if (u.pathname === "/health") return json(res, { ok: true, width: 1600, height: 900 });
  if (u.pathname === "/screenshot") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png());
  }
  if (u.pathname === "/clipboard") return json(res, { ok: true, chars: 3 });
  return json(res, { ok: true, path: u.pathname, query: Object.fromEntries(u.searchParams) });
});
const monitor = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.monitor.push(req.method + " " + u.pathname + u.search);
  if (u.pathname === "/vdesk/status") {
    return json(res, {
      ok: true,
      keeper: { phase: "holding", candidates: "7:abc", uptimeSec: 42 },
      helper: { ok: true, width: 1600, height: 900 },
      window: false,
    });
  }
  return json(res, { ok: true, action: u.pathname.split("/").pop(), note: "mock" });
});
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));
await new Promise((r) => monitor.listen(MON, "127.0.0.1", r));

const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));
const call = (name, args) => byName[name].execute({ ...args }, { signal: undefined });

/* ---------------- tool inventory ---------------- */
const LEGACY = [
  "vdesk_status", "vdesk_start", "vdesk_stop", "vdesk_restart", "vdesk_screenshot", "vdesk_click",
  "vdesk_move", "vdesk_drag", "vdesk_scroll", "vdesk_key", "vdesk_type", "vdesk_wait",
];
const EXPECTED = LEGACY.concat(["vdesk_task", "vdesk_task_end", "vdesk_keepalive", "vdesk_apps", "vdesk_resolution", "vdesk_clipboard"]);
check(regs.map((d) => d.name).join(",") === EXPECTED.join(","), "17 tools: legacy 12 + task/task_end/keepalive + resolution + clipboard", regs.map((d) => d.name));
check(JSON.stringify(Object.keys(byName.vdesk_type.parameters.properties)) === JSON.stringify(["text", "via", "after"]), "vdesk_type shape untouched");
check(JSON.stringify(byName.vdesk_task.parameters.required) === JSON.stringify(["goal"]), "vdesk_task requires goal");
check(JSON.stringify(Object.keys(byName.vdesk_task.parameters.properties)) === JSON.stringify(["goal", "steps"]), "vdesk_task params");
check(JSON.stringify(byName.vdesk_task_end.parameters.required) === undefined || byName.vdesk_task_end.parameters.required === undefined, "vdesk_task_end has no required params");
check(JSON.stringify(byName.vdesk_keepalive.parameters.required) === JSON.stringify(["on"]), "vdesk_keepalive requires on");
check(byName.vdesk_task.parameters.properties.steps.type === "array" && byName.vdesk_task.parameters.properties.steps.items.type === "string", "steps is string[]");

function readJournal(taskId) {
  const lines = fs.readFileSync(path.join(TASKS, taskId + ".jsonl"), "utf8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

/* ---------------- task start + step journal ---------------- */
const t1 = await call("vdesk_task", { goal: "打开记事本并输入中文", steps: ["开记事本", "输入中文", "截图"] });
check(t1.ok === true && typeof t1.taskId === "string" && /^t-\d{8}-\d{6}-/.test(t1.taskId), "vdesk_task returns taskId", t1);
check(typeof t1.startedAt === "string" && !Number.isNaN(Date.parse(t1.startedAt)), "vdesk_task returns startedAt", t1.startedAt);
check(t1.journal === path.join(TASKS, t1.taskId + ".jsonl"), "journal path under VDESK_TASKS", t1.journal);
let j = readJournal(t1.taskId);
check(j.length === 1 && j[0].type === "task" && j[0].goal === "打开记事本并输入中文", "journal line 1 = task header", j);
check(JSON.stringify(j[0].planned) === JSON.stringify(["开记事本", "输入中文", "截图"]), "planned steps stored", j[0].planned);

// no task -> no journal write, but the wrapper must not change the result
await call("vdesk_click", { x: 0.5, y: 0.5, after: false });
await call("vdesk_key", { combo: "ctrl+s", after: false });
const bad = await call("vdesk_key", { combo: "ctrl+nope", after: false });
check(bad.ok === false, "failing action still returns ok:false", bad);
const shot = await call("vdesk_screenshot", {});
check(shot.ok === true && fs.existsSync(shot.path), "screenshot still writes a file", shot.path);

j = readJournal(t1.taskId);
check(j.length === 5, "journal = task + 4 steps", j.map((l) => l.type + ":" + (l.n || "")));
const s1 = j[1];
check(s1.type === "step" && s1.n === 1 && s1.tool === "vdesk_click" && s1.ok === true, "step 1 shape", s1);
check(typeof s1.ms === "number" && s1.ms >= 0 && typeof s1.ts === "string" && !Number.isNaN(Date.parse(s1.ts)), "step has ms + iso ts", s1);
check(JSON.stringify(s1.args) === JSON.stringify({ x: 0.5, y: 0.5, after: false }), "step args recorded", s1.args);
check(s1.screenshot === undefined, "after:false leaves no screenshot path", s1.screenshot);
check(!("screenshot" in s1), "no undefined screenshot key", Object.keys(s1));
const s3 = j[3];
check(s3.n === 3 && s3.ok === false && typeof s3.error === "string" && /unknown key/.test(s3.error), "failed step records error", s3);
const s4 = j[4];
check(s4.tool === "vdesk_screenshot" && typeof s4.screenshot === "string" && s4.screenshot === shot.path, "vdesk_screenshot step carries its path", s4);
check(s1.n < s4.n, "step numbers increase", j.map((l) => l.n));
// meta tools must not be journalled as steps
await call("vdesk_status", {});
check(readJournal(t1.taskId).length === 5, "vdesk_status is not a step", readJournal(t1.taskId).length);

/* ---------------- task end: summary + auto-destroy ---------------- */
const beforeStop = calls.monitor.filter((c) => c === "POST /vdesk/stop").length;
const e1 = await call("vdesk_task_end", { ok: true, note: "selftest" });
check(e1.ok === true && e1.destroyed === true, "vdesk_task_end destroys by default", e1);
check(calls.monitor.filter((c) => c === "POST /vdesk/stop").length === beforeStop + 1, "task end POSTs /vdesk/stop", calls.monitor);
check(e1.total === 4 && e1.failed === 1, "summary counts steps/failures", e1);
j = readJournal(t1.taskId);
const sum = j[j.length - 1];
check(sum.type === "summary" && sum.ok === true && sum.total === 4 && sum.failed === 1, "summary line writes ok/total/failed", sum);
check(typeof sum.durationMs === "number" && sum.durationMs >= 0 && typeof sum.endedAt === "string", "summary has durationMs/endedAt", sum);
check(sum.note === "selftest", "summary keeps note", sum.note);
check(j.filter((l) => l.type === "summary").length === 1, "exactly one summary", j.filter((l) => l.type === "summary").length);
const eDefault = await call("vdesk_task", { goal: "g2" });
await call("vdesk_wait", { ms: 1, after: false });
const eAuto = await call("vdesk_task_end", {});
check(eAuto.ok === true && eAuto.failed === 0, "default verdict = no failed step", eAuto);
const e2none = await call("vdesk_task_end", {});
check(e2none.ok === false && /no active task/.test(e2none.error), "task_end without a task -> ok:false", e2none);

/* ---------------- taskId guard + supersede ---------------- */
const a = await call("vdesk_task", { goal: "task A" });
const mismatch = await call("vdesk_task_end", { taskId: "t-bogus" });
check(mismatch.ok === false && mismatch.activeTaskId === a.taskId, "taskId mismatch rejected", mismatch);
const b = await call("vdesk_task", { goal: "task B" });
check(b.taskId !== a.taskId, "new task has a new id", [a.taskId, b.taskId]);
await call("vdesk_wait", { ms: 1, after: false }); // give task B one journalled step
const ja = readJournal(a.taskId);
check(ja[ja.length - 1].type === "summary" && ja[ja.length - 1].ok === false && /superseded/.test(ja[ja.length - 1].note || ""), "superseded task closed as failed", ja[ja.length - 1]);
check(readJournal(b.taskId)[0].goal === "task B", "new task journal opened", readJournal(b.taskId)[0]);

/* ---------------- keepalive suppresses auto-destroy ---------------- */
const ka = await call("vdesk_keepalive", { on: true });
check(ka.ok === true && ka.keepalive === true, "keepalive on", ka);
const beforeKeep = calls.monitor.filter((c) => c === "POST /vdesk/stop").length;
const eKeep = await call("vdesk_task_end", {});
check(eKeep.ok === true && eKeep.destroyed === false && eKeep.keepalive === true, "keepalive suppresses task-end destroy", eKeep);
check(calls.monitor.filter((c) => c === "POST /vdesk/stop").length === beforeKeep, "no stop POST while keepalive on", calls.monitor);

/* ---------------- idle reclaim (and its keepalive suppression) ---------------- */
process.env.VDESK_IDLE_MS = "120";
await call("vdesk_wait", { ms: 1, after: false }); // moves the idle clock, no task open
const beforeIdle = calls.monitor.filter((c) => c === "POST /vdesk/stop").length;
await new Promise((r) => setTimeout(r, 500));
check(calls.monitor.filter((c) => c === "POST /vdesk/stop").length === beforeIdle, "keepalive suppresses idle reclaim", calls.monitor.filter((c) => c.indexOf("stop") >= 0));
const off = await call("vdesk_keepalive", { on: false });
check(off.keepalive === false, "keepalive off", off);
await call("vdesk_wait", { ms: 1, after: false });
await new Promise((r) => setTimeout(r, 600));
const idleStops = calls.monitor.filter((c) => c === "POST /vdesk/stop").length;
check(idleStops > beforeIdle, "idle reclaim POSTs /vdesk/stop after the threshold", calls.monitor.filter((c) => c.indexOf("stop") >= 0));
check(calls.monitor.filter((c) => c === "GET /vdesk/status").length > 0, "idle reclaim checks /vdesk/status first", true);

/* ---------------- monitor GET /vdesk/task ---------------- */
// "newest journal by mtime" is ambiguous when several are written in the same millisecond (that made
// this check flaky): pin task B to now and push every other journal 30s into the past.
const older = new Date(Date.now() - 30_000);
for (const f of fs.readdirSync(TASKS)) {
  if (f.endsWith(".jsonl") && f !== b.taskId + ".jsonl") fs.utimesSync(path.join(TASKS, f), older, older);
}
const newest = new Date();
fs.utimesSync(path.join(TASKS, b.taskId + ".jsonl"), newest, newest);

const m2 = spawn(process.execPath, [MONITOR_JS], {
  env: { ...process.env, DSH_VDESK_MONITOR_PORT: String(MON2), VDESK_TASKS: TASKS },
  stdio: "ignore",
});
try {
  let body = null;
  for (let i = 0; i < 40 && !body; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      body = await (await fetch("http://127.0.0.1:" + MON2 + "/vdesk/task", { cache: "no-store" })).json();
    } catch { /* not listening yet */ }
  }
  check(!!body && body.ok === true, "monitor /vdesk/task answers", body);
  check(!!body && body.task && body.task.taskId === b.taskId, "newest journal is the latest task", body && body.task && body.task.taskId);
  check(!!body && body.task.goal === "task B", "task goal served", body && body.task.goal);
  check(!!body && Array.isArray(body.task.steps) && body.task.steps.length === 1, "steps array served", body && body.task.steps);  check(!!body && body.task.active === false && !!body.task.summary, "summary marks task inactive", body && body.task.summary);
  check(!!body && JSON.stringify(body.task.planned) === "[]", "planned defaults to empty array", body && body.task.planned);

  // an unfinished (newer) journal must report active:true and task:null handling stays sane
  fs.writeFileSync(path.join(TASKS, "t-29990101-000000-zzzzzz.jsonl"),
    JSON.stringify({ type: "task", taskId: "t-29990101-000000-zzzzzz", goal: "running now", planned: ["x"], startedAt: "2026-10-02T00:00:00.000Z", ts: "2026-10-02T00:00:00.000Z" }) + "\n" +
    JSON.stringify({ type: "step", n: 1, tool: "vdesk_click", args: { x: 1 }, ok: true, ms: 5, ts: "2026-10-02T00:00:01.000Z" }) + "\n");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(TASKS, "t-29990101-000000-zzzzzz.jsonl"), future, future);
  const body2 = await (await fetch("http://127.0.0.1:" + MON2 + "/vdesk/task", { cache: "no-store" })).json();
  check(body2.ok === true && body2.task.taskId === "t-29990101-000000-zzzzzz" && body2.task.active === true && body2.task.summary === null, "unfinished newest journal -> active:true", body2.task);
  check(body2.task.steps.length === 1 && body2.task.steps[0].tool === "vdesk_click" && body2.task.steps[0].args.x === 1, "unfinished journal steps served", body2.task.steps);
  check(JSON.stringify(body2.task.planned) === JSON.stringify(["x"]), "planned from header", body2.task.planned);
} finally {
  m2.kill();
}

await new Promise((r) => helper.close(r));
await new Promise((r) => monitor.close(r));
try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
