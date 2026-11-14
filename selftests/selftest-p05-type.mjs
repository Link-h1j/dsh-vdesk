// P0.5-A offline self-check: CLI `type` default = clipboard+Ctrl+V, plugin vdesk_type via param.
// Lives in %TEMP% on purpose. No virtual desktop is started.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const CLI = path.join(ROOT, "vdesk-cli.mjs");
const INDEX = path.join(ROOT, "plugin", "dsh-vdesk", "index.js");
const SHOTS = path.join(os.tmpdir(), "dsh-childsession", "out", "shots-selftest-p05");

const HELP = 18792;
const MON = 18793;
let clipboardEnabled = true;
const calls = { helper: [] };
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
function png(w, h) {
  const b = Buffer.alloc(40);
  b[0] = 0x89; b.write("PNG", 1, "ascii");
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

const helper = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.helper.push(u.pathname + u.search);
  if (u.pathname === "/health") return json(res, { ok: true, width: 1600, height: 900 });
  if (u.pathname === "/screenshot") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png(1200, 675));
  }
  if (u.pathname === "/clipboard") {
    if (!clipboardEnabled) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    return json(res, { ok: true, chars: Number(u.searchParams.get("text") || "").length });
  }
  return json(res, { ok: true, path: u.pathname, query: Object.fromEntries(u.searchParams) });
});
const monitor = http.createServer((req, res) => json(res, { ok: true, action: "mock" }));
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));
await new Promise((r) => monitor.listen(MON, "127.0.0.1", r));

// P4 copy note (tools-dev): the DSH file sandbox refuses PIPED stdio between processes (spawn
// EPERM), so the CLI child's stdout/stderr are handed over as real files instead of pipes. The
// spawned command, its env and every assertion are unchanged; only the capture mechanism differs.
const CLI_SCRATCH = path.join(ROOT, "selftests", ".scratch", "p05-cli");
fs.mkdirSync(CLI_SCRATCH, { recursive: true });
let cliSeq = 0;
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const outFile = path.join(CLI_SCRATCH, "c" + cliSeq + ".out");
    const errFile = path.join(CLI_SCRATCH, "c" + cliSeq + ".err");
    cliSeq++;
    const o = fs.openSync(outFile, "w");
    const e = fs.openSync(errFile, "w");
    const done = (v) => {
      try { fs.closeSync(o); } catch {}
      try { fs.closeSync(e); } catch {}
      resolve(v);
    };
    const p = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        VDESK_HELPER: "http://127.0.0.1:" + HELP,
        VDESK_MONITOR: "http://127.0.0.1:" + MON,
        VDESK_SHOTS: SHOTS,
        ...extraEnv,
      },
      stdio: ["ignore", o, e],
    });
    p.on("error", (err) => done({ code: -1, out: "", err: String((err && err.message) || err), json: null }));
    p.on("close", (code) => {
      const out = fs.readFileSync(outFile, "utf8");
      const err = fs.readFileSync(errFile, "utf8");
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      done({ code, out, err, json: parsed });
    });
  });
}
function callsSince(n) { return calls.helper.slice(n); }

/* ---------------- Part A: CLI vdesk-cli.mjs `type` ---------------- */

