// P3-C self-check: the monitor's conflict probe/route/status + the plugin's refuse-or-force path.
// Lives in %TEMP%; the mock vdesk.ps1 records how it was invoked, so FORCE pass-through is provable.
// It never starts a real session: the monitor is pointed at the mock via VDESK_PS1.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");
const RUNNER = path.join(os.tmpdir(), "dsh-childsession", "p3c-run.mjs");
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out", "p3c-mon");
const TASKS = path.join(BASE, "tasks");
const MOCK_PS1 = path.join(BASE, "mock-vdesk.ps1");
const ARGS_LOG = path.join(BASE, "mock-args.txt");
const KEEPER_JSON = path.join(BASE, "keeper.json");
const CONFLICT_JSON = path.join(BASE, "conflict.json");
const MONI = 18950;
const PROBE_FOUND = [{ name: "DesktopMgr64.exe", pid: 4242, session: 1 }];

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(TASKS, { recursive: true });
// ASCII-only mock: logs "<action>|<args>" and answers the probe
fs.writeFileSync(
  MOCK_PS1,
  "param([string]$Action = 'status')\n" +
    "Add-Content -LiteralPath '" + ARGS_LOG + "' -Value ($Action + '|' + ($args -join ','))\n" +
    "if ($Action -eq 'probe') {\n" +
    "  Write-Output '{\"found\":[{\"name\":\"DesktopMgr64.exe\",\"pid\":4242,\"session\":1}],\"watchlist\":[\"DesktopMgr64\"],\"ok\":true,\"forced\":false,\"refused\":false,\"checkedAt\":\"2026-10-02T12:00:00\"}'\n" +
    "}\n"
);

const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLines = () => (fs.existsSync(ARGS_LOG) ? fs.readFileSync(ARGS_LOG, "utf8").split("\n").filter(Boolean) : []);
// vdeskRun spawns fire-and-forget, so the mock's log line lands a moment later: wait for it.
async function waitForLine(pred, from, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = mockLines().slice(from).find(pred);
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}

function req(method, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: MONI, path: pathname, method }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(c).toString("utf8")); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    r.end();
  });
}
function runPlugin(mode) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, mode], {
      env: {
        ...process.env,
        VDESK_NO_KEEPALIVE: "1",
        VDESK_NO_LIFECYCLE: "1",
        VDESK_MONITOR_PORT: String(MONI),
        VDESK_TASKS: TASKS,
        VDESK_SHOTS: path.join(BASE, "shots"),
        VDESK_DESIRED_RES: path.join(BASE, "desired.json"),
      },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      resolve(j);
    });
  });
}

