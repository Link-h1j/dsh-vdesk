// P4/B1 self-check (T1): the helper's frozen /stream + /input contract and the monitor's
// 8791 passthrough. A mock helper speaks the frozen protocol (multipart framing, token
// auth, POST /input); the REAL generated vdesk-monitor.mjs is spawned against it.
//
// Nothing here talks to the live child session: no 8790, no virtual desktop, no input
// injection. Scratch files live under the private TEMP of whoever runs it.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const MONITOR_JS = path.join(ROOT, "vdesk-monitor.mjs");

const GOOD = "0123456789abcdef0123456789abcdef";
const BAD = "ffffffffffffffffffffffffffffffff";
const BASE = path.join(os.tmpdir(), "dsh-childsession", "out", "p4-stream");
const GOOD_FILE = path.join(BASE, "good.token");
const BAD_FILE = path.join(BASE, "bad.token");
const TASKS = path.join(BASE, "tasks");
const KEEPER_JSON = path.join(BASE, "keeper.json");
const NO_PS1 = path.join(BASE, "no-such-vdesk.ps1");

const HELP = Number(process.env.P4_HELPER_PORT || 18860);
const MON = Number(process.env.P4_MONITOR_PORT || 18861);
const MON2 = Number(process.env.P4_MONITOR_PORT2 || 18862);

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(TASKS, { recursive: true });
fs.writeFileSync(GOOD_FILE, GOOD + "\n");
fs.writeFileSync(BAD_FILE, BAD + "\n");

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
  b.writeUInt32BE(1600, 16); b.writeUInt32BE(900, 20);
  return b;
}

/* ---------------------------- mock helper ---------------------------- */
const seen = [];
const streamPayloads = [];
let streamOpened = 0;
let streamFrames = 0;
let streamClosed = 0;
const streamTimers = new Set();

const helper = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const rec = { method: req.method, path: u.pathname, search: u.search, token: req.headers["x-vdesk-token"] || null, body: null, contentType: req.headers["content-type"] || null };
  seen.push(rec);

  if (u.pathname === "/health") return json(res, { ok: true, width: 1600, height: 900 });
  if (rec.token !== GOOD) return json(res, { ok: false, error: "unauthorized" }, 401);

  if (u.pathname === "/screenshot") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(png());
  }

  if (u.pathname === "/stream") {
    // Frozen framing: --dshframe CRLF Content-Type CRLF Content-Length CRLF CRLF bytes CRLF
    streamOpened++;
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=dshframe" });
    let n = 0;
    const timer = setInterval(() => {
      const payload = Buffer.from("FRAME" + (++n) + "|" + u.search, "utf8");
      const head = Buffer.from("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: " + payload.length + "\r\n\r\n", "ascii");
      streamPayloads.push(payload);
      streamFrames++;
      res.write(head);
      res.write(payload);
      res.write("\r\n");
    }, 20);
    streamTimers.add(timer);
    res.on("close", () => { clearInterval(timer); streamTimers.delete(timer); streamClosed++; });
    return;
  }

  if (u.pathname === "/input") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      // POST carries the events in the body, GET in ?events= (same frozen document)
      const doc = Buffer.concat(chunks).toString("utf8") || (u.searchParams.get("events") || "");
      rec.body = doc;
      let count = 0;
      try { count = JSON.parse(doc).events.length; } catch { count = -1; }
      json(res, { ok: true, count, ms: 3 });
    });
    return;
  }

  return json(res, { ok: true, action: u.searchParams.get("action"), path: u.pathname });
});
await new Promise((r) => helper.listen(HELP, "127.0.0.1", r));

