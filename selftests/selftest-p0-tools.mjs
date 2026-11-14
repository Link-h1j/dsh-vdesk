// Offline self-check for plugin/dsh-vdesk/index.js (P0-D). Lives in %TEMP% on purpose.
// Mocks ctx.tools.register + both loopback services, then exercises every tool's execute path.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MON = 18791;
const HELP = 18790;
const SHOTS = path.join(os.tmpdir(), "dsh-childsession", "out", "shots-selftest");
process.env.VDESK_NO_KEEPALIVE = "1";
process.env.VDESK_MONITOR_PORT = String(MON);
process.env.VDESK_HELPER_PORT = String(HELP);
process.env.VDESK_SHOTS = SHOTS;

const calls = { monitor: [], helper: [] };
const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail ? " -> " + JSON.stringify(detail) : ""));
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
  if (u.pathname === "/clipboard") return json(res, { ok: true, chars: 3 });
  return json(res, { ok: true, path: u.pathname, query: Object.fromEntries(u.searchParams) });
});
const monitor = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  calls.monitor.push(req.method + " " + u.pathname + u.search);
  if (u.pathname === "/vdesk/status") {
    return json(res, { ok: true, running: false, sessionId: null, uptimeMs: 0, windowed: false, helper: { ok: false } });
  }
  return json(res, { ok: true, action: u.pathname.split("/").pop(), note: "mock" });
});
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));
await new Promise((r) => monitor.listen(MON, "127.0.0.1", r));

const INDEX = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\plugin\\dsh-vdesk\\index.js";
const mod = await import(pathToFileURL(INDEX).href);

check(Array.isArray(mod.inject) && mod.inject.join(",") === "tools", "exports inject=[tools]", mod.inject);
check(typeof mod.apply === "function", "exports apply()");
check(typeof mod.registerTools === "undefined", "no accidental extra export");

const regs = [];
const ctx = {
  tools: { register(def) { regs.push(def); return () => {}; } },
  effect() { return () => {}; },
};
mod.apply(ctx);

const EXPECTED = [
  "vdesk_status", "vdesk_start", "vdesk_stop", "vdesk_restart", "vdesk_screenshot", "vdesk_click",
  "vdesk_move", "vdesk_drag", "vdesk_scroll", "vdesk_key", "vdesk_type", "vdesk_wait",
  "vdesk_task", "vdesk_task_end", "vdesk_keepalive", "vdesk_apps", "vdesk_resolution",
  "vdesk_clipboard",
];
check(regs.length === 18, "registers exactly 18 tools (12 P0 + 3 P1 + apps + resolution + clipboard)", regs.map((d) => d.name));
check(regs.map((d) => d.name).join(",") === EXPECTED.join(","), "tool names/order match spec", regs.map((d) => d.name));

const CONSTRAINT = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOT = new Set(["description", "title", "default", "examples"]);
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
function auditSchema(node, p, out) {
  if (!node || typeof node !== "object") { out.push(p + " not an object"); return; }
  for (const k of Object.keys(node)) {
    if (!CONSTRAINT.has(k) && !ANNOT.has(k)) out.push(p + "." + k + " unsupported keyword");
  }
  if (node.type !== undefined && !TYPES.includes(node.type)) out.push(p + ".type invalid: " + node.type);
  if (node.type === "object") {
    const props = node.properties || {};
    for (const k of node.required || []) if (!Object.hasOwn(props, k)) out.push(p + ".required names missing " + k);
    for (const [k, v] of Object.entries(props)) auditSchema(v, p + ".properties." + k, out);
  }
  if (node.type === "array" && node.items) auditSchema(node.items, p + ".items", out);
}
for (const d of regs) {
  const sfx = " [" + d.name + "]";
  check(typeof d.description === "string" && d.description.length > 20, "description present" + sfx);
  check(/child-session slot/.test(d.description) && /子会话名额/.test(d.description), "description carries safety note" + sfx);
  check(typeof d.execute === "function", "execute()" + sfx);
  check(d.parameters && d.parameters.type === "object" && !Array.isArray(d.parameters), "object-root parameters" + sfx);
  check(d.output && typeof d.output.render === "function" && d.output.schema && d.output.schema.type === "object", "output{schema,render}" + sfx);
  const out = [];
  auditSchema(d.parameters, "parameters", out);
  auditSchema(d.output.schema, "output", out);
  check(out.length === 0, "schema subset-valid" + sfx, out);
  const rendered = d.output.render({}, { ok: true, n: 1 });
  check(Array.isArray(rendered) && rendered[0] && rendered[0].type === "text" && typeof rendered[0].text === "string", "render returns text parts" + sfx);
}
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));
const noArgs = { signal: undefined };
const call = (name, args) => byName[name].execute({ ...args }, noArgs);

