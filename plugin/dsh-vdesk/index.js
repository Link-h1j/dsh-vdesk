/**
 * Host half of @local/dsh-vdesk.
 *
 * Part 1 -- keep-alive. The visible half (client.js) renders inside the Harness Web page and talks
 * to a small local service on 127.0.0.1:8791 that owns the child-session virtual desktop
 * (start/stop, live frames, mouse/keyboard). That service is not part of DSH, so this Host half
 * keeps it alive: it pings the service and, when nothing answers, starts it detached via
 * vdesk-visible.ps1 (which is idempotent: it starts the Node service only when the port is free,
 * and opens the app window only once).
 *
 * Part 2 -- native tools. The same plugin exposes the P0 tool surface as real DSH agent tools, so
 * the model calls vdesk_* directly instead of shelling out to vdesk-cli.mjs. "Recipe A" from
 * NOTES-tool-registration.md is used on purpose: `ctx.tools.register(plainObject)` needs no
 * `import ... from "@deepseek-ai/dsh-tools"` and no peerDependencies, which is what keeps a
 * junctioned third-party plugin resolvable (a wrong peer range would make the host skip the whole
 * bundle). Semantics mirror vdesk-cli.mjs: coordinates <= 1 are normalised (0..1), > 1 are pixels;
 * input actions take a fresh screenshot afterwards unless after:false.
 *
 * Nothing here touches the user's own desktop, and no DSH package is imported on purpose.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 8791; // panel/monitor service -- also the keep-alive target
// Tools talk to the same services; the env overrides exist so a test harness can point them at a
// mock without touching the real child-session (they are never set in production).
const MONITOR_PORT = Number(process.env.VDESK_MONITOR_PORT || PORT);
const HELPER_PORT = Number(process.env.VDESK_HELPER_PORT || 8790);
const OUTDIR =
  process.env.VDESK_SHOTS ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\shots";
// P0.6: the token the in-session helper requires (everything except GET /health); the helper
// generates it and tightens its ACL, this half only reads it.
const TOKEN_FILE =
  process.env.VDESK_TOKEN_FILE ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\token";
const VISIBLE_PS1 =
  "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\vdesk-visible.ps1";
// The log path is overridable with the same VDESK_* test-hook pattern as the ports above, so an
// offline self-test running under a read-only %TEMP% can still assert on the host log.
const LOG =
  process.env.VDESK_PLUGIN_LOG ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\plugin-host.log";
const CHECK_MS = 60_000;
// P1 task runner journal (mirrors what vdesk-monitor.mjs serves on GET /vdesk/task)
const TASKS_DIR =
  process.env.VDESK_TASKS ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\tasks";
const IDLE_MS = Number(process.env.VDESK_IDLE_MS || 10 * 60_000); // 空闲回收阈值
const IDLE_CHECK_MS = Number(process.env.VDESK_IDLE_CHECK_MS || 60_000);
// P2-A: remembered desktop size. RDP fixes the size at connect time, so vdesk_resolution writes the
// target here and restarts; vdesk.ps1 start reads it when -Width/-Height are not given.
const DESIRED_RES_FILE =
  process.env.VDESK_DESIRED_RES ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\desired-resolution.json";

function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch {
    /* logging must never break the plugin */
  }
}

function messageOf(e) {
  return String((e && e.message) || e);
}

/* ------------------------------------------------------------------ keep-alive (part 1) */

function ping(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = http.request(
        { host: HOST, port: PORT, path: "/vdesk/status", method: "GET", timeout: timeoutMs },
        (res) => {
          res.resume();
          finish(res.statusCode === 200);
        }
      );
      req.on("error", () => finish(false));
      req.on("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.end();
    } catch {
      finish(false);
    }
  });
}

function startService() {
  try {
    const out = fs.openSync(LOG, "a");
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VISIBLE_PS1, "-NoWindow"],
      { detached: false, stdio: ["ignore", out, out], windowsHide: true }
    );
    p.unref();
    log("started vdesk-visible.ps1 pid=" + p.pid);
  } catch (e) {
    log("failed to start service: " + messageOf(e));
  }
}

function startKeepAlive(ctx) {
  let stopped = false;

  const check = async () => {
    if (stopped) return;
    const alive = await ping();
    if (!alive) {
      log("vdesk service not answering -> starting it");
      startService();
    }
  };

  // first check shortly after activation, then periodically
  const boot = setTimeout(check, 1_500);
  const timer = setInterval(check, CHECK_MS);
  if (timer.unref) timer.unref();
  if (boot.unref) boot.unref();

  const cleanup = () => {
    stopped = true;
    clearTimeout(boot);
    clearInterval(timer);
  };

  if (ctx && typeof ctx.effect === "function") {
    try {
      ctx.effect(() => cleanup);
    } catch {
      /* if the effect API differs, the timers are unref'd and harmless */
    }
  }

  return cleanup;
}

/* ------------------------------------------------------------------ HTTP plumbing (part 2) */

/**
 * P0.6: the in-session helper authenticates every route except GET /health with X-VDesk-Token.
 * The file is re-read on every request so a rotated token is picked up without a DSH restart; a
 * missing/invalid file sends no header and the helper answers 401.
 */
