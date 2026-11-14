// P4/B3+B4+B5 offline self-check for the tool surface added by task-2:
//   vdesk_clipboard (get/set), vdesk_key action down|up via POST /input, vdesk_wait stable:true.
// Both sides are exercised: the plugin host half (imported in-process) and the REAL CLI in a
// child process. The helper is a mock that implements T1's frozen /input + /clipboard + /screenshot
// contracts, so no virtual desktop is started and nothing is injected into the real session.
//
// Lives in tools/vdesk-childsession/selftests/ (workspace) because the real %TEMP% is read-only
// under the DSH file sandbox; see P4-TOOLS.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "vdesk-cli.mjs");
const INDEX = path.join(ROOT, "plugin", "dsh-vdesk", "index.js");
const SCRATCH = path.join(HERE, ".scratch", "p4-tools");
const SHOTS = path.join(SCRATCH, "shots");

const HELP = 18790 + 1900; // 19690 -- private to this test
const MON = HELP + 1;

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

/* ---------------- mock helper (T1 frozen contracts) ---------------- */

const STATIC_FRAME = Buffer.from("STATIC-FRAME-".repeat(64));
const calls = { helper: [] };
const inputCalls = []; // {method, raw|query, events}
const clipboardSets = [];
const shotUrls = [];
let clipboardText = "hello";
let inputMode = "ok"; // ok | fail | 404
let frameMode = "static"; // static | changing
let frameTick = 0;

const helper = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.helper.push(req.method + " " + u.pathname + u.search);
  if (u.pathname === "/health") return json(res, { ok: true, width: 1600, height: 900 });
  if (u.pathname === "/screenshot") {
    shotUrls.push(u.pathname + u.search);
    const buf = frameMode === "static" ? STATIC_FRAME : Buffer.from("CHANGING-" + String(++frameTick).padStart(6, "0") + "-" + "y".repeat(200));
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(buf);
  }
  if (u.pathname === "/clipboard") {
    const action = u.searchParams.get("action") || "get";
    if (action === "set") {
      const text = u.searchParams.get("text") || "";
      clipboardSets.push(text);
      return json(res, { ok: true, chars: text.length });
    }
    return json(res, { ok: true, text: clipboardText });
  }
  if (u.pathname === "/input") {
    if (inputMode === "404") {
      // record the ATTEMPT too, so a test can prove both POST and GET were tried
      inputCalls.push({ method: req.method, raw: "", query: u.searchParams.get("events"), events: [], routeMissing: true });
      return json(res, { ok: false, error: "unknown endpoint" }, 404);
    }
    const finishInput = (rawBody) => {
      let events = [];
      try {
        const src = req.method === "POST" ? rawBody : u.searchParams.get("events") || "{}";
        events = JSON.parse(src).events || [];
      } catch {
        events = [];
      }
      inputCalls.push({ method: req.method, raw: rawBody, query: u.searchParams.get("events"), events });
      if (inputMode === "fail") return json(res, { ok: false, index: 0, error: "inject-fail" });
      return json(res, { ok: true, count: events.length, ms: 1 });
    };
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => finishInput(b));
    } else finishInput("");
    return;
  }
  if (u.pathname.startsWith("/key")) return json(res, { ok: true, keys: u.searchParams.get("vks") });
  return json(res, { ok: true, path: u.pathname });
});
const monitor = http.createServer((req, res) => json(res, { ok: true, action: "mock" }));
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));
await new Promise((r) => monitor.listen(MON, "127.0.0.1", r));

/* ---------------- plugin half ---------------- */

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.VDESK_NO_KEEPALIVE = "1";
process.env.VDESK_NO_LIFECYCLE = "1";
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_SHOTS = SHOTS;
process.env.VDESK_TASKS = path.join(SCRATCH, "tasks");
process.env.VDESK_TOKEN_FILE = path.join(SCRATCH, "no-token");
process.env.VDESK_CERT_PIN = path.join(SCRATCH, "no-pin");
process.env.VDESK_HTTP_ONLY = "1";
process.env.VDESK_DESIRED_RES = path.join(SCRATCH, "desired.json");

const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));
const call = (name, args) => byName[name].execute({ ...args }, { signal: undefined });

/* ---------------- plugin: vdesk_clipboard ---------------- */