const mon = spawn(process.execPath, [MONITOR_JS], {
  env: { ...process.env, DSH_VDESK_MONITOR_PORT: String(MONI), VDESK_PS1: MOCK_PS1, VDESK_KEEPER_JSON: KEEPER_JSON, VDESK_TASKS: TASKS, VDESK_HELPER_PORT: "18951" },
  stdio: "ignore",
});
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(150);
    try { await req("GET", "/vdesk/status"); up = true; } catch {}
  }
  check(up, "monitor is up on " + MONI);

  // ---- the probe route is read-only and reports the mock's hit ----
  const before = mockLines().length;
  const probe = await req("GET", "/vdesk/conflict");
  check(probe.status === 200 && probe.json && probe.json.ok === true, "GET /vdesk/conflict answers", probe.json);
  check(JSON.stringify(probe.json.found) === JSON.stringify(PROBE_FOUND), "conflict probe returns the found list verbatim", probe.json && probe.json.found);
  check(mockLines().slice(before).every((l) => l.startsWith("probe|")), "only `probe` was invoked (no start/stop)", mockLines().slice(before));

  // ---- status exposes conflict:{checkedAt,found,forced} ----
  let st = await req("GET", "/vdesk/status");
  check(st.json && st.json.conflict && Array.isArray(st.json.conflict.found) && st.json.conflict.found.length === 1, "status carries conflict.found", st.json && st.json.conflict);
  check(st.json.conflict.checkedAt && st.json.conflict.forced === false, "status conflict has checkedAt + forced=false", st.json && st.json.conflict);
  const probeCountBefore = mockLines().filter((l) => l.startsWith("probe|")).length;
  for (let i = 0; i < 5; i++) await req("GET", "/vdesk/status");
  const probeCountAfter = mockLines().filter((l) => l.startsWith("probe|")).length;
  check(probeCountAfter === probeCountBefore, "polling status does not re-probe every time (cache works)", [probeCountBefore, probeCountAfter]);

  // ---- P4.1 contract: a plain start is REFUSED while a conflict exists (and spawns nothing);
  //      only force=1 may spawn, and then it must pass -Force. ----
  const n1 = mockLines().length;
  const r1 = await req("POST", "/vdesk/start");
  const line1 = await waitForLine((l) => l.startsWith("start|"), n1, 1500);
  check(
    r1.status === 409 && r1.json && r1.json.ok === false && r1.json.error === "singleton-conflict",
    "POST /vdesk/start is refused (409 singleton-conflict), not silently 'accepted'",
    r1.json
  );
  check(r1.json && Array.isArray(r1.json.found) && r1.json.found.length === 1, "the refusal names the offending processes", r1.json && r1.json.found);
  check(!line1, "a refused start spawns NOTHING (no start| line in the mock log)", line1);
  const n2 = mockLines().length;
  const r2 = await req("POST", "/vdesk/start?force=1");
  const line2 = await waitForLine((l) => l.startsWith("start|"), n2);
  check(r2.status === 200 && r2.json && r2.json.force === true, "POST /vdesk/start?force=1 reports force=true", r2.json);
  check(!!line2 && line2.includes("-Force"), "force=1 passes -Force to vdesk.ps1", line2);

  // ---- forced flag comes from the record file ----
  fs.writeFileSync(CONFLICT_JSON, JSON.stringify({ checkedAt: "2026-10-02T12:00:00", found: PROBE_FOUND, forced: true, refused: false }));
  st = await req("GET", "/vdesk/status");
  check(st.json.conflict.forced === true, "status reflects a forced start from the record file", st.json.conflict);

  // ---- plugin: refuse without force (and never spawn a start) ----
  const n3 = mockLines().length;
  const refused = await runPlugin("refuse");
  check(refused && refused.result && refused.result.ok === false && refused.result.error === "singleton-conflict", "plugin refuses without force", refused && refused.result);
  check(refused.result.found.length === 1 && refused.result.found[0].pid === 4242, "refusal carries the found programs", refused.result.found);
  check(typeof refused.result.advice === "string" && refused.result.advice.length > 10, "refusal carries advice", refused.result.advice);
  await sleep(2500); // give any (unwanted) spawn time to show up in the mock log
  check(mockLines().slice(n3).every((l) => l.startsWith("probe|")), "refusal never spawned a start", mockLines().slice(n3));

  // ---- plugin: force passes through + marks the result ----
  const n4 = mockLines().length;
  const forced = await runPlugin("force");
  const line4 = await waitForLine((l) => l.startsWith("start|"), n4);
  check(forced && forced.result && forced.result.ok === true, "plugin force start returns the monitor result", forced && forced.result);
  check(forced.result.forced === true && forced.result.conflict && forced.result.conflict.found.length === 1, "forced start is marked in the result", forced.result);
  check(!!line4 && line4.includes("-Force"), "plugin force start passed -Force", line4);

  // ---- plugin: forced start is recorded in the task journal ----
  const j = await runPlugin("force-with-task");
  const note = j && j.journal ? j.journal.find((l) => l.type === "note" && l.kind === "forced-start") : null;
  check(!!note && Array.isArray(note.found) && note.found.length === 1, "forced start writes a journal note", note);
} finally {
  mon.kill();
}
fs.rmSync(BASE, { recursive: true, force: true });

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