function readToken() {
  try {
    const file = process.env.VDESK_TOKEN_FILE || TOKEN_FILE;
    const t = fs.readFileSync(file, "utf8").trim();
    return /^[0-9a-fA-F]{32}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

const UNAUTHORIZED_TEXT =
  "unauthorized: the helper rejected X-VDesk-Token (token file missing or mismatched, or the helper " +
  "is still the pre-P0.6 build)";

/* --------------------------------------------------- helper transport: pinned HTTPS (P2-C) */

/**
 * P2-C: the in-session helper serves HTTPS with a self-signed certificate. The chain is therefore
 * not the trust anchor -- the SHA-256 in helper-cert.sha256 is. When that file is absent (task-15
 * not landed) or VDESK_HTTP_ONLY=1, we keep plain http, and an https probe failure (e.g. the
 * one-time `netsh http add sslcert` binding is still missing, so the helper itself fell back to
 * http) drops us back to http as well: the tool surface must never break because of the TLS
 * rollout. Every decision is logged once with its reason.
 */
const CERT_PIN_FILE =
  process.env.VDESK_CERT_PIN ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\helper-cert.sha256";
const TRANSPORT_TTL_MS = 5_000;

let helperTransport = { scheme: null, pin: null, at: 0, reason: "" };
let loggedTransport = "";

function readCertPin() {
  try {
    const t = fs.readFileSync(CERT_PIN_FILE, "utf8").toLowerCase().replace(/[^0-9a-f]/g, "");
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

function noteTransport(t) {
  const key = t.scheme + ":" + t.reason;
  if (key === loggedTransport) return;
  loggedTransport = key;
  const line = "helper transport -> " + t.scheme + " (" + t.reason + ")";
  // Probe/fallback chatter is debug-only (VDESK_DEBUG=1); a pin REFUSAL is always logged, and the
  // 401 path (UNAUTHORIZED_TEXT) is never silenced either.
  if (t.refused) log("REFUSED " + line);
  else if (process.env.VDESK_DEBUG === "1") log(line);
}

function resetTransport(why) {
  helperTransport = { scheme: null, pin: null, at: 0, reason: why || "" };
}

function finishResponse(finish, statusCode, headers, body, scheme) {
  const ct = String((headers && headers["content-type"]) || "");
  let json = null;
  if (ct.includes("json")) {
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      json = null;
    }
  }
  finish({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    contentType: ct,
    body,
    json,
    ...(scheme ? { scheme } : {}),
    // P0.6: every 8790 route except /health needs the token; translate the 401 into a message an
    // operator can act on instead of a bare status number.
    ...(statusCode === 401 ? { unauthorized: true, error: UNAUTHORIZED_TEXT } : { error: null }),
  });
}

/** One request over a GIVEN helper transport; rejects nothing, reports {transportError} on failure.
 *  P4: an optional request body (string/Buffer) turns this into the POST /input carrier. */
function rawHelperRequest(t, method, pathname, timeoutMs, signal, body, contentType) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const failed = (error) =>
      finish({ ok: false, status: 0, contentType: "", body: Buffer.alloc(0), json: null, error, transportError: true });

    if (signal && signal.aborted) return failed("aborted");
    const headers = { accept: "application/json, image/*, */*" };
    const token = readToken();
    if (token) headers["X-VDesk-Token"] = token;
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    if (payload) {
      headers["content-type"] = contentType || "application/json; charset=utf-8";
      headers["content-length"] = payload.length;
    }
    const mod = t.scheme === "https" ? https : http;
    const options = { host: HOST, port: HELPER_PORT, path: pathname, method, timeout: timeoutMs, headers };
    if (t.scheme === "https") {
      // self-signed by design: accept it, then verify the PIN before anything is sent
      options.rejectUnauthorized = false;
      options.checkServerIdentity = () => undefined;
    }
    try {
      const req = mod.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => finishResponse(finish, res.statusCode, res.headers, Buffer.concat(chunks), t.scheme));
        res.on("error", (e) => failed(messageOf(e)));
      });
      if (t.scheme === "https") {
        req.on("socket", (s) => {
          s.on("secureConnect", () => {
            try {
              const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : null;
              const fp = String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase();
              if (!fp || fp !== t.pin) {
                // destroy BEFORE the request bytes go out: a wrong pin must not reach the helper
                req.destroy(
                  new Error(
                    "certificate pin mismatch (got " + (fp ? fp.slice(0, 16) : "none") + "..., pinned " + String(t.pin).slice(0, 16) + "...)"
                  )
                );
              }
            } catch (e) {
              req.destroy(new Error("pin check failed: " + messageOf(e)));
            }
          });
        });
      }
      req.on("error", (e) => failed(messageOf(e)));
      req.on("timeout", () => {
        req.destroy();
        failed("timeout after " + timeoutMs + "ms");
      });
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener(
          "abort",
          () => {
            try {
              req.destroy();
            } catch {
              /* already gone */
            }
            failed("aborted");
          },
          { once: true }
        );
      }
      req.end(payload || undefined);
    } catch (e) {
      failed(messageOf(e));
    }
  });
}

async function resolveHelperTransport(force) {
  const now = Date.now();
  if (!force && helperTransport.scheme && now - helperTransport.at < TRANSPORT_TTL_MS) return helperTransport;
  if (process.env.VDESK_HTTP_ONLY === "1") {
    helperTransport = { scheme: "http", pin: null, at: now, reason: "VDESK_HTTP_ONLY=1" };
    noteTransport(helperTransport);
    return helperTransport;
  }
  const pin = readCertPin();
  if (!pin) {
    helperTransport = { scheme: "http", pin: null, at: now, reason: "no helper-cert.sha256 yet -- plain http" };
    noteTransport(helperTransport);
    return helperTransport;
  }
  const probe = await rawHelperRequest({ scheme: "https", pin }, "GET", "/health", 2_500, undefined);
  if (probe.status > 0) {
    helperTransport = { scheme: "https", pin, at: now, reason: "pinned https" };
  } else if (/pin mismatch|pin check failed/i.test(String(probe.error))) {
    // a mismatch is not "the helper is on http": keep https, refuse, and always log it
    helperTransport = { scheme: "https", pin, at: now, reason: String(probe.error), refused: true };
  } else {
    helperTransport = {
      scheme: "http",
      pin: null,
      at: now,
      reason: "https probe failed (" + String(probe.error) + ") -> plain http",
    };
  }
  noteTransport(helperTransport);
  return helperTransport;
}

/** The 8790 path: pick a transport, send once, and re-probe on the next call after a failure. */
async function helperRequest(method, pathname, timeoutMs, signal, body, contentType) {
  const t = await resolveHelperTransport(false);
  const r = await rawHelperRequest(t, method, pathname, timeoutMs, signal, body, contentType);
  if (r.transportError) resetTransport("transport error: " + String(r.error));
  return r;
}

/**
 * One small GET/POST against a loopback service. Never throws and never rejects: every failure is
 * folded into the resolved object, because a tool that throws would surface as an uncaught host
 * error instead of the {ok:false,error} the model can act on. 8790 goes through helperRequest (so
 * it gets the token AND the pinned-HTTPS transport); 8791 is plain http by design.
 * P4: an optional body/content-type turns either path into a POST carrier (helper /input).
 */
function request(port, method, pathname, timeoutMs, signal, body, contentType) {
  if (port === HELPER_PORT) return helperRequest(method, pathname, timeoutMs, signal, body, contentType);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const failed = (error) =>
      finish({ ok: false, status: 0, contentType: "", body: Buffer.alloc(0), json: null, error });

    if (signal && signal.aborted) return failed("aborted");
    try {
      const req = http.request(
        {
          host: HOST,
          port,
          path: pathname,
          method,
          timeout: timeoutMs,
          headers: { accept: "application/json, image/*, */*" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => finishResponse(finish, res.statusCode, res.headers, Buffer.concat(chunks), "http"));
          res.on("error", (e) => failed(messageOf(e)));
        }
      );
      req.on("error", (e) => failed(messageOf(e)));
      req.on("timeout", () => {
        req.destroy();
        failed("timeout after " + timeoutMs + "ms");
      });
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener(
          "abort",
          () => {
            try {
              req.destroy();
            } catch {
              /* already gone */
            }
            failed("aborted");
          },
          { once: true }
        );
      }
      req.end();
    } catch (e) {
      failed(messageOf(e));
    }
  });
}