/* ---------------------------- monitor(s) ---------------------------- */
function spawnMonitor(port, tokenFile) {
  return spawn(process.execPath, [MONITOR_JS], {
    env: {
      ...process.env,
      DSH_VDESK_MONITOR_PORT: String(port),
      VDESK_HELPER_PORT: String(HELP),
      VDESK_TOKEN_FILE: tokenFile,
      VDESK_TASKS: TASKS,
      VDESK_KEEPER_JSON: KEEPER_JSON,
      VDESK_PS1: NO_PS1,          // keep the read-only conflict probe local+fast
      VDESK_HTTP_ONLY: "1",       // the mock is plain http
      VDESK_DEBUG: "1",
    },
    stdio: "ignore",
  });
}
const mi = spawnMonitor(MON, GOOD_FILE);
const mi2 = spawnMonitor(MON2, BAD_FILE);

function raw(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: headers || {} }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString("utf8"), raw: Buffer.concat(c) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) {
    try { await raw(port, "GET", "/vdesk/status"); return true; } catch { await new Promise((r) => setTimeout(r, 120)); }
  }
  return false;
}

// multipart part parser: returns the complete parts and the unparsed tail
function extractParts(buf) {
  const parts = [];
  const B = Buffer.from("--dshframe\r\n", "ascii");
  let i = 0;
  while (true) {
    const idx = buf.indexOf(B, i);
    if (idx < 0) break;
    const rest = buf.slice(idx + B.length);
    const hdrEnd = rest.indexOf("\r\n\r\n");
    if (hdrEnd < 0) break;
    const hdr = rest.slice(0, hdrEnd).toString("ascii");
    const m = /^Content-Type: ([^\r\n]+)\r\nContent-Length: (\d+)$/.exec(hdr);
    if (!m) { parts.push({ malformed: hdr }); break; }
    const len = Number(m[2]);
    const start = hdrEnd + 4;
    if (rest.length < start + len + 2) break;
    parts.push({
      type: m[1],
      len,
      payload: rest.slice(start, start + len),
      trailer: rest.slice(start + len, start + len + 2).toString("ascii"),
    });
    i = idx + B.length + start + len + 2;
  }
  return parts;
}

// GET /stream through the monitor; resolve once `want` frames arrived (or on error)
function openStream(port, query, want) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: query, method: "GET" }, (res) => {
      const chunks = [];
      const finish = (how) => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, req, parts: extractParts(buf), raw: buf, how });
      };
      res.on("data", (d) => {
        chunks.push(d);
        if (extractParts(Buffer.concat(chunks)).length >= want) finish("frames");
      });
      res.on("end", () => finish("end"));
      res.on("error", () => finish("error"));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------- tests ------------------------------- */