// --- status / control ---
const st = await call("vdesk_status", {});
check(st.ok === true && st.running === false, "vdesk_status returns monitor JSON", st);
const start = await call("vdesk_start", { minutes: 120 });
check(start.ok === true && start.action === "start", "vdesk_start ok", start);
check(calls.monitor.some((c) => c === "POST /vdesk/start?minutes=120"), "vdesk_start forwards minutes", calls.monitor);
await call("vdesk_stop", {});
await call("vdesk_restart", {});
check(calls.monitor.includes("POST /vdesk/stop") && calls.monitor.includes("POST /vdesk/restart"), "stop/restart POST correct routes", calls.monitor);

// --- screenshot ---
const shot = await call("vdesk_screenshot", {});
check(shot.ok === true && fs.existsSync(shot.path), "screenshot written to disk", shot);
check(shot.width === 1200 && shot.height === 675, "png header dims parsed", shot);
check(typeof shot.kb === "number" && typeof shot.ms === "number", "kb/ms present", shot);
check(shot.path.startsWith(SHOTS), "screenshot respects VDESK_SHOTS", shot.path);

// --- coordinates: 0.5/0.5 of 1600x900 = 800/450 ; >1 stays pixels ---
const clk = await call("vdesk_click", { x: 0.5, y: 0.5, button: "right", count: 2 });
check(clk.ok === true && clk.x === 800 && clk.y === 450 && clk.button === "right" && clk.count === 2, "click normalises coords", clk);
check(calls.helper.some((c) => c.includes("/mouse?action=click&x=800&y=450&button=right&count=2")), "click helper URL", calls.helper.filter((c) => c.startsWith("/mouse")));
check(clk.screenshot && clk.screenshot.ok === true, "click returns after-screenshot by default", clk.screenshot && clk.screenshot.ok);
const clk2 = await call("vdesk_click", { x: 1234, y: 77, after: false });
check(clk2.x === 1234 && clk2.y === 77 && clk2.screenshot === undefined, "pixels pass through and after:false skips shot", clk2);
const mv = await call("vdesk_move", { x: 0.25, y: 0.5, after: false });
check(mv.x === 400 && mv.y === 450, "move normalises", mv);
const dg = await call("vdesk_drag", { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, after: false });
check(dg.from[0] === 160 && dg.to[0] === 1440 && dg.to[1] === 810, "drag normalises endpoints", dg);
const sc = await call("vdesk_scroll", { x: 0.5, y: 0.5, after: false });
check(sc.delta === 480 && calls.helper.some((c) => c.includes("/mouse?action=scroll&x=800&y=450&delta=480")), "scroll default delta", sc);
const badCoord = await call("vdesk_click", { x: "abc", y: 1 });
check(badCoord.ok === false && typeof badCoord.error === "string", "bad coord -> ok:false (no throw)", badCoord);

// --- key / type ---
const k = await call("vdesk_key", { combo: "ctrl+s", after: false });
check(k.ok === true && k.vks.join(",") === "17,83", "key maps combo to VK codes", k);
const kErr = await call("vdesk_key", { combo: "ctrl+nope" });
check(kErr.ok === false && /unknown key/.test(kErr.error), "unknown key -> ok:false", kErr);
const tAscii = await call("vdesk_type", { text: "hello world", after: false });
check(tAscii.ok === true && tAscii.via === "clipboard+ctrl+v" && calls.helper.some((c) => c.startsWith("/clipboard?action=set&text=hello%20world")), "ascii type defaults to clipboard (P0.5)", tAscii);
const tForce = await call("vdesk_type", { text: "hello world", via: "sendinput", after: false });
check(tForce.ok === true && tForce.via === "sendinput" && calls.helper.some((c) => c.startsWith("/key?action=text&text=hello%20world")), "via=sendinput still injects per character", tForce);
const tZh = await call("vdesk_type", { text: "豆包虚拟桌面测试", after: false });
check(tZh.ok === true && tZh.via === "clipboard+ctrl+v", "non-ascii via clipboard+ctrl+v", tZh);
check(calls.helper.some((c) => c.includes("/clipboard?action=set&text=%E8%B1%86%E5%8C%85")), "clipboard set URL-encoded", calls.helper.filter((c) => c.startsWith("/clipboard")));
check(calls.helper.some((c) => c === "/key?action=combo&vks=17,86"), "ctrl+v after clipboard", calls.helper.filter((c) => c.startsWith("/key?action=combo")));

// --- wait ---
const t0 = Date.now();
const w = await call("vdesk_wait", { ms: 40 });
check(w.ok === true && w.waitedMs === 40 && Date.now() - t0 >= 35, "wait sleeps", w);

// --- graceful failure when services are gone ---
await new Promise((r) => helper.close(r));
await new Promise((r) => monitor.close(r));
const down = await call("vdesk_status", {});
check(down.ok === false && typeof down.error === "string", "monitor down -> {ok:false,error}", down);
const downShot = await call("vdesk_screenshot", {});
check(downShot.ok === false && typeof downShot.error === "string", "helper down -> screenshot {ok:false,error}", downShot);
const downClick = await call("vdesk_click", { x: 0.5, y: 0.5 });
check(downClick.ok === false && typeof downClick.error === "string", "helper down -> click {ok:false,error}", downClick);

try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