function jsonText(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** Every vdesk_* tool answers with free-form JSON, so one loose object schema is enough. */
function outputContract(description) {
  return {
    schema: { type: "object", description, additionalProperties: true },
    render: (_args, value) => jsonText(value),
  };
}

/** <=1 => normalised (0..1 of the current desktop), >1 => pixels -- same rule as vdesk-cli.mjs. */
function px(v, dim) {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n <= 1 ? Math.round(n * dim) : Math.round(n);
}

async function helperSize(signal) {
  const r = await request(HELPER_PORT, "GET", "/health", 8000, signal);
  if (r.json && Number.isFinite(r.json.width) && Number.isFinite(r.json.height)) {
    return { w: r.json.width, h: r.json.height };
  }
  return { w: 1280, h: 800 }; // helper down -> remember r.desktop may be approximate
}

const VK = {
  ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, meta: 91,
  enter: 13, return: 13, esc: 27, escape: 27, tab: 9, space: 32, backspace: 8, delete: 46,
  home: 36, end: 35, pageup: 33, pagedown: 34, up: 38, down: 40, left: 37, right: 39,
  insert: 45, capslock: 20, printscreen: 44,
};
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c).toLowerCase()] = c;
for (let d = 0; d <= 9; d++) VK[String(d)] = 48 + d;
for (let f = 1; f <= 12; f++) VK["f" + f] = 111 + f;
["+", "-", "=", ",", ".", "/", ";", "'", "[", "]", "\\", "`"].forEach((s, i) => {
  VK[s] = [187, 189, 187, 188, 190, 191, 186, 222, 219, 221, 220, 192][i];
});

function vksOf(combo) {
  return String(combo)
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (VK[s] === undefined) throw new Error("unknown key: " + s);
      return VK[s];
    });
}

let shotSeq = 0;
function shotPath(ext) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    "-" +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds()) +
    "-" +
    String(d.getMilliseconds()).padStart(3, "0") +
    "-" +
    String(shotSeq++).padStart(2, "0");
  return path.join(OUTDIR, "shot-" + stamp + "." + ext);
}

/** Read the real pixel size out of the PNG/JPEG header; null when the bytes are not a known image. */
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Grab one frame from the in-session helper and park it on disk (the model reads it back). */
async function doShot(opts, signal) {
  const format = opts && opts.format === "png" ? "png" : "jpg";
  const scale = opts && opts.scale !== undefined ? Number(opts.scale) : 0.75;
  const quality = opts && opts.quality !== undefined ? Number(opts.quality) : 75;
  const rect = opts && opts.rect ? "&rect=" + encodeURIComponent(String(opts.rect)) : "";
  const qs =
    "?format=" + format + "&scale=" + scale + "&quality=" + quality + rect;
  const t0 = Date.now();
  const r = await request(HELPER_PORT, "GET", "/screenshot" + qs, 30_000, signal);
  if (!r.ok || !r.body || r.body.length === 0) {
    return {
      ok: false,
      error: r.error || "screenshot failed (status " + r.status + ")",
      ms: Date.now() - t0,
    };
  }
  const file = shotPath(format === "png" ? "png" : "jpg");
  try {
    fs.writeFileSync(file, r.body);
  } catch (e) {
    return { ok: false, error: "cannot write screenshot: " + messageOf(e), ms: Date.now() - t0 };
  }
  const dim = imageSize(r.body);
  const desktop = await helperSize(signal);
  return {
    ok: true,
    path: file,
    bytes: r.body.length,
    kb: Math.round(r.body.length / 1024),
    ms: Date.now() - t0,
    format,
    scale,
    width: dim ? dim.width : Math.round(desktop.w * scale),
    height: dim ? dim.height : Math.round(desktop.h * scale),
  };
}

/** "act, then look at the result" -- input tools return a fresh frame unless after:false. */
async function afterShot(args, signal) {
  if (args && args.after === false) return {};
  try {
    return { screenshot: await doShot({}, signal) };
  } catch (e) {
    return { screenshot: { ok: false, error: messageOf(e) } };
  }
}

function helperOk(r) {
  return r.ok && !(r.json && r.json.ok === false);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };
    const t = setTimeout(finish, ms);
    if (signal) {
      if (signal.aborted) return finish();
      if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", finish, { once: true });
      }
    }
  });
}

/* ------------------------------------------------------------- P4 tool-surface helpers */

/** Stable fingerprint of one frame -- callers only compare it, never decode it. */
function frameHash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Number of differing bytes between two frames (+ any length difference). 0 == byte-identical. */
function frameDiffBytes(a, b) {
  const n = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;
  return diff;
}

const CLIPBOARD_LIMIT = 4000;

/** GET /clipboard, normalised to {ok,text,chars,truncated} (text capped at CLIPBOARD_LIMIT). */
async function clipboardGet(signal) {
  const r = await request(HELPER_PORT, "GET", "/clipboard?action=get", 15_000, signal);
  if (r.unauthorized) return { ok: false, error: UNAUTHORIZED_TEXT, unauthorized: true };
  if (!helperOk(r) || !r.json) {
    return {
      ok: false,
      error: (r.json && r.json.error) || r.error || "helper clipboard get failed (status " + r.status + ")",
    };
  }
  const full = r.json.text === undefined || r.json.text === null ? "" : String(r.json.text);
  const truncated = full.length > CLIPBOARD_LIMIT;
  return { ok: true, text: truncated ? full.slice(0, CLIPBOARD_LIMIT) : full, chars: full.length, truncated };
}

/** SET /clipboard; text is UTF-8 escaped exactly like the clipboard path of vdesk_type. */
async function clipboardSet(text, signal) {
  const s = text === undefined || text === null ? "" : String(text);
  const r = await request(HELPER_PORT, "GET", "/clipboard?action=set&text=" + encodeURIComponent(s), 15_000, signal);
  if (r.unauthorized) return { ok: false, error: UNAUTHORIZED_TEXT, unauthorized: true, chars: s.length };
  if (!helperOk(r)) {
    return {
      ok: false,
      error: (r.json && r.json.error) || r.error || "helper clipboard set failed (status " + r.status + ")",
      chars: s.length,
    };
  }
  return { ok: true, chars: s.length };
}

/**
 * P4: one batched input request on T1's frozen contract -- POST /input {"events":[...]} answers
 * {ok:true,count,ms} or {ok:false,index,error}. The contract also allows GET
 * /input?events=<urlencoded json>; that form is used only when the POST route answers 404/405, and
 * an old helper (neither form) still ends in {ok:false,error} -- never a pretend success.
 */
async function inputEvents(events, signal) {
  const payload = JSON.stringify({ events });
  const post = await request(HELPER_PORT, "POST", "/input", 20_000, signal, payload, "application/json; charset=utf-8");
  const postRouteMissing = post.status === 404 || post.status === 405;
  const r = postRouteMissing
    ? await request(HELPER_PORT, "GET", "/input?events=" + encodeURIComponent(payload), 20_000, signal)
    : post;
  if (r.unauthorized) return { ok: false, error: UNAUTHORIZED_TEXT, unauthorized: true, preInput: postRouteMissing };
  // both the POST and the GET form answered 404/405 -> this really is a pre-P4 helper
  if (postRouteMissing && (r.status === 404 || r.status === 405)) {
    return {
      ok: false,
      error: "helper has no /input route (pre-P4 build): the single-request input channel is unavailable",
      preInput: true,
    };
  }
  if (r.json && r.json.ok === false) {
    return { ok: false, error: String(r.json.error || "input event failed"), index: r.json.index, helper: r.json };
  }
  if (!r.ok || !r.json) {
    return {
      ok: false,
      error: r.error || "helper /input failed (status " + r.status + ")",
      ...(postRouteMissing ? { preInput: true } : {}),
    };
  }
  return { ...r.json, ok: true };
}