try {
  check(await waitUp(MON), "monitor (good token) is up on " + MON);
  check(await waitUp(MON2), "monitor (bad token) is up on " + MON2);

  /* ---- A: /stream is forwarded verbatim (query + token) and passes parts through ---- */
  {
    const n0 = seen.length;
    const before = streamPayloads.length;
    const q = "/stream?format=jpg&quality=72&scale=0.75&fps=10&cursor=1&maxSeconds=300&t=1700000000000";
    const s = await openStream(MON, q, 2);
    const calls = seen.slice(n0).filter((c) => c.path === "/stream");
    check(s.status === 200, "/stream answers 200", s.status);
    check(/^multipart\/x-mixed-replace;\s*boundary=dshframe$/i.test(String(s.headers["content-type"])), "/stream keeps the multipart content type", s.headers["content-type"]);
    check(calls.length === 1 && calls[0].token === GOOD, "/stream carries the token to the helper", calls);
    check(calls.length === 1 && calls[0].search === "?format=jpg&quality=72&scale=0.75&fps=10&cursor=1&maxSeconds=300&t=1700000000000",
      "/stream query string reaches the helper verbatim", calls[0] && calls[0].search);
    check(s.parts.length >= 2, "at least two frames arrived", s.parts.length);
    check(s.parts.every((p) => p.type === "image/jpeg" && p.trailer === "\r\n" && p.payload.length === p.len),
      "every part is '--dshframe / image/jpeg / Content-Length / CRLF' framed", s.parts.map((p) => [p.type, p.len, p.trailer]));
    const mine = streamPayloads.slice(before, before + s.parts.length);
    check(s.parts.length > 0 && s.parts.every((p, i) => mine[i] && p.payload.equals(mine[i])),
      "frame payloads are byte-identical (no re-encode, no buffer corruption)", null);
    s.req.destroy();
    await new Promise((r) => setTimeout(r, 200));
  }

  /* ---- B: helper 401 on /stream is surfaced as JSON (bad token) ---- */
  {
    const n0 = seen.length;
    const s = await openStream(MON2, "/stream?format=jpg", 1);
    const calls = seen.slice(n0).filter((c) => c.path === "/stream");
    check(s.status === 401, "bad token -> monitor /stream 401", s.status);
    check(JSON.parse(s.raw.toString("utf8")).error === "unauthorized", "401 body is the helper's unauthorized JSON", s.raw.toString("utf8").slice(0, 80));
    check(calls.length === 1 && calls[0].token === BAD, "monitor forwarded its (bad) token, not a silent fallback", calls);
  }

  /* ---- C: POST /input forwards body + token, response passes through ---- */
  {
    const n0 = seen.length;
    const payload = JSON.stringify({ events: [{ type: "move", x: 0.5, y: 0.25 }, { type: "key", vk: 17, down: true }] });
    const r = await raw(MON, "POST", "/input", { origin: "dsh-app://app", "content-type": "application/json" }, payload);
    const calls = seen.slice(n0).filter((c) => c.path === "/input");
    check(r.status === 200 && JSON.parse(r.body).ok === true && JSON.parse(r.body).count === 2, "monitor /input returns the helper json", r.body);
    check(calls.length === 1 && calls[0].method === "POST" && calls[0].token === GOOD, "POST /input forwarded with the token", calls);
    check(calls.length === 1 && calls[0].body === payload, "POST /input body forwarded byte-for-byte", calls[0] && calls[0].body);
    check(calls.length === 1 && /application\/json/.test(String(calls[0].contentType)), "forwarded POST keeps a JSON content type", calls[0] && calls[0].contentType);
  }

  /* ---- D: GET /input?events= is forwarded as a GET with the query ---- */
  {
    const n0 = seen.length;
    const ev = encodeURIComponent(JSON.stringify({ events: [{ type: "text", text: "hi" }] }));
    const r = await raw(MON, "GET", "/input?events=" + ev, { origin: "http://127.0.0.1:19387" });
    const calls = seen.slice(n0).filter((c) => c.path === "/input");
    check(r.status === 200 && JSON.parse(r.body).count === 1, "GET /input?events= works", r.body);
    check(calls.length === 1 && calls[0].method === "GET" && calls[0].search === "?events=" + ev, "GET /input query forwarded verbatim", calls[0] && calls[0].search);
  }

  /* ---- E: /input obeys the origin allowlist (403) ---- */
  {
    const n0 = seen.length;
    const r = await raw(MON, "POST", "/input", { origin: "http://evil.example", "content-type": "application/json" }, '{"events":[]}');
    check(r.status === 403 && /forbidden origin/.test(r.body), "foreign-origin /input -> 403", [r.status, r.body]);
    check(seen.slice(n0).every((c) => c.path !== "/input"), "refused /input never reaches the helper", seen.slice(n0));
  }

  /* ---- F: /input obeys the takeover lock (view-only) ---- */
  {
    await raw(MON, "POST", "/takeover?on=0", {});
    const n0 = seen.length;
    const r = await raw(MON, "POST", "/input", { origin: "dsh-app://app", "content-type": "application/json" }, '{"events":[{"type":"move","x":0.5,"y":0.5}]}');
    check(r.status === 200 && JSON.parse(r.body).error === "view-only", "view-only monitor refuses /input", r.body);
    check(seen.slice(n0).every((c) => c.path !== "/input"), "view-only /input never reaches the helper", seen.slice(n0));
    await raw(MON, "POST", "/takeover?on=1", {});
  }

  /* ---- G: client disconnect tears the upstream helper request down ---- */
  {
    const opened0 = streamOpened, closed0 = streamClosed, frames0 = streamFrames;
    const s = await openStream(MON, "/stream?format=jpg&fps=30&maxSeconds=300", 1);
    check(streamOpened === opened0 + 1, "the mock helper saw the stream request", [opened0, streamOpened]);
    s.req.destroy();
    await new Promise((r) => setTimeout(r, 500));
    const framesAfter = streamFrames;
    await new Promise((r) => setTimeout(r, 300));
    check(streamClosed > closed0, "helper stream response was closed after the client left", [closed0, streamClosed]);
    check(streamFrames === framesAfter, "frames stopped being produced (loop released)", [frames0, framesAfter, streamFrames]);
  }

  /* ---- H: old routes are untouched ---- */
  {
    const n0 = seen.length;
    const shot = await raw(MON, "GET", "/shot?format=jpg&scale=0.5", {});
    check(shot.status === 200 && shot.headers["content-type"] === "image/png", "/shot still returns the helper image", [shot.status, shot.headers["content-type"]]);
    check(seen.slice(n0).some((c) => c.path === "/screenshot" && c.token === GOOD), "/shot still carries the token", seen.slice(n0));

    const meta = await raw(MON, "GET", "/meta", { origin: "http://127.0.0.1:19387" });
    check(meta.status === 200 && JSON.parse(meta.body).width === 1600, "/meta still reads helper /health", meta.body);
    check(meta.headers["access-control-allow-origin"] === "http://127.0.0.1:19387", "/meta still echoes the DSH origin", meta.headers["access-control-allow-origin"]);

    const n1 = seen.length;
    const mv = await raw(MON, "POST", "/mouse?action=move&x=1&y=2", { origin: "dsh-app://app" });
    check(mv.status === 200 && JSON.parse(mv.body).ok === true, "/mouse still forwards", [mv.status, mv.body]);
    check(seen.slice(n1).some((c) => c.path === "/mouse" && c.token === GOOD), "/mouse still carries the token", seen.slice(n1));

    const n2 = seen.length;
    const kk = await raw(MON, "POST", "/key?action=combo&vks=17,83", { origin: "dsh-app://app" });
    check(kk.status === 200, "/key still forwards", kk.status);
    check(seen.slice(n2).some((c) => c.path === "/key" && c.search === "?action=combo&vks=17,83"), "/key query forwarded verbatim", seen.slice(n2));

    const evil = await raw(MON, "POST", "/mouse?action=move&x=1&y=1", { origin: "http://evil.example" });
    check(evil.status === 403, "foreign-origin /mouse still 403", evil.status);

    const n3 = seen.length;
    const clickNorm = await raw(MON, "POST", "/click?x=0.5&y=0.25", { origin: "dsh-app://app" });
    check(clickNorm.status === 200, "/click accepts normalised coordinates", clickNorm.status);
    check(seen.slice(n3).some((c) => c.path === "/mouse" && c.search === "?action=click&x=800&y=225&button=left&count=1"),
      "normalised click maps into the 1600x900 helper desktop", seen.slice(n3));

    const n4 = seen.length;
    await raw(MON, "POST", "/click?x=10&y=20", { origin: "dsh-app://app" });
    check(seen.slice(n4).some((c) => c.path === "/mouse" && c.search === "?action=click&x=10&y=20&button=left&count=1"),
      "pixel click still passes through unchanged", seen.slice(n4));

    const st = await raw(MON, "GET", "/vdesk/status", {});
    check(st.status === 200 && JSON.parse(st.body).ok === true, "/vdesk/status still answers", st.status);
    const tk = await raw(MON, "GET", "/vdesk/task", {});
    check(tk.status === 200 && JSON.parse(tk.body).ok === true, "/vdesk/task still answers", tk.status);
    const nf = await raw(MON, "GET", "/nope", {});
    check(nf.status === 404, "unknown route is still 404", nf.status);
  }
} finally {
  mi.kill();
  mi2.kill();
}

for (const t of streamTimers) { clearInterval(t); }
await new Promise((r) => helper.close(r));
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