check(!!byName.vdesk_clipboard, "vdesk_clipboard is registered");
{
  const p = byName.vdesk_clipboard.parameters;
  check(JSON.stringify(p.required) === JSON.stringify(["action"]) && p.additionalProperties === false, "vdesk_clipboard requires action only", p.required);
  check(JSON.stringify(p.properties.action.enum) === JSON.stringify(["get", "set"]), "clipboard action enum get|set", p.properties.action.enum);
  const d = byName.vdesk_clipboard.description || "";
  check(/child-session slot/.test(d) && /子会话名额/.test(d), "clipboard description carries the safety note");
}
{
  clipboardText = "hello";
  const n = calls.helper.length;
  const r = await call("vdesk_clipboard", { action: "get" });
  check(r.ok === true && r.text === "hello" && r.chars === 5 && r.truncated === false, "clipboard get returns {ok,text,chars,truncated}", r);
  check(calls.helper.slice(n).includes("GET /clipboard?action=get"), "clipboard get hits /clipboard?action=get", calls.helper.slice(n));
}
{
  const long = "字".repeat(5000);
  clipboardText = long;
  const r = await call("vdesk_clipboard", { action: "get" });
  check(r.ok === true && r.text.length === 4000 && r.truncated === true && r.chars === 5000, "clipboard get cuts at 4000 chars and flags it", { len: r.text.length, chars: r.chars, truncated: r.truncated });
  check(r.text.slice(0, 3) === "字字字" && r.text.slice(-1) === "字", "truncated text stays intact UTF-8", r.text.slice(0, 3));
}
{
  const n = clipboardSets.length;
  const r = await call("vdesk_clipboard", { action: "set", text: "豆包虚拟桌面" });
  check(r.ok === true && r.chars === 6, "clipboard set returns {ok,chars}", r);
  check(clipboardSets[n] === "豆包虚拟桌面", "clipboard set decodes back to the exact CJK text", clipboardSets[n]);
  check(calls.helper.some((c) => c.includes("/clipboard?action=set&text=%E8%B1%86%E5%8C%85")), "clipboard set is UTF-8 percent-encoded on the wire");
}
{
  // helper failure must not be swallowed
  const saved = clipboardText;
  clipboardText = null; // json({text:null})
  const r = await call("vdesk_clipboard", { action: "get" });
  check(r.ok === true && r.text === "" && r.chars === 0, "clipboard get tolerates a null helper text", r);
  clipboardText = saved;
}
{
  clipboardText = "fallback";
  const r = await call("vdesk_clipboard", { action: "nope" });
  check(r.ok === true && r.text === "fallback", "clipboard unknown action degrades to get (no throw)", r);
  clipboardText = "hello";
}

/* ---------------- plugin: vdesk_key action down|up ---------------- */

{
  const p = byName.vdesk_key.parameters;
  check(JSON.stringify(Object.keys(p.properties)) === JSON.stringify(["combo", "action", "after"]), "vdesk_key params = combo,action,after", Object.keys(p.properties));
  check(JSON.stringify(p.properties.action.enum) === JSON.stringify(["combo", "down", "up"]), "vdesk_key action enum", p.properties.action.enum);
  check(JSON.stringify(p.required) === JSON.stringify(["combo"]), "vdesk_key still requires combo");
}
{
  const n = calls.helper.length;
  const r = await call("vdesk_key", { combo: "ctrl+s", after: false });
  check(r.ok === true && r.action === "combo" && r.vks.join(",") === "17,83", "default action=combo keeps the old chord path", r);
  check(calls.helper.slice(n).some((c) => c.includes("/key?action=combo&vks=17,83")), "combo uses GET /key (backward compatible)", calls.helper.slice(n));
  check(!inputCalls.length, "combo never touches /input");
}
{
  const before = inputCalls.length;
  const r = await call("vdesk_key", { combo: "shift", action: "down", after: false });
  check(r.ok === true && r.action === "down" && r.vk === 16 && r.count === 1, "action:down presses one key via /input", r);
  const c = inputCalls[before];
  check(c && c.method === "POST", "down uses POST /input", c && c.method);
  check(JSON.stringify(c.events) === JSON.stringify([{ type: "key", vk: 16, down: true }]), "down body is a single key event with down:true", c && c.events);
}
{
  const before = inputCalls.length;
  const r = await call("vdesk_key", { combo: "shift", action: "up", after: false });
  check(r.ok === true && r.action === "up" && r.count === 1, "action:up releases one key via /input", r);
  const c = inputCalls[before];
  check(JSON.stringify(c.events) === JSON.stringify([{ type: "key", vk: 16, down: false }]), "up body has down:false", c && c.events);
}
{
  const before = inputCalls.length;
  const r = await call("vdesk_key", { combo: "ctrl+shift", action: "down", after: false });
  check(r.ok === false && /exactly one key/.test(String(r.error)), "multi-key down is rejected", r);
  check(inputCalls.length === before, "rejected multi-key down sends nothing", inputCalls.length - before);
}
{
  inputMode = "fail";
  const r = await call("vdesk_key", { combo: "a", action: "down", after: false });
  check(r.ok === false && r.index === 0 && /inject-fail/.test(String(r.error)), "helper {ok:false,index,error} surfaces verbatim", r);
  inputMode = "ok";
}
{
  inputMode = "404";
  const before = inputCalls.length;
  const r = await call("vdesk_key", { combo: "shift", action: "down", after: false });
  check(r.ok === false && /\/input/.test(String(r.error)) && r.preInput === true, "old helper (no /input) -> honest {ok:false,error}", r);
  const tries = inputCalls.slice(before).map((c) => c.method);
  check(tries.includes("POST") && tries.includes("GET"), "POST then GET fallback both attempted, nothing faked", tries);
  // the combo path must still work on the same (old) helper
  const ok = await call("vdesk_key", { combo: "ctrl+s", after: false });
  check(ok.ok === true, "combo path unaffected by a pre-P4 helper", ok);
  inputMode = "ok";
}