/**
 * P4: poll helper /screenshot until `samples` consecutive frames differ by <= maxDiffBytes each, or
 * the timeout expires. Returns {ok,stable,attempts,elapsedMs,bytes,lastHash,timedOut} and is honest
 * about a timeout (ok:false + error) instead of reporting a settle that never happened.
 */
async function waitStable(args, signal) {
  const a = args || {};
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
  const timeoutMs = Math.min(Math.round(num(a.timeoutMs, 30_000)), 600_000);
  const intervalMs = Math.min(Math.round(num(a.intervalMs, 400)), 60_000);
  const samples = Math.min(Math.max(Math.round(num(a.samples, 3)), 1), 60);
  const maxDiffBytes = Number.isFinite(Number(a.maxDiffBytes)) && Number(a.maxDiffBytes) >= 0 ? Math.round(Number(a.maxDiffBytes)) : 0;
  const t0 = Date.now();
  let attempts = 0;
  let chain = 0;
  let prev = null;
  let lastBytes = 0;
  let lastHash = null;
  let lastDiffBytes = null;
  for (;;) {
    const r = await request(HELPER_PORT, "GET", "/screenshot?format=jpg&quality=40&scale=0.35&cursor=0", 30_000, signal);
    if (!r.ok || !r.body || r.body.length === 0) {
      return {
        ok: false,
        stable: false,
        attempts,
        elapsedMs: Date.now() - t0,
        bytes: lastBytes,
        lastHash,
        timedOut: false,
        error: r.error || "helper screenshot failed (status " + r.status + ")",
      };
    }
    attempts++;
    lastBytes = r.body.length;
    lastHash = frameHash(r.body);
    if (prev && frameDiffBytes(prev, r.body) <= maxDiffBytes) chain++;
    else chain = 1;
    lastDiffBytes = prev ? frameDiffBytes(prev, r.body) : null;
    prev = r.body;
    if (chain >= samples) {
      return { ok: true, stable: true, attempts, elapsedMs: Date.now() - t0, bytes: lastBytes, lastHash, timedOut: false, lastDiffBytes };
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= timeoutMs) {
      return {
        ok: false,
        stable: false,
        attempts,
        elapsedMs: elapsed,
        bytes: lastBytes,
        lastHash,
        timedOut: true,
        lastDiffBytes,
        error: "screen did not stabilize (" + samples + " frames within " + maxDiffBytes + " bytes) in " + timeoutMs + "ms",
      };
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)), signal);
    if (signal && signal.aborted) {
      return { ok: false, stable: false, attempts, elapsedMs: Date.now() - t0, bytes: lastBytes, lastHash, timedOut: false, error: "aborted" };
    }
  }
}

async function control(action, args, signal) {
  let pathname = "/vdesk/" + action;
  const minutes = args && Number(args.minutes);
  // the monitor runs start/stop/restart without a duration argument; forward it anyway so a future
  // monitor revision can honour it without a plugin change.
  if (Number.isFinite(minutes) && action !== "stop") {
    pathname += "?minutes=" + Math.round(minutes);
  }
  // P3-C: the user's explicit risk acceptance travels with the start request
  if (action === "start" && args && args.force === true) {
    pathname += pathname.includes("?") ? "&force=1" : "?force=1";
  }
  const r = await request(MONITOR_PORT, "POST", pathname, 20_000, signal);
  if (r.json) return r.json;
  return { ok: false, error: r.error || "monitor not answering (status " + r.status + ")" };
}

/* ---------------------------------------------------- singleton conflict (P3-C) */

const SINGLETON_ADVICE =
  "这些程序是机器级单例，子会话会再起一份并与真机抢单例导致双崩。请先退出它们再启动；或确认接受风险后用 force=true 继续。";

/** Read-only probe (the monitor runs `vdesk.ps1 probe`); never starts anything. */
async function conflictProbe(signal) {
  const r = await request(MONITOR_PORT, "GET", "/vdesk/conflict", 25_000, signal);
  return r.json || null;
}


/* ------------------------------------------------------------------ resolution (P2-A) */

/** Remember the target size that the NEXT `vdesk.ps1 start` should use. */
function writeDesiredResolution(width, height) {
  try {
    fs.mkdirSync(path.dirname(DESIRED_RES_FILE), { recursive: true });
    fs.writeFileSync(
      DESIRED_RES_FILE,
      JSON.stringify({ width, height, ts: new Date().toISOString() }) + "\n"
    );
    return true;
  } catch (e) {
    log("desired-resolution write failed: " + messageOf(e));
    return false;
  }
}

/* ------------------------------------------------------------------ task runner (P1) */

// Meta tools manage the task itself and must never be journalled as steps of it.
const META_TOOLS = new Set(["vdesk_status", "vdesk_task", "vdesk_task_end", "vdesk_keepalive"]);

const taskState = {
  current: null, // { taskId, goal, planned, startedAt, startedMs, steps, failed }
  lastActionMs: 0, // newest action of any kind -- this is the idle-reclaim clock
  keepalive: false, // user-held session: suppresses auto-destroy and idle reclaim
};

function newTaskId() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    "-" +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds());
  return "t-" + stamp + "-" + Math.random().toString(36).slice(2, 8);
}

function taskFile(taskId) {
  return path.join(TASKS_DIR, taskId + ".jsonl");
}

/** One JSON object per line, appended: the monitor reads the newest file, the panel shows a tail. */
function appendTaskLine(taskId, obj) {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.appendFileSync(taskFile(taskId), JSON.stringify(obj) + "\n");
    return true;
  } catch (e) {
    log("task journal write failed: " + messageOf(e));
    return false;
  }
}

/** Journal args must stay JSON-lossless and short (typing text can be long or user content). */
function shortValue(v, depth = 0) {
  if (typeof v === "string") return v.length > 160 ? v.slice(0, 157) + "..." : v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= 3) return String(v);
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => shortValue(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 20)) out[k] = shortValue(v[k], depth + 1);
    return out;
  }
  return String(v);
}

/** One journal line per action call; also moves the idle clock. No open task == no step written. */
function recordStep(name, args, result, ms) {
  const now = Date.now();
  taskState.lastActionMs = now;
  const t = taskState.current;
  if (!t) return;
  const ok = !(result && result.ok === false);
  // an input tool reports its after-screenshot under result.screenshot; vdesk_screenshot reports
  // the frame it just saved under result.path -- journal either one as the step's image.
  const direct = result && typeof result.path === "string" ? result.path : undefined;
  const shot =
    result && result.screenshot && typeof result.screenshot === "object" && result.screenshot.path
      ? result.screenshot.path
      : direct;
  const step = {
    type: "step",
    n: t.steps.length + 1,
    tool: name,
    args: shortValue(args || {}),
    ok,
    ms,
    ts: new Date(now).toISOString(),
  };
  if (shot) step.screenshot = shot;
  if (!ok) step.error = String((result && (result.error || result.clipboardError)) || "failed");
  t.steps.push(step);
  if (!ok) t.failed += 1;
  appendTaskLine(t.taskId, step);
}