{
  const n = calls.helper.length;
  const r = await runCli(["type", "hello", "world", "--no-after"]);
  const c = callsSince(n);
  check(r.json && r.json.via === "clipboard+ctrl+v", "CLI default via=clipboard+ctrl+v", r.json);
  check(r.json && r.json.ok === true && r.json.text === "hello world", "CLI default ok + text", r.json);
  check(r.json && r.json.requestedVia === "auto", "CLI default requestedVia=auto", r.json && r.json.requestedVia);
  check(
    c[0] === "/clipboard?action=set&text=hello%20world" && c[1] === "/key?action=combo&vks=17,86",
    "CLI default helper calls = clipboard set then ctrl+v",
    c
  );
  check(!c.some((x) => x.startsWith("/key?action=text")), "CLI default never uses /key?action=text", c);
}
{
  clipboardEnabled = false;
  const n = calls.helper.length;
  const r = await runCli(["type", "hello", "--no-after"]);
  const c = callsSince(n);
  check(r.json && r.json.via === "sendinput(fallback)" && r.json.fallback === true, "CLI auto falls back when /clipboard missing", r.json);
  check(r.json && r.json.ok === true && r.json.text === "hello", "CLI fallback ok + text", r.json);
  check(c.some((x) => x.startsWith("/key?action=text&text=hello")), "CLI fallback actually types via SendInput", c);
  check(r.json && typeof r.json.clipboardError === "string", "CLI fallback records clipboardError", r.json && r.json.clipboardError);
  check(r.json && r.json.requestedVia === "auto", "CLI fallback keeps caller's requestedVia=auto", r.json && r.json.requestedVia);
  clipboardEnabled = true;
}
{
  const n = calls.helper.length;
  const r = await runCli(["type", "hello", "--via", "sendinput", "--no-after"]);
  const c = callsSince(n);
  check(r.json && r.json.via === "sendinput", "CLI --via sendinput via=sendinput", r.json);
  check(r.json && r.json.text === "hello", "CLI --via value does not leak into text", r.json && r.json.text);
  check(c.length === 1 && c[0] === "/key?action=text&text=hello", "CLI sendinput = one /key?action=text call", c);
  check(!c.some((x) => x.startsWith("/clipboard")), "CLI sendinput never touches clipboard", c);
}
{
  const n = calls.helper.length;
  const r = await runCli(["type", "豆包虚拟桌面", "--no-after"]);
  const c = callsSince(n);
  check(r.json && r.json.via === "clipboard+ctrl+v", "CLI CJK default via clipboard", r.json);
  check(c[0] === "/clipboard?action=set&text=%E8%B1%86%E5%8C%85%E8%99%9A%E6%8B%9F%E6%A1%8C%E9%9D%A2", "CLI CJK URL-encoded into clipboard", c);
}
{
  clipboardEnabled = false;
  const r = await runCli(["type", "hello", "--via", "clipboard", "--no-after"]);
  check(r.json && r.json.ok === false && r.json.via === "clipboard", "CLI --via clipboard is strict (ok:false)", r.json);
  clipboardEnabled = true;
}
{
  const r = await runCli(["type", "hello", "--via", "nope", "--no-after"]);
  check(r.json && r.json.ok === false && /--via must be/.test(r.json.error || ""), "CLI rejects unknown --via", r.json);
}
{
  // no --no-after: the existing screenshot hook must still run
  const n = calls.helper.length;
  const r = await runCli(["type", "hello"]);
  const c = callsSince(n);
  check(r.json && r.json.screenshot && r.json.screenshot.ok === true, "CLI default still takes after-screenshot", r.json && r.json.screenshot);
  check(c.some((x) => x.startsWith("/screenshot?")), "CLI after-screenshot hit /screenshot", c);
  if (r.json && r.json.screenshot && r.json.screenshot.path) {
    check(fs.existsSync(r.json.screenshot.path), "CLI after-screenshot file exists", r.json.screenshot.path);
  }
}

/* ---------------- Part B: plugin vdesk_type ---------------- */

process.env.VDESK_NO_KEEPALIVE = "1";
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_SHOTS = SHOTS;
const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });

const EXPECTED = [
  "vdesk_status", "vdesk_start", "vdesk_stop", "vdesk_restart", "vdesk_screenshot", "vdesk_click",
  "vdesk_move", "vdesk_drag", "vdesk_scroll", "vdesk_key", "vdesk_type", "vdesk_wait",
  "vdesk_task", "vdesk_task_end", "vdesk_keepalive", "vdesk_apps", "vdesk_resolution",
  "vdesk_clipboard",
];
check(regs.map((d) => d.name).join(",") === EXPECTED.join(","), "plugin registers the same 18 tools in order", regs.map((d) => d.name));
for (const d of regs) {
  // P4 added vdesk_clipboard, which legitimately owns a `text` property (action get|set)
  if (d.name === "vdesk_type" || d.name === "vdesk_clipboard") continue;
  const keys = Object.keys(d.parameters.properties || {});
  check(!keys.includes("via") && !keys.includes("text"), "non-type tool shape untouched [" + d.name + "]", keys);
}
const type = regs.find((d) => d.name === "vdesk_type");
check(!!type, "vdesk_type registered");
check(JSON.stringify(Object.keys(type.parameters.properties)) === JSON.stringify(["text", "via", "after"]), "vdesk_type params = text,via,after", Object.keys(type.parameters.properties));
check(JSON.stringify(type.parameters.required) === JSON.stringify(["text"]) && type.parameters.additionalProperties === false, "vdesk_type required/additionalProperties unchanged");
check(JSON.stringify(type.parameters.properties.via.enum) === JSON.stringify(["auto", "clipboard", "sendinput"]), "via enum correct", type.parameters.properties.via.enum);
const CONSTRAINT = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOT = new Set(["description", "title", "default", "examples"]);
function audit(node, p, out) {
  for (const k of Object.keys(node)) if (!CONSTRAINT.has(k) && !ANNOT.has(k)) out.push(p + "." + k);
  if (node.type === "object") for (const [k, v] of Object.entries(node.properties || {})) audit(v, p + "." + k, out);
}
const bad = [];
audit(type.parameters, "parameters", bad);
check(bad.length === 0, "vdesk_type schema still DSH-subset-valid", bad);

const exec = (args) => type.execute({ ...args }, { signal: undefined });
{
  clipboardEnabled = true;
  const n = calls.helper.length;
  const r = await exec({ text: "hello", after: false });
  const c = callsSince(n);
  check(r.ok === true && r.via === "clipboard+ctrl+v", "tool auto -> clipboard+ctrl+v", r);
  check(c[0] === "/clipboard?action=set&text=hello" && c[1] === "/key?action=combo&vks=17,86", "tool auto helper calls", c);
  check(r.chars === 5, "tool reports chars", r.chars);
}
{
  clipboardEnabled = false;
  const n = calls.helper.length;
  const r = await exec({ text: "hello", after: false });
  const c = callsSince(n);
  check(r.ok === true && r.via === "sendinput(fallback)" && r.fallback === true && r.requestedVia === "auto", "tool auto falls back", r);
  check(c.some((x) => x.startsWith("/key?action=text&text=hello")), "tool fallback used SendInput", c);
  clipboardEnabled = true;
}
{
  const n = calls.helper.length;
  const r = await exec({ text: "hello", via: "sendinput", after: false });
  const c = callsSince(n);
  check(r.ok === true && r.via === "sendinput", "tool via=sendinput", r);
  check(c.length === 1 && c[0] === "/key?action=text&text=hello", "tool sendinput single call", c);
}
{
  clipboardEnabled = false;
  const r = await exec({ text: "hello", via: "clipboard", after: false });
  check(r.ok === false && r.via === "clipboard", "tool via=clipboard is strict", r);
  clipboardEnabled = true;
}
{
  const r = await exec({ text: "中文", via: "bogus", after: false });
  check(r.ok === true && r.via === "clipboard+ctrl+v", "tool unknown via degrades to auto", r);
}
{
  const n = calls.helper.length;
  const r = await exec({ text: "hello" });
  const c = callsSince(n);
  check(r.screenshot && r.screenshot.ok === true && fs.existsSync(r.screenshot.path), "tool after-screenshot still works", r.screenshot);
  check(c.some((x) => x.startsWith("/screenshot?")), "tool after-screenshot hit /screenshot", c);
}
{
  // helper fully down -> no throw
  await new Promise((r) => helper.close(r));
  const r = await exec({ text: "hello", after: false });
  check(r.ok === false && r.via === "sendinput(fallback)" && typeof r.error === "string", "tool survives helper down", r);
}

await new Promise((r) => monitor.close(r));
try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch {}
try { fs.rmSync(CLI_SCRATCH, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
