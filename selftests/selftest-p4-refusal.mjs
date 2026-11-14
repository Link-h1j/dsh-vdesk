// selftest-p4-refusal.mjs — P4.1 regression for the user report "点不起开启" (2026-10-02 14:47).
//
// What went wrong: vdeskRun() is fire-and-forget (spawn + unref, returns at once), so the P3-C
// refusal ("singleton-conflict", vdesk.ps1 exit 4) came back to the UI as ok:true and the desktop
// simply never appeared — indistinguishable from a dead button. The monitor now probes first and
// answers 409 WITHOUT spawning; only force=1 may spawn.
//
// This suite starts the REAL generated monitor against a FAKE vdesk.ps1 and asserts:
//   1. POST /vdesk/start            -> 409 {ok:false, error:"singleton-conflict", found:[...], advice}
//   2. nothing was spawned          -> the fake script's marker file does not exist
//   3. POST /vdesk/start?force=1    -> 200 {ok:true} and the fake script DID run with -Force
//   4. GET  /vdesk/conflict         -> still the read-only probe
//   5. the browser half reports action outcomes (call() reads the body; .actmsg is rendered;
//      zh+en copies exist) — otherwise a refusal would stay invisible in the panel.
//
// No real session is touched: the monitor gets a scratch KEEPER_JSON / TASKS / LOG and a fake script.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MON = path.join(ROOT, "vdesk-monitor.mjs");
const CLIENT = path.join(ROOT, "plugin", "dsh-vdesk", "client.js");
const ZH = path.join(ROOT, "plugin", "dsh-vdesk", "locale", "zh.json");
const EN = path.join(ROOT, "plugin", "dsh-vdesk", "locale", "en.json");
const SCRATCH = path.join(ROOT, "selftests", ".scratch-refusal");
const PORT = 18792;

let ok = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) ok++;
  else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : "  " + detail}`);
}

const PS_FAKE = [
  "param([Parameter(Position=0)][string]$Action = 'status', [int]$Minutes = 30, [switch]$Force)",
  "$marker = Join-Path $PSScriptRoot 'marker.txt'",
  "if ($Action -eq 'probe') {",
  '  Write-Output \'{"ok":true,"checkedAt":"2026-10-02T00:00:00","found":[{"name":"DesktopMgr64.exe","pid":111,"session":1}],"watchlist":["DesktopMgr64"]}\'',
  "  exit 0",
  "}",
  "$line = $Action",
  "if ($Force) { $line = $line + ' -Force' }",
  "Add-Content -Path $marker -Value $line",
  "exit 0",
  "",
].join("\r\n");

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const fake = path.join(SCRATCH, "fake-vdesk.ps1");
const marker = path.join(SCRATCH, "marker.txt");
fs.writeFileSync(fake, PS_FAKE, "utf8");

function req(pathname, method = "GET") {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        let j = null;
        try {
          j = JSON.parse(t);
        } catch {
          j = null;
        }
        resolve({ status: res.statusCode, text: t, j });
      });
    });
    r.on("error", (e) => resolve({ status: 0, text: "", j: null, error: e.message }));
    r.setTimeout(20000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}

const logFd = fs.openSync(path.join(SCRATCH, "monitor.log"), "a");
const child = spawn(process.execPath, [MON], {
  env: {
    ...process.env,
    DSH_VDESK_MONITOR_PORT: String(PORT),
    VDESK_PS1: fake,
    VDESK_LOG: path.join(SCRATCH, "vdesk.log"),
    VDESK_KEEPER_JSON: path.join(SCRATCH, "keeper.json"),
    VDESK_TASKS: path.join(SCRATCH, "tasks"),
    VDESK_TOKEN_FILE: path.join(SCRATCH, "token"),
    VDESK_HTTP_ONLY: "1",
  },
  // file fds instead of pipes: pipes are blocked in the confined sandbox
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // wait for the monitor
  let up = false;
  for (let i = 0; i < 40; i++) {
    const s = await req("/vdesk/status");
    if (s.status === 200 && s.j) {
      up = true;
      break;
    }
    await sleep(250);
  }
  check("generated monitor starts and answers /vdesk/status", up, `port=${PORT}`);

  const start = await req("/vdesk/start", "POST");
  check("POST /vdesk/start is refused synchronously with 409", start.status === 409, `status=${start.status}`);
  check("refusal body is honest (ok:false + error)", !!(start.j && start.j.ok === false && start.j.error === "singleton-conflict"), start.text.slice(0, 120));
  check("refusal carries the offending processes", !!(start.j && Array.isArray(start.j.found) && start.j.found[0] && start.j.found[0].name === "DesktopMgr64.exe"), JSON.stringify(start.j && start.j.found));
  check("refusal carries actionable advice (mentions 强制启动)", !!(start.j && typeof start.j.advice === "string" && start.j.advice.includes("强制启动")), start.j && start.j.advice);
  check("refusal spawned NOTHING (fake script never ran)", !fs.existsSync(marker), marker);

  const conflict = await req("/vdesk/conflict");
  check("GET /vdesk/conflict still returns the read-only probe", !!(conflict.j && conflict.j.ok === true && Array.isArray(conflict.j.found) && conflict.j.found.length === 1), conflict.text.slice(0, 100));

  const forced = await req("/vdesk/start?force=1", "POST");
  check("force=1 is accepted (200, ok:true)", forced.status === 200 && !!(forced.j && forced.j.ok === true), `status=${forced.status} ${forced.text.slice(0, 80)}`);
  let ran = "";
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(marker)) {
      ran = fs.readFileSync(marker, "utf8");
      if (ran.includes("-Force")) break;
    }
    await sleep(250);
  }
  check("force=1 really spawned the script WITH -Force", ran.includes("start -Force"), JSON.stringify(ran.trim()));

  // ---- browser half: a refusal must be visible there too ----
  const src = fs.readFileSync(CLIENT, "utf8");
  check("panel call() reads the response body (no more silent refusal)", /await res\.json\(\)/.test(src));
  check("panel renders the action message (.actmsg)", src.includes('className: "actmsg"') && src.includes(".dsh-vdesk-panel .actmsg{"));
  check("panel maps singleton-conflict to a readable message", src.includes('err === "singleton-conflict"'));
  check("panel hints on 开启 while conflicts are running", src.includes("会被拒绝"));
  const zk = (JSON.parse(fs.readFileSync(ZH, "utf8")).panel) || {};
  const ek = (JSON.parse(fs.readFileSync(EN, "utf8")).panel) || {};
  for (const k of ["conflictRefused", "conflictWays", "actUnreachable", "actFailed", "startRequested"]) {
    check("zh panel copy: " + k, typeof zk[k] === "string" && zk[k].length > 0);
    check("en panel copy: " + k, typeof ek[k] === "string" && ek[k].length > 0);
  }
} finally {
  try {
    child.kill();
  } catch {}
  await sleep(300);
  try {
    fs.closeSync(logFd);
  } catch {}
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log("\nok=" + ok + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