/** Wrap action tools so every call is timed, journalled, and cannot throw out of the tool. */
function recordIfAction(def) {
  if (META_TOOLS.has(def.name)) return def;
  const inner = def.execute;
  return {
    ...def,
    async execute(args, exec) {
      const t0 = Date.now();
      let result;
      try {
        result = await inner(args, exec);
      } catch (e) {
        result = { ok: false, error: messageOf(e) };
      }
      try {
        recordStep(def.name, args, result, Date.now() - t0);
      } catch (e) {
        log("task step write failed: " + messageOf(e));
      }
      return result;
    },
  };
}

function startTask(args) {
  const a = args || {};
  // one child-session slot => one task; an unfinished task is closed by the newer one
  if (taskState.current) endTask({ ok: false, note: "superseded by a newer task" });
  const now = Date.now();
  const task = {
    taskId: newTaskId(),
    goal: a.goal === undefined ? "" : String(a.goal),
    planned: Array.isArray(a.steps) ? a.steps.map((s) => String(s)) : [],
    startedAt: new Date(now).toISOString(),
    startedMs: now,
    steps: [],
    failed: 0,
  };
  taskState.current = task;
  taskState.lastActionMs = now;
  appendTaskLine(task.taskId, {
    type: "task",
    taskId: task.taskId,
    goal: task.goal,
    planned: task.planned,
    startedAt: task.startedAt,
    ts: new Date(now).toISOString(),
  });
  log("task start " + task.taskId + ": " + task.goal);
  return task;
}

/** Write the summary line and clear the current task. Never stops the session (the caller decides). */
function endTask(args) {
  const t = taskState.current;
  if (!t) return null;
  const endedMs = Date.now();
  const ok = args && args.ok !== undefined ? args.ok === true : t.failed === 0;
  const summary = {
    type: "summary",
    taskId: t.taskId,
    ok,
    total: t.steps.length,
    failed: t.failed,
    startedAt: t.startedAt,
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - t.startedMs,
  };
  if (args && args.note !== undefined) summary.note = String(args.note);
  const written = appendTaskLine(t.taskId, summary);
  taskState.current = null;
  log("task end " + t.taskId + " ok=" + ok + " steps=" + summary.total + " failed=" + summary.failed);
  return {
    taskId: t.taskId,
    ok,
    total: summary.total,
    failed: summary.failed,
    durationMs: summary.durationMs,
    journal: taskFile(t.taskId),
    summaryWritten: written,
  };
}

/** 空闲回收: no open task and nothing touched for IDLE_MS -> stop the child session (destroys it). */
async function idleCheck() {
  if (taskState.keepalive || taskState.current) return;
  const idleMs = Number(process.env.VDESK_IDLE_MS || IDLE_MS);
  const last = taskState.lastActionMs;
  if (!last || Date.now() - last < idleMs) return;
  const st = await request(MONITOR_PORT, "GET", "/vdesk/status", 8000, undefined);
  const holding = !!(st.json && st.json.keeper && st.json.keeper.phase === "holding");
  if (!holding) {
    taskState.lastActionMs = 0; // nothing to reclaim
    return;
  }
  log("空闲回收 idle reclaim: idle " + Math.round((Date.now() - last) / 1000) + "s, no task -> stop");
  const r = await control("stop", {}, undefined);
  taskState.lastActionMs = 0;
  log("空闲回收 stop dispatched: " + JSON.stringify(r));
}