/* ---------------- plugin: vdesk_wait stable ---------------- */

{
  const p = byName.vdesk_wait.parameters;
  check(JSON.stringify(Object.keys(p.properties)) === JSON.stringify(["ms", "stable", "timeoutMs", "intervalMs", "samples", "maxDiffBytes"]), "vdesk_wait params extended", Object.keys(p.properties));
  check(p.required === undefined, "vdesk_wait no longer hard-requires ms", p.required);
}
{
  const n = shotUrls.length;
  const t0 = Date.now();
  const r = await call("vdesk_wait", { ms: 30 });
  check(r.ok === true && r.waitedMs === 30 && Date.now() - t0 >= 25, "plain vdesk_wait {ms} unchanged", r);
  check(shotUrls.length === n, "plain wait takes no screenshot", shotUrls.length - n);
}
{
  frameMode = "static";
  const n = shotUrls.length;
  const r = await call("vdesk_wait", { stable: true, timeoutMs: 5000, intervalMs: 10, samples: 3 });
  check(r.ok === true && r.stable === true && r.timedOut === false, "stable:true returns ok/stable on static frames", r);
  check(r.attempts === 3 && r.bytes === STATIC_FRAME.length && /^[0-9a-f]{64}$/.test(String(r.lastHash)), "stable reports attempts/bytes/lastHash", { attempts: r.attempts, bytes: r.bytes, hash: r.lastHash });
  check(shotUrls.slice(n).every((s) => s === "/screenshot?format=jpg&quality=40&scale=0.35&cursor=0"), "stable polls the frozen small-frame URL", shotUrls.slice(n));
}
{
  frameMode = "changing";
  const r = await call("vdesk_wait", { stable: true, timeoutMs: 120, intervalMs: 10, samples: 3 });
  check(r.ok === false && r.stable === false && r.timedOut === true && /did not stabilize/.test(String(r.error)), "changing frames time out honestly (ok:false+timedOut)", r);
  check(typeof r.attempts === "number" && r.attempts > 0 && /^[0-9a-f]{64}$/.test(String(r.lastHash)), "timeout still reports attempts/lastHash", { attempts: r.attempts, hash: r.lastHash });
  frameMode = "static";
}

/* ---------------- CLI (real child process) ---------------- */

// The DSH file sandbox refuses piped stdio between processes (node spawn EPERM on 'pipe'), so the
// child's stdout/stderr are real FILES handed to it as fds -- still a genuine child process, still
// the real vdesk-cli.mjs, just without a named pipe in the middle.
let cliSeq = 0;
function runCli(args) {
  return new Promise((resolve) => {
    const outFile = path.join(SCRATCH, "cli-" + String(cliSeq).padStart(2, "0") + ".out");
    const errFile = path.join(SCRATCH, "cli-" + String(cliSeq).padStart(2, "0") + ".err");
    cliSeq++;
    const o = fs.openSync(outFile, "w");
    const e = fs.openSync(errFile, "w");
    const finish = (result) => {
      try { fs.closeSync(o); } catch {}
      try { fs.closeSync(e); } catch {}
      resolve(result);
    };
    const p = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        VDESK_HELPER: "http://127.0.0.1:" + HELP,
        VDESK_MONITOR: "http://127.0.0.1:" + MON,
        VDESK_SHOTS: SHOTS,
        VDESK_TOKEN_FILE: path.join(SCRATCH, "no-token"),
        VDESK_CERT_PIN: path.join(SCRATCH, "no-pin"),
        VDESK_HTTP_ONLY: "1",
      },
      stdio: ["ignore", o, e],
    });
    p.on("error", (err) => finish({ code: -1, out: "", err: String((err && err.message) || err), json: null }));
    p.on("close", (code) => {
      const out = fs.readFileSync(outFile, "utf8");
      const err = fs.readFileSync(errFile, "utf8");
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      finish({ code, out, err, json: parsed });
    });
  });
}