function startLifecycle() {
  const timer = setInterval(() => {
    idleCheck().catch((e) => log("idle check failed: " + messageOf(e)));
  }, IDLE_CHECK_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ tool definitions */

const SAFETY =
  "This consumes the machine-wide single child-session slot; if the Doubao virtual desktop is " +
  "already running, start is refused by the safety valve (it never hijacks a foreign session).";

const SAFETY_ZH = "会占用整机唯一的子会话名额；若豆包虚拟桌面正在运行，start 会被安全阀拒绝。";

const coords =
  "Coordinates: values <= 1 are NORMALISED (0..1 of the current desktop); values > 1 are pixels.";

function numberParam(description) {
  return { type: "number", description };
}
function intParam(description) {
  return { type: "integer", description };
}
function toolObject(description) {
  return { type: "object", description, additionalProperties: false };
}
const AFTER = {
  type: "boolean",
  description: "Take a fresh screenshot after the action and return it (default true; false skips it).",
};

function buildTools() {
  return [
    {
      name: "vdesk_status",
      description:
        "Report the child-session virtual desktop panel service (127.0.0.1:8791) state: running, " +
        "sessionId, uptime, windowed, helper. Read-only and cheap; call it before any other vdesk_*. " +
        SAFETY + " " + SAFETY_ZH,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: outputContract("vdesk status JSON"),
      async execute(_args, exec) {
        const r = await request(MONITOR_PORT, "GET", "/vdesk/status", 8000, exec && exec.signal);
        if (r.json) return r.json;
        return { ok: false, error: r.error || "monitor not answering (status " + r.status + ")" };
      },
    },
    {
      name: "vdesk_start",
      description:
        "Start the child-session virtual desktop (the machine-wide single slot) and open its " +
        "monitor window. P3-C: this first runs a READ-ONLY probe for machine-wide singleton " +
        "programs (out\\singleton-watchlist.txt, default the Tencent desktop-organizer family): if " +
        "any is running it REFUSES with {ok:false,error:'singleton-conflict',found:[...]} because " +
        "the child session's own copy fights the real one and has crashed the user's desktop twice. " +
        "Only pass force:true after the user accepts that risk (the result is then marked forced). " +
        SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          minutes: intParam("Session lifetime hint in minutes (default 240)."),
          force: {
            type: "boolean",
            description:
              "true = start even though a watched singleton program is running (loud warning; " +
              "marked in status/journal). Default false = refuse.",
          },
        },
        additionalProperties: false,
      },
      output: outputContract("vdesk start result"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const force = !!(args && args.force === true);
        const conflict = await conflictProbe(signal);
        const found = conflict && Array.isArray(conflict.found) ? conflict.found : [];
        if (found.length > 0 && !force) {
          log("start refused: singleton conflict (" + found.length + " programs running)");
          return { ok: false, error: "singleton-conflict", found, advice: SINGLETON_ADVICE };
        }
        if (found.length > 0 && force) {
          log(
            "!!! FORCED start despite singleton conflict: " +
              found.map((f) => f.name + "(pid " + f.pid + ", sess " + f.session + ")").join(", ")
          );
          // the task journal must show that this start was the forced one
          if (taskState.current) {
            appendTaskLine(taskState.current.taskId, {
              type: "note",
              kind: "forced-start",
              found,
              ts: new Date().toISOString(),
            });
          }
        }
        const out = await control("start", { ...(args || {}), force }, signal);
        return found.length > 0 ? { ...out, forced: true, conflict: { checkedAt: conflict && conflict.checkedAt, found } } : out;
      },
    },
    {
      name: "vdesk_stop",
      description:
        "Stop (and destroy) the child-session virtual desktop. Safe to call when it is already " +
        "stopped. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: { minutes: intParam("Ignored by stop; accepted for symmetry with start.") },
        additionalProperties: false,
      },
      output: outputContract("vdesk stop result"),
      async execute(args, exec) {
        return control("stop", args || {}, exec && exec.signal);
      },
    },
    {
      name: "vdesk_restart",
      description:
        "Restart the child-session virtual desktop (stop then start). " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: { minutes: intParam("Session lifetime hint in minutes (default 240).") },
        additionalProperties: false,
      },
      output: outputContract("vdesk restart result"),
      async execute(args, exec) {
        return control("restart", args || {}, exec && exec.signal);
      },
    },
    {
      name: "vdesk_screenshot",
      description:
        "Capture the child-session desktop and WRITE the image to disk; the result carries {ok, " +
        "path, kb, ms, width, height}. Read that path back with read_image to actually look at the " +
        "frame (P0 deliberately returns a path instead of inlining base64). " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["png", "jpg"], description: "Image format (default jpg)." },
          scale: numberParam("Downscale factor 0.1..1 (default 0.75); a smaller frame is faster."),
          quality: intParam("JPEG quality 1..100 (default 75); ignored for png."),
          rect: { type: "string", description: "Optional capture rect \"x,y,w,h\" in desktop pixels." },
        },
        additionalProperties: false,
      },
      output: outputContract("screenshot metadata incl. the on-disk path"),
      async execute(args, exec) {
        return doShot(args || {}, exec && exec.signal);
      },
    },
    {
      name: "vdesk_click",
      description:
        "Click a point on the child-session desktop. " + coords + " Takes a screenshot afterwards " +
        "by default so you can verify the effect. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          x: numberParam("X: <=1 normalised 0..1, >1 pixels."),
          y: numberParam("Y: <=1 normalised 0..1, >1 pixels."),
          button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)." },
          count: intParam("Click count (2 = double click; default 1)."),
          after: AFTER,
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      output: outputContract("click result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const dim = await helperSize(signal);
        const x = px(args.x, dim.w);
        const y = px(args.y, dim.h);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y must be numbers" };
        const button = ["left", "right", "middle"].includes(args.button) ? args.button : "left";
        const count = Number.isFinite(Number(args.count)) ? Math.round(Number(args.count)) : 1;
        const t0 = Date.now();
        const r = await request(
          HELPER_PORT,
          "GET",
          "/mouse?action=click&x=" + x + "&y=" + y + "&button=" + button + "&count=" + count,
          15_000,
          signal
        );
        return {
          ok: helperOk(r),
          x,
          y,
          button,
          count,
          ms: Date.now() - t0,
          ...(r.json ? { helper: r.json } : {}),
          ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_move",
      description:
        "Move the mouse pointer on the child-session desktop (no click). " + coords + " " +
        SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          x: numberParam("X: <=1 normalised 0..1, >1 pixels."),
          y: numberParam("Y: <=1 normalised 0..1, >1 pixels."),
          after: AFTER,
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      output: outputContract("move result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const dim = await helperSize(signal);
        const x = px(args.x, dim.w);
        const y = px(args.y, dim.h);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y must be numbers" };
        const r = await request(HELPER_PORT, "GET", "/mouse?action=move&x=" + x + "&y=" + y, 15_000, signal);
        return {
          ok: helperOk(r),
          x,
          y,
          ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_drag",
      description:
        "Drag on the child-session desktop from (x1,y1) to (x2,y2), e.g. to select text or move a " +
        "window. " + coords + " " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          x1: numberParam("Start X: <=1 normalised, >1 pixels."),
          y1: numberParam("Start Y: <=1 normalised, >1 pixels."),
          x2: numberParam("End X: <=1 normalised, >1 pixels."),
          y2: numberParam("End Y: <=1 normalised, >1 pixels."),
          after: AFTER,
        },
        required: ["x1", "y1", "x2", "y2"],
        additionalProperties: false,
      },
      output: outputContract("drag result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const dim = await helperSize(signal);
        const x1 = px(args.x1, dim.w);
        const y1 = px(args.y1, dim.h);
        const x2 = px(args.x2, dim.w);
        const y2 = px(args.y2, dim.h);
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
          return { ok: false, error: "x1, y1, x2 and y2 must be numbers" };
        }
        const r = await request(
          HELPER_PORT,
          "GET",
          "/mouse?action=drag&x=" + x1 + "&y=" + y1 + "&x2=" + x2 + "&y2=" + y2,
          20_000,
          signal
        );
        return {
          ok: helperOk(r),
          from: [x1, y1],
          to: [x2, y2],
          ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_scroll",
      description:
        "Scroll the wheel at a point on the child-session desktop (delta > 0 scrolls down). " +
        coords + " " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          x: numberParam("X: <=1 normalised 0..1, >1 pixels."),
          y: numberParam("Y: <=1 normalised 0..1, >1 pixels."),
          delta: intParam("Wheel delta, positive = down (default 480)."),
          after: AFTER,
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      output: outputContract("scroll result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const dim = await helperSize(signal);
        const x = px(args.x, dim.w);
        const y = px(args.y, dim.h);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y must be numbers" };
        const delta = Number.isFinite(Number(args.delta)) ? Math.round(Number(args.delta)) : 480;
        const r = await request(
          HELPER_PORT,
          "GET",
          "/mouse?action=scroll&x=" + x + "&y=" + y + "&delta=" + delta,
          15_000,
          signal
        );
        return {
          ok: helperOk(r),
          x,
          y,
          delta,
          ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_key",
      description:
        "Press a key or key chord in the child-session desktop, e.g. \"ctrl+s\", \"alt+tab\", " +
        "\"enter\", \"f5\", \"win+r\". The ASCII combo is mapped to Windows VK codes here and sent " +
        "as one chord. action:down / action:up instead press-and-hold or release exactly ONE key " +
        "through the helper's single-request input channel (POST /input) -- that is how a chord is " +
        "held across several calls, e.g. action:down \"shift\", clicks, then action:up \"shift\"; an " +
        "older helper without /input reports {ok:false,error} and never pretends to have done it. " +
        SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          combo: { type: "string", description: "Key or chord, parts joined with '+', e.g. \"ctrl+shift+s\"." },
          action: {
            type: "string",
            enum: ["combo", "down", "up"],
            description:
              "combo (default) = tap the whole chord; down = press one key and leave it down; " +
              "up = release one key. down/up need a single-key combo and go through POST /input.",
          },
          after: AFTER,
        },
        required: ["combo"],
        additionalProperties: false,
      },
      output: outputContract("key result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        let vks;
        try {
          vks = vksOf(args.combo);
        } catch (e) {
          return { ok: false, combo: args.combo, error: messageOf(e) };
        }
        if (vks.length === 0) return { ok: false, combo: args.combo, error: "empty key combo" };
        const action = args.action === "down" || args.action === "up" ? args.action : "combo";
        if (action !== "combo") {
          if (vks.length !== 1) {
            return {
              ok: false,
              combo: args.combo,
              vks,
              action,
              error: "action:" + action + " needs exactly one key (got " + vks.length + ")",
            };
          }
          const inRes = await inputEvents([{ type: "key", vk: vks[0], down: action === "down" }], signal);
          return {
            combo: args.combo,
            vks,
            action,
            vk: vks[0],
            ...inRes,
            ...(await afterShot(args, signal)),
          };
        }
        const r = await request(
          HELPER_PORT,
          "GET",
          "/key?action=combo&vks=" + vks.join(","),
          15_000,
          signal
        );
        return {
          ok: helperOk(r),
          combo: args.combo,
          action: "combo",
          vks,
          ...(r.json ? { helper: r.json } : {}),
          ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_type",
      description:
        "Type text into the focused window of the child-session desktop. Default (via:auto) pastes " +
        "through the helper clipboard + Ctrl+V, which is exact for ASCII and Chinese alike; " +
        "per-character SendInput is unreliable in some controls (the Run dialog drops/reorders " +
        "characters), so it is only the fallback when the clipboard route is unavailable. The " +
        "returned `via` always names the path that actually ran. via:sendinput forces per-character " +
        "injection, via:clipboard forces the clipboard. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type." },
          via: {
            type: "string",
            enum: ["auto", "clipboard", "sendinput"],
            description:
              "auto (default) = clipboard + Ctrl+V, falling back to SendInput; clipboard = clipboard " +
              "only; sendinput = per-character injection only.",
          },
          after: AFTER,
        },
        required: ["text"],
        additionalProperties: false,
      },
      output: outputContract("type result + optional screenshot"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const text = args.text === undefined || args.text === null ? "" : String(args.text);
        const via = ["auto", "clipboard", "sendinput"].includes(args.via) ? args.via : "auto";

        // Per-character injection; fast for ASCII, but the Run dialog's AutoComplete drops/reorders
        // keys, so it is never the default.
        const sendinput = async () => {
          const r = await request(
            HELPER_PORT,
            "GET",
            "/key?action=text&text=" + encodeURIComponent(text),
            30_000,
            signal
          );
          return {
            ok: helperOk(r),
            via: "sendinput",
            chars: text.length,
            ...(r.json ? { helper: r.json } : {}),
            ...(r.ok ? {} : { error: r.error || "helper returned " + r.status }),
          };
        };

        // Clipboard + Ctrl+V: exact for any text (ASCII and CJK), the default since P0.5.
        const clipboard = async () => {
          const set = await request(
            HELPER_PORT,
            "GET",
            "/clipboard?action=set&text=" + encodeURIComponent(text),
            15_000,
            signal
          );
          if (!helperOk(set)) {
            return {
              ok: false,
              via: "clipboard",
              chars: text.length,
              error: set.unauthorized ? UNAUTHORIZED_TEXT : "helper clipboard route unavailable or failed",
              detail: set.json || set.error || set.status,
            };
          }
          const paste = await request(
            HELPER_PORT,
            "GET",
            "/key?action=combo&vks=" + vksOf("ctrl+v").join(","),
            15_000,
            signal
          );
          if (!helperOk(paste)) {
            return {
              ok: false,
              via: "clipboard",
              chars: text.length,
              error: paste.unauthorized ? UNAUTHORIZED_TEXT : "Ctrl+V paste failed",
              detail: paste.json || paste.error || paste.status,
            };
          }
          return { ok: true, via: "clipboard+ctrl+v", chars: text.length, set: set.json || { ok: true } };
        };

        if (via === "sendinput") {
          return { ...(await sendinput()), ...(await afterShot(args, signal)) };
        }
        const clip = await clipboard();
        // Explicit via:clipboard stays strict; auto degrades so an older helper build still types.
        if (clip.ok || via === "clipboard") {
          return { ...clip, ...(await afterShot(args, signal)) };
        }
        const fb = await sendinput();
        return {
          ...fb,
          via: "sendinput(fallback)",
          requestedVia: "auto",
          fallback: true,
          ...(clip.error !== undefined ? { clipboardError: clip.error } : {}),
          ...(clip.detail !== undefined ? { clipboardDetail: clip.detail } : {}),
          ...(await afterShot(args, signal)),
        };
      },
    },
    {
      name: "vdesk_wait",
      description:
        "Wait for the child-session desktop to settle before the next screenshot. Default ({ms}) " +
        "only sleeps and does not touch the guest (capped at 600000). stable:true instead polls the " +
        "helper for small frames and returns as soon as `samples` consecutive frames differ by no " +
        "more than maxDiffBytes -- the honest way to wait for an app to finish painting. Returns " +
        "{ok,stable,attempts,elapsedMs,bytes,lastHash,timedOut}; a screen that never settles comes " +
        "back ok:false + timedOut:true, never a fabricated settle. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          ms: intParam("Milliseconds to wait, non-stable mode (capped at 600000)."),
          stable: {
            type: "boolean",
            description: "true = poll until the picture stops changing instead of sleeping a fixed time.",
          },
          timeoutMs: intParam("stable mode: give up after this many ms (default 30000, capped at 600000)."),
          intervalMs: intParam("stable mode: delay between frames in ms (default 400)."),
          samples: intParam("stable mode: consecutive near-identical frames required (default 3)."),
          maxDiffBytes: intParam("stable mode: max differing bytes between consecutive frames (default 0 = identical)."),
        },
        additionalProperties: false,
      },
      output: outputContract("wait result (fixed sleep or stability report)"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        if (args && args.stable === true) return waitStable(args, signal);
        const raw = Number(args && args.ms);
        const ms = Number.isFinite(raw) ? Math.max(0, Math.min(Math.round(raw), 600_000)) : 0;
        await sleep(ms, signal);
        return { ok: true, waitedMs: ms };
      },
    },
    {
      name: "vdesk_task",
      description:
        "Declare the work on the child-session desktop as a TASK: every following vdesk_* action " +
        "call is then journalled as a step (tool, args, ok/failed, ms, screenshot path) to " +
        "out\\tasks\\<taskId>.jsonl, which the sidebar panel reads. Only one task is open at a time; " +
        "starting a new one closes the previous as failed. Finish with vdesk_task_end (which also " +
        "destroys the session). " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What this task is trying to achieve, one line." },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Optional plan shown in the panel.",
          },
        },
        required: ["goal"],
        additionalProperties: false,
      },
      output: outputContract("task start result"),
      async execute(args) {
        const t = startTask(args || {});
        return {
          ok: true,
          taskId: t.taskId,
          startedAt: t.startedAt,
          goal: t.goal,
          planned: t.planned,
          journal: taskFile(t.taskId),
        };
      },
    },
    {
      name: "vdesk_task_end",
      description:
        "Close the current task: append its summary line (ok / failed / total / durationMs) to the " +
        "journal and then DESTROY the child session by default (POST /vdesk/stop -> logoff, the " +
        "user's chosen policy) unless vdesk_keepalive is on. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Guard: when given, must match the open task id." },
          ok: { type: "boolean", description: "Task verdict (default: true when no step failed)." },
          note: { type: "string", description: "Free-text note stored in the summary line." },
        },
        additionalProperties: false,
      },
      output: outputContract("task end result incl. whether stop was dispatched"),
      async execute(args, exec) {
        const t = taskState.current;
        if (!t) return { ok: false, error: "no active task", hint: "call vdesk_task first" };
        if (args && args.taskId !== undefined && String(args.taskId) !== t.taskId) {
          return { ok: false, error: "taskId mismatch", activeTaskId: t.taskId };
        }
        const summary = endTask(args || {});
        if (taskState.keepalive) {
          log("task end: keepalive on -> session NOT destroyed");
          return { ok: true, ...summary, keepalive: true, destroyed: false };
        }
        // 用户 2026-10-02 拍板：任务结束 = 注销子会话（不是断开）
        const stop = await control("stop", {}, exec && exec.signal);
        const destroyed = !!(stop && stop.ok !== false);
        log("task end: stop dispatched destroyed=" + destroyed);
        return { ok: true, ...summary, destroyed, stop };
      },
    },
    {
      name: "vdesk_keepalive",
      description:
        "Hold the child session on purpose: on:true suppresses BOTH auto-destroy at task end and " +
        "the 10-minute idle reclaim, so the session survives until you stop it yourself (on:false " +
        "restores the normal lifecycle). " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: { on: { type: "boolean", description: "true = keep the session alive." } },
        required: ["on"],
        additionalProperties: false,
      },
      output: outputContract("keepalive state"),
      async execute(args) {
        taskState.keepalive = args.on === true;
        log("keepalive " + (taskState.keepalive ? "ON (auto-destroy + idle reclaim suppressed)" : "off"));
        return {
          ok: true,
          keepalive: taskState.keepalive,
          note: taskState.keepalive
            ? "auto-destroy and idle reclaim are suppressed until vdesk_keepalive on:false"
            : "normal lifecycle (destroy at task end, idle reclaim after 10 min)",
        };
      },
    },
    {
      name: "vdesk_apps",
      description:
        "List or launch applications INSIDE the child session (helper GET /apps, authenticated). " +
        "action:list returns the helper's JSON verbatim: {ok,count,apps:[{name,target,source}]} " +
        "(max 200; sources startmenu/apppaths/appx -- on Windows 11 记事本 exists only in appx). " +
        "action:launch {name} starts it in that session and returns the helper's JSON verbatim: " +
        "{ok,matched,pid,source}, {ok:false,error:'no-match',candidates} when nothing matched, or " +
        "{ok:false,error:'blocked-by-policy'} for doubao/豆包 targets -- that policy is passed " +
        "through UNCHANGED, the host never overrides or retries around it. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "launch"], description: "list = enumerate, launch = start by name." },
          name: { type: "string", description: "launch only: app name (exact match, then case-insensitive contains)." },
          limit: { type: "integer", description: "list only: trim the returned array (the helper already caps at 200)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: outputContract("helper /apps JSON, passed through"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const action = args.action === "launch" ? "launch" : "list";
        let pathQuery = "/apps?action=" + action;
        if (action === "launch") {
          const name = args.name === undefined || args.name === null ? "" : String(args.name);
          pathQuery += "&name=" + encodeURIComponent(name);
        }
        const r = await request(HELPER_PORT, "GET", pathQuery, 30_000, signal);
        if (!r.json) {
          return { ok: false, error: r.error || "helper /apps failed (status " + r.status + ")" };
        }
        const out = r.json;
        if (action === "list" && Number.isFinite(Number(args.limit)) && Array.isArray(out.apps)) {
          const lim = Math.max(0, Math.round(Number(args.limit)));
          return { ...out, apps: out.apps.slice(0, lim) };
        }
        return out;
      },
    },
    {
      name: "vdesk_resolution",
      description:
        "Change the child-session desktop resolution. RDP fixes the desktop size when the connection " +
        "is made, so this REMEMBERS the target in out\\desired-resolution.json and then RESTARTS the " +
        "session (vdesk.ps1 start reads that file when -Width/-Height are not given). Returns " +
        "{ok, width, height, restarted}; the rebuild takes about a minute. 1920x1080 is 2.3x the " +
        "pixels of 1280x800, so prefer format:jpg and/or a smaller scale for screenshots. " +
        SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          width: intParam("Desktop width in pixels (320..4096); 1920 matches the Doubao default."),
          height: intParam("Desktop height in pixels (240..4096); 1080 matches the Doubao default."),
        },
        required: ["width", "height"],
        additionalProperties: false,
      },
      output: outputContract("resolution change + restart dispatch"),
      async execute(args, exec) {
        const width = Math.round(Number(args.width));
        const height = Math.round(Number(args.height));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || width > 4096 || height < 240 || height > 4096) {
          return { ok: false, error: "width/height out of range (320..4096 x 240..4096)", width, height };
        }
        if (!writeDesiredResolution(width, height)) {
          return { ok: false, error: "cannot write " + DESIRED_RES_FILE, width, height };
        }
        // the desktop size is a property of the RDP connection -> only a rebuilt session can change it
        const restart = await control("restart", {}, exec && exec.signal);
        const dispatched = !!(restart && restart.ok !== false);
        log("resolution -> " + width + "x" + height + " restart dispatched=" + dispatched);
        return { ok: dispatched, width, height, restarted: dispatched, desired: DESIRED_RES_FILE, restart };
      },
    },
    {
      name: "vdesk_clipboard",
      description:
        "Read or replace the child session's clipboard (helper /clipboard, CF_UNICODETEXT only). " +
        "action:get returns {ok,text,chars,truncated}: text is UTF-8 and is CUT at 4000 characters, " +
        "chars is the clipboard's full character count, truncated marks the cut. action:set stores " +
        "`text` (UTF-8 escaped on the wire, so Chinese and emoji are exact) and returns {ok,chars}; " +
        "it pairs with vdesk_key action:combo \"ctrl+v\" to paste the same text without the " +
        "per-character SendInput path. " + SAFETY + " " + SAFETY_ZH,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set"], description: "get = read it, set = replace it." },
          text: {
            type: "string",
            description: "set only: the text to place on the clipboard (empty string clears it).",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: outputContract("clipboard get {ok,text,chars,truncated} or set {ok,chars}"),
      async execute(args, exec) {
        const signal = exec && exec.signal;
        const action = args && args.action === "set" ? "set" : "get";
        if (action === "set") return clipboardSet(args && args.text, signal);
        return clipboardGet(signal);
      },
    },
  ];
}