{
  const n = calls.helper.length;
  const r = await runCli(["key", "ctrl+s", "--no-after"]);
  check(r.json && r.json.ok === true && r.json.action === "combo", "CLI key combo unchanged", r.json);
  check(calls.helper.slice(n).some((c) => c.includes("/key?action=combo&vks=17,83")), "CLI combo hits GET /key", calls.helper.slice(n));
}
{
  const before = inputCalls.length;
  const r = await runCli(["key", "shift", "--action", "down", "--no-after"]);
  check(r.json && r.json.ok === true && r.json.action === "down" && r.json.vk === 16, "CLI key --action down", r.json);
  const c = inputCalls[before];
  check(c && c.method === "POST" && JSON.stringify(c.events) === JSON.stringify([{ type: "key", vk: 16, down: true }]), "CLI down posts the frozen single-key event", c);
}
{
  const before = inputCalls.length;
  const r = await runCli(["key", "shift", "--action", "up", "--no-after"]);
  check(r.json && r.json.ok === true && JSON.stringify(inputCalls[before].events) === JSON.stringify([{ type: "key", vk: 16, down: false }]), "CLI key --action up", r.json);
}
{
  const r = await runCli(["key", "ctrl+shift", "--action", "down", "--no-after"]);
  check(r.json && r.json.ok === false && /exactly one key/.test(r.json.error || ""), "CLI rejects a multi-key --action down", r.json);
}
{
  const r = await runCli(["key", "shift", "--action", "bogus", "--no-after"]);
  check(r.json && r.json.ok === false && /--action must be/.test(r.json.error || ""), "CLI rejects an unknown --action", r.json);
}
{
  inputMode = "404";
  const r = await runCli(["key", "shift", "--action", "down", "--no-after"]);
  check(r.json && r.json.ok === false && /\/input/.test(r.json.error || ""), "CLI old helper -> honest /input error", r.json);
  inputMode = "ok";
}
{
  clipboardText = "hello";
  const r = await runCli(["clipboard", "get"]);
  check(r.json && r.json.ok === true && r.json.text === "hello" && r.json.chars === 5 && r.json.truncated === false, "CLI clipboard get shape", r.json);
}
{
  clipboardText = "字".repeat(4500);
  const r = await runCli(["clipboard", "get"]);
  check(r.json && r.json.text.length === 4000 && r.json.truncated === true && r.json.chars === 4500, "CLI clipboard get truncates at 4000", r.json && { len: r.json.text.length, chars: r.json.chars, truncated: r.json.truncated });
}
{
  const n = clipboardSets.length;
  const r = await runCli(["clipboard", "set", "中文 文本"]);
  check(r.json && r.json.ok === true && r.json.chars === 5, "CLI clipboard set returns {ok,chars}", r.json);
  check(clipboardSets[n] === "中文 文本", "CLI clipboard set keeps CJK + space exactly", clipboardSets[n]);
}
{
  clipboardText = "unused";
  frameMode = "static";
  const n = shotUrls.length;
  const r = await runCli(["wait", "--stable", "--timeout", "5000", "--interval", "10", "--samples", "3"]);
  check(r.json && r.json.ok === true && r.json.stable === true && r.json.attempts === 3, "CLI wait --stable settles", r.json);
  check(shotUrls.slice(n).every((s) => s === "/screenshot?format=jpg&quality=40&scale=0.35&cursor=0"), "CLI --stable polls the frozen URL", shotUrls.slice(n));
}
{
  frameMode = "changing";
  const r = await runCli(["wait", "--stable", "--timeout", "120", "--interval", "10", "--samples", "3"]);
  check(r.json && r.json.ok === false && r.json.stable === false && r.json.timedOut === true, "CLI wait --stable timeout is honest", r.json);
  frameMode = "static";
}
{
  const r = await runCli(["wait", "50"]);
  check(r.json && r.json.ok === true && r.json.waitedMs === 50, "CLI wait <ms> unchanged", r.json);
}

/* ---------------- graceful failure with the helper gone ---------------- */

await new Promise((r) => helper.close(r));
{
  const r = await call("vdesk_clipboard", { action: "get" });
  check(r.ok === false && typeof r.error === "string", "helper down -> clipboard {ok:false,error}", r);
  const k = await call("vdesk_key", { combo: "shift", action: "down", after: false });
  check(k.ok === false && typeof k.error === "string", "helper down -> key down {ok:false,error}", k);
  const w = await call("vdesk_wait", { stable: true, timeoutMs: 200, intervalMs: 10, samples: 2 });
  check(w.ok === false && w.timedOut === false && typeof w.error === "string", "helper down -> wait stable {ok:false,error}", w);
}
await new Promise((r) => monitor.close(r));
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