/** Register every tool; a duplicate name (HMR) must not take the keep-alive down with it. */
function registerTools(ctx) {
  const tools = buildTools();
  let ok = 0;
  for (const def of tools) {
    try {
      ctx.tools.register(recordIfAction(def));
      ok++;
    } catch (e) {
      log("tool register failed for " + def.name + ": " + messageOf(e));
    }
  }
  log("registered " + ok + "/" + tools.length + " vdesk tools");
  return ok;
}

/* ------------------------------------------------------------------ plugin entry */

export const inject = ["tools"];

export function apply(ctx) {
  const context = ctx || {};
  // Keep-alive stays first and unconditional: the panel must survive even if tool registration
  // throws. VDESK_NO_KEEPALIVE=1 only exists for offline mock tests (never set in production).
  if (process.env.VDESK_NO_KEEPALIVE !== "1") {
    startKeepAlive(context);
  }
  // The lifecycle watchdog is independent of the panel keep-alive. VDESK_NO_LIFECYCLE=1 is a
  // test-only escape hatch so a mock run can never POST /vdesk/stop by accident.
  if (process.env.VDESK_NO_LIFECYCLE !== "1") {
    startLifecycle();
  }
  if (context.tools && typeof context.tools.register === "function") {
    registerTools(context);
  } else {
    log("ctx.tools unavailable -> native vdesk_* tools NOT registered (keep-alive still running)");
  }
}
