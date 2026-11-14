#!/usr/bin/env node
/**
 * vdesk-cli.mjs -- the P0 "GAC-like" tool surface for the child-session virtual desktop.
 *
 * Why a CLI (and not DSH tools yet): tools must be registered from a plugin's HOST half, and a
 * third-party plugin cannot `import { defineTool } from "@deepseek-ai/dsh-tools"` because the
 * profile has no @deepseek-ai packages on its resolution path. Until that is solved (P1), this CLI
 * is the tool surface: the agent calls it with the ordinary shell tool, gets JSON back, and reads
 * the returned screenshot path with read_image.
 *
 * Coordinates: values <= 1 are NORMALISED (0..1 of the current desktop); values > 1 are pixels.
 * Every input action returns the resulting screenshot by default (--no-after to skip) -- "act, then
 * look at the result" is what makes step-by-step automation reliable.
 *
 * Usage:
 *   node vdesk-cli.mjs status
 *   node vdesk-cli.mjs start|stop|restart [--minutes 240]
 *   node vdesk-cli.mjs window on|off
 *   node vdesk-cli.mjs shot [--format png|jpg] [--scale 1] [--quality 80] [--out FILE] [--rect x,y,w,h]
 *   node vdesk-cli.mjs click <x> <y> [--button left] [--count 1] [--no-after]
 *   node vdesk-cli.mjs move <x> <y> | dblclick <x> <y> | drag <x1> <y1> <x2> <y2>
 *   node vdesk-cli.mjs scroll <x> <y> <delta>          (delta>0 = down)
 *   node vdesk-cli.mjs type <text> [--via auto|clipboard|sendinput] [--no-after]
 *       Default is CLIPBOARD + Ctrl+V for every text, not just non-ASCII: per-character SendInput
 *       drops/reorders characters in some controls (the Run dialog turned "notepad" into "mlg-kcw"),
 *       while the clipboard path was exact in the P0-C smoke. --via sendinput forces per-character
 *       injection; if the clipboard route is missing/failing the default silently falls back and
 *       says so in the returned `via`.
 *   node vdesk-cli.mjs key <combo> [--action combo|down|up] [--no-after]
 *       P4: action down/up press-and-hold / release exactly ONE key through the helper's
 *       single-request input channel (POST /input) -- an old helper without /input answers
 *       {ok:false,error} rather than pretending the key was held.
 *   node vdesk-cli.mjs wait <ms> | wait --stable [--timeout ms] [--interval ms] [--samples n] [--max-diff bytes]
 *       --stable polls /screenshot until `samples` consecutive frames differ by <= --max-diff bytes
 *       (default 3 frames / 0 bytes, timeout 30000ms); a timeout returns ok:false + timedOut:true.
 *   node vdesk-cli.mjs clipboard get | clipboard set <text>
 *       get returns {ok,text,chars,truncated}: text is cut at 4000 characters, chars is the full
 *       count; set places the text (UTF-8 escaped, exact for Chinese/emoji) and returns {ok,chars}.
 *   node vdesk-cli.mjs apps list | apps launch <名字>
 *       Forwards to the in-session helper's /apps (verbatim JSON). "blocked-by-policy" for
 *       doubao/豆包 targets is passed through as-is -- the CLI never bypasses that policy.
 *   node vdesk-cli.mjs start [--minutes N] [--force]
 *       P3-C: start first runs a READ-ONLY conflict probe (out\singleton-watchlist.txt, default the
 *       Tencent desktop-organizer family). If any is running it REFUSES (exit 4, singleton-conflict)
 *       because the child session's own copy fights the real one -- that twice crashed the user's own
 *       desktop. --force (or the arg force=1) overrides after the user accepts that risk.
 *   node vdesk-cli.mjs window on|off
 *   node vdesk-cli.mjs resolution <width> <height>
 *       Remembers the target size in out\desired-resolution.json and restarts (RDP fixes the desktop
 *       size at connect time, so the session must be rebuilt). `vdesk.ps1 start` uses the remembered
 *       size when -Width/-Height are not given. 1920x1080 is 2.03x the pixels of 1280x800: prefer
 *       --format jpg and/or a smaller --scale for screenshots.
 *
 * Auth (P0.6): the in-session 8790 helper requires `X-VDesk-Token: <32 hex>` on everything except
 * GET /health. The token is re-read from <token file> on every call (rotation friendly); a missing
 * file sends no header and the 401 comes back as {ok:false,error:"unauthorized"} plus a stderr hint.
 * The 8791 monitor is NOT token-guarded (the browser panel cannot read a local file) -- it is
 * origin-guarded instead, so this CLI simply calls it without a token.
 *
 * TLS (P2-C): 8790 speaks HTTPS with a self-signed certificate, so the trust anchor is the SHA-256
 * in out\helper-cert.sha256 (pinned). If that file is missing, VDESK_HTTP_ONLY=1 is set, or the
 * https probe fails (the one-time `netsh http add sslcert` binding may still be missing, which makes
 * the helper itself fall back to http), this CLI falls back to plain http and says why on stderr.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import nodeHttp from "node:http";
import nodeHttps from "node:https";

const MONITOR = process.env.VDESK_MONITOR || "http://127.0.0.1:8791";
const HELPER = process.env.VDESK_HELPER || "http://127.0.0.1:8790";
const HELPER_URL = new URL(HELPER);
const HELPER_HOST = HELPER_URL.hostname;
const HELPER_PORT = Number(HELPER_URL.port || 8790);
const OUTDIR =
  process.env.VDESK_SHOTS ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\shots";
// P0.6: the in-session helper is token-protected (everything except GET /health). The file is read
// on every call so a rotated token is picked up without restarting this CLI.
const TOKEN_FILE =
  process.env.VDESK_TOKEN_FILE ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\token";
// P2-A: remembered desktop size -- vdesk.ps1 start reads it when -Width/-Height are not given.
const DESIRED_RES_FILE =
  process.env.VDESK_DESIRED_RES ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\desired-resolution.json";
// P2-C: SHA-256 of the helper's self-signed certificate (written by task-15's helper).
const CERT_PIN_FILE =
  process.env.VDESK_CERT_PIN ||
  "C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-childsession\\out\\helper-cert.sha256";

const argv = process.argv.slice(2);
const cmd = (argv.shift() || "").toLowerCase();

function flag(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  argv.splice(i, 2);
  return v;
}
const positional = () => argv.filter((a) => !a.startsWith("--"));

/** Missing/invalid file -> no header, so the helper answers 401 and we report that clearly. */
function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return /^[0-9a-fA-F]{32}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

let warnedToken = false;
function warnToken() {
  if (warnedToken) return;
  warnedToken = true;
  process.stderr.write(
    "[vdesk] 401 unauthorized: token 缺失或不匹配。检查 " + TOKEN_FILE +
      " 是否存在（helper 生成），以及 helper 是否已重启到带鉴权的新版（task-10）。\n"
  );
}

/* ------------------------------------------- helper transport: pinned HTTPS (P2-C) */

function readCertPin() {
  try {
    const t = fs.readFileSync(CERT_PIN_FILE, "utf8").toLowerCase().replace(/[^0-9a-f]/g, "");
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

let helperTransport = { scheme: null, pin: null, at: 0, reason: "" };
const TRANSPORT_TTL_MS = 5_000;
let notedTransport = "";

// Probe/fallback chatter stays SILENT by default: teammates pipe our output into parsers, and four
// lines of "EPROTO wrong version number" on every call made it look like the command had failed.
// VDESK_DEBUG=1 brings it back. Real failures are never silenced: the 401 hint above, and a
// certificate pin MISMATCH below (that one refuses instead of downgrading and always speaks up).
const DEBUG = process.env.VDESK_DEBUG === "1";
function debugNote(msg) {
  if (DEBUG) process.stderr.write("[vdesk:debug] " + msg + "\n");
}
function loudNote(msg) {
  process.stderr.write("[vdesk] " + msg + "\n");
}

function noteTransport(t) {
  const key = t.scheme + ":" + t.reason;
  if (key === notedTransport) return;
  notedTransport = key;
  if (t.refused) loudNote("拒绝：TLS 证书指纹不匹配（不回退到 http）：" + t.reason);
  else debugNote("helper transport -> " + t.scheme + " (" + t.reason + ")");
}

function resetTransport(why) {
  helperTransport = { scheme: null, pin: null, at: 0, reason: why || "" };
}

/** One request over a GIVEN transport; resolves to the CLI's usual {ok,status,json|buf} shape.
 *  P4: an optional body (string/Buffer) carries POST /input's {"events":[...]} payload. */
function rawHelperRequest(t, method, pathQuery, timeoutMs, body, contentType) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const failed = (error) => finish({ ok: false, status: 0, error, transportError: true });
    const headers = {};
    const token = readToken();
    if (token) headers["X-VDesk-Token"] = token;
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    if (payload) {
      headers["content-type"] = contentType || "application/json; charset=utf-8";
      headers["content-length"] = payload.length;
    }
    const mod = t.scheme === "https" ? nodeHttps : nodeHttp;
    const options = { host: HELPER_HOST, port: HELPER_PORT, path: pathQuery, method, timeout: timeoutMs, headers };
    if (t.scheme === "https") {
      // self-signed by design: the PIN below is the trust anchor, not the chain or the hostname
      options.rejectUnauthorized = false;
      options.checkServerIdentity = () => undefined;
    }
    try {
      const req = mod.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const ct = String(res.headers["content-type"] || "");
          const base = { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, contentType: ct };
          if (res.statusCode === 401) {
            warnToken();
            return finish({ ...base, ok: false, unauthorized: true, json: { ok: false, error: "unauthorized" } });
          }
          if (ct.includes("json")) {
            let json = null;
            try {
              json = JSON.parse(body.toString("utf8"));
            } catch {
              json = null;
            }
            return finish({ ...base, json });
          }
          return finish({ ...base, buf: body });
        });
        res.on("error", (e) => failed(String((e && e.message) || e)));
      });
      if (t.scheme === "https") {
        req.on("socket", (s) => {
          s.on("secureConnect", () => {
            try {
              const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : null;
              const fp = String((cert && cert.fingerprint256) || "").replace(/:/g, "").toLowerCase();
              if (!fp || fp !== t.pin) {
                req.destroy(
                  new Error("certificate pin mismatch (got " + (fp ? fp.slice(0, 16) : "none") + "..., pinned " + String(t.pin).slice(0, 16) + "...)")
                );
              }
            } catch (e) {
              req.destroy(new Error("pin check failed: " + String((e && e.message) || e)));
            }
          });
        });
      }
      req.on("error", (e) => failed(String((e && e.message) || e)));
      req.on("timeout", () => {
        req.destroy();
        failed("timeout after " + timeoutMs + "ms");
      });
      req.end(payload || undefined);
    } catch (e) {
      failed(String((e && e.message) || e));
    }
  });
}

async function resolveTransport(force) {
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
  const probe = await rawHelperRequest({ scheme: "https", pin }, "GET", "/health", 2_500);
  if (probe.status > 0) {
    helperTransport = { scheme: "https", pin, at: now, reason: "pinned https" };
  } else if (/pin mismatch|pin check failed/i.test(String(probe.error))) {
    // A mismatch is NOT "the helper happens to be on http": keep https, refuse, and say so loudly.
    // Never downgrade here -- that would silently send the token over plain http.
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

async function helperHttp(method, pathQuery, timeoutMs, body, contentType) {
  const t = await resolveTransport(false);
  const r = await rawHelperRequest(t, method, pathQuery, timeoutMs, body, contentType);
  if (r.transportError) resetTransport("transport error: " + String(r.error));
  return r;
}

async function http(url, method = "GET", timeoutMs = 30000, body, contentType) {
  // the 8790 helper gets the token AND the pinned-HTTPS transport; 8791 is plain http by design
  if (String(url).startsWith(HELPER)) {
    const u = new URL(url);
    return helperHttp(method, u.pathname + u.search, timeoutMs, body, contentType);
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const fetchOpts = { method, signal: ac.signal };
    if (body !== undefined && body !== null) {
      fetchOpts.body = body;
      fetchOpts.headers = { "content-type": contentType || "application/json; charset=utf-8" };
    }
    const res = await fetch(url, fetchOpts);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json")
      ? { ok: res.ok, status: res.status, json: JSON.parse(buf.toString("utf8")) }
      : { ok: res.ok, status: res.status, buf, contentType: ct };
  } finally {
    clearTimeout(t);
  }
}

function say(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

async function size() {
  try {
    const r = await http(HELPER + "/health", "GET", 8000);
    if (r.json && r.json.width) return { w: r.json.width, h: r.json.height };
  } catch {
    /* fall through */
  }
  return { w: 1280, h: 800 };
}

/** <=1 => normalised, >1 => pixels */
function px(v, dim) {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n <= 1 ? Math.round(n * dim) : Math.round(n);
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

function shotPath(ext) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + "-" + String(d.getMilliseconds()).padStart(3, "0");
  return path.join(OUTDIR, "shot-" + stamp + "." + ext);
}

async function shot(opts = {}) {
  const format = opts.format || "jpg";
  const scale = opts.scale === undefined ? 0.75 : Number(opts.scale);
  const quality = opts.quality === undefined ? 75 : Number(opts.quality);
  const url =
    HELPER + "/screenshot?format=" + format + "&scale=" + scale + "&quality=" + quality + (opts.rect ? "&rect=" + opts.rect : "");
  const t0 = Date.now();
  const r = await http(url, "GET", 30000);
  if (r.unauthorized) return { ok: false, error: "unauthorized", hint: "token 缺失或不匹配（见 stderr）" };
  if (!r.buf || !r.buf.length) return { ok: false, error: "screenshot failed (status " + r.status + ")" };
  const file = opts.out || shotPath(format === "png" ? "png" : "jpg");
  fs.writeFileSync(file, r.buf);
  let dim = null;
  try {
    dim = await size();
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    path: file,
    bytes: r.buf.length,
    kb: Math.round(r.buf.length / 1024),
    ms: Date.now() - t0,
    format,
    scale,
    desktop: dim,
  };
}

async function after(opts) {
  if (opts.noAfter) return { screenshot: "(skipped)" };
  try {
    return { screenshot: await shot({}) };
  } catch (e) {
    return { screenshot: "failed: " + String((e && e.message) || e) };
  }
}

/** A 401 anywhere must reach the top level of the command's JSON, not hide inside a nested body. */
function uerr(r) {
  return r && r.unauthorized ? { unauthorized: true, error: "unauthorized" } : {};
}

async function keyCombo(combo) {
  const vks = vksOf(combo);
  const r = await http(HELPER + "/key?action=combo&vks=" + vks.join(","), "GET", 15000);
  return { ok: r.ok && !(r.json && r.json.ok === false), result: r.json || { ok: r.ok }, ...uerr(r) };
}

/** Per-character injection. Kept as an explicit opt-in only: some edit controls (the Run dialog's
 *  AutoComplete) drop or reorder characters when text arrives key-by-key. */
async function typeViaSendInput(text) {
  const r = await http(HELPER + "/key?action=text&text=" + encodeURIComponent(text), "GET", 30000);
  return {
    ok: r.ok && !(r.json && r.json.ok === false),
    via: "sendinput",
    result: r.json || { ok: r.ok },
    ...uerr(r),
  };
}

/** Clipboard + Ctrl+V: exact for any text (ASCII and CJK alike) and the default since P0.5. */
async function typeViaClipboard(text) {
  const set = await http(HELPER + "/clipboard?action=set&text=" + encodeURIComponent(text), "GET", 15000);
  if (!set.ok || (set.json && set.json.ok === false)) {
    return {
      ok: false,
      via: "clipboard",
      error: set.unauthorized ? "unauthorized" : "helper has no working clipboard route yet",
      detail: set.json || set.status,
    };
  }
  const paste = await keyCombo("ctrl+v");
  return { ok: paste.ok !== false, via: "clipboard+ctrl+v", set: set.json || { ok: true }, paste };
}

/**
 * Default ("auto"): clipboard first, SendInput only as a graceful fallback when the helper build
 * has no /clipboard or the set call failed. The returned `via` always names the path that actually
 * ran, so a caller can never mistake a fallback for the default.
 */
async function typeText(text, via = "auto") {
  if (via === "sendinput") return typeViaSendInput(text);
  const clip = await typeViaClipboard(text);
  if (clip.ok || via === "clipboard") return clip;
  const fb = await typeViaSendInput(text);
  return {
    ...fb,
    via: "sendinput(fallback)",
    fallback: true,
    clipboardError: clip.error,
    clipboardDetail: clip.detail,
  };
}

/* ------------------------------------------------- P4: clipboard / held keys / wait-stable */

const CLIPBOARD_LIMIT = 4000;

async function clipboardCommand(sub, text) {
  if (sub === "get") {
    const r = await http(HELPER + "/clipboard?action=get", "GET", 10000);
    if (!r.json || r.json.ok === false) {
      return { ok: false, error: r.unauthorized ? "unauthorized" : (r.json && r.json.error) || "clipboard get failed", status: r.status, ...uerr(r) };
    }
    const full = r.json.text === undefined || r.json.text === null ? "" : String(r.json.text);
    const truncated = full.length > CLIPBOARD_LIMIT;
    return { ok: true, text: truncated ? full.slice(0, CLIPBOARD_LIMIT) : full, chars: full.length, truncated };
  }
  if (sub === "set") {
    const s = text === undefined || text === null ? "" : String(text);
    const r = await http(HELPER + "/clipboard?action=set&text=" + encodeURIComponent(s), "GET", 10000);
    if (!r.json || r.json.ok === false) {
      return { ok: false, error: r.unauthorized ? "unauthorized" : (r.json && r.json.error) || "clipboard set failed", status: r.status, chars: s.length, ...uerr(r) };
    }
    return { ok: true, chars: s.length };
  }
  return { ok: false, error: "usage: clipboard get | clipboard set <text>" };
}

/**
 * P4: one batched input request on T1's frozen contract (POST /input {"events":[...]}), with the
 * documented GET /input?events=<urlencoded json> form tried only when the POST route answers
 * 404/405. An old helper (no /input at all) ends in {ok:false,error} -- never a pretend success.
 */
async function inputEvents(events) {
  const payload = JSON.stringify({ events });
  const post = await http(HELPER + "/input", "POST", 20000, payload, "application/json; charset=utf-8");
  const postRouteMissing = post.status === 404 || post.status === 405;
  const r = postRouteMissing ? await http(HELPER + "/input?events=" + encodeURIComponent(payload), "GET", 20000) : post;
  if (r.unauthorized) return { ok: false, error: "unauthorized", unauthorized: true, preInput: postRouteMissing };
  // both the POST and the GET form answered 404/405 -> this really is a pre-P4 helper
  if (postRouteMissing && (r.status === 404 || r.status === 405)) {
    return { ok: false, error: "helper has no /input route (pre-P4 build): the single-request input channel is unavailable", preInput: true };
  }
  if (r.json && r.json.ok === false) return { ok: false, error: String(r.json.error || "input event failed"), index: r.json.index, helper: r.json };
  if (!r.ok || !r.json) {
    return {
      ok: false,
      error: postRouteMissing
        ? "helper has no /input route (pre-P4 build): the single-request input channel is unavailable"
        : r.error || "helper /input failed (status " + r.status + ")",
      ...(postRouteMissing ? { preInput: true } : {}),
    };
  }
  return { ...r.json, ok: true };
}

/** P4: press-and-hold / release exactly one key through /input (a chord held across calls). */
async function keyHeld(combo, action) {
  let vks;
  try {
    vks = vksOf(combo);
  } catch (e) {
    return { ok: false, combo, action, error: String((e && e.message) || e) };
  }
  if (vks.length !== 1) {
    return { ok: false, combo, action, vks, error: "action:" + action + " needs exactly one key (got " + vks.length + ")" };
  }
  const r = await inputEvents([{ type: "key", vk: vks[0], down: action === "down" }]);
  return { combo, vks, vk: vks[0], action, ...r };
}

/** Number of differing bytes between two frames (+ any length difference). 0 == byte-identical. */
function frameDiffBytes(a, b) {
  const n = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;
  return diff;
}

/**
 * P4: poll /screenshot until `samples` consecutive frames are within maxDiffBytes of each other.
 * Returns {ok,stable,attempts,elapsedMs,bytes,lastHash,timedOut}; a timeout is reported honestly.
 */
async function waitStableCli(opts) {
  const timeoutMs = Number.isFinite(Number(opts.timeout)) && Number(opts.timeout) > 0 ? Math.min(Math.round(Number(opts.timeout)), 600000) : 30000;
  const intervalMs = Number.isFinite(Number(opts.interval)) && Number(opts.interval) > 0 ? Math.min(Math.round(Number(opts.interval)), 60000) : 400;
  const samples = Number.isFinite(Number(opts.samples)) && Number(opts.samples) >= 1 ? Math.min(Math.round(Number(opts.samples)), 60) : 3;
  const maxDiffBytes = Number.isFinite(Number(opts.maxDiffBytes)) && Number(opts.maxDiffBytes) >= 0 ? Math.round(Number(opts.maxDiffBytes)) : 0;
  const t0 = Date.now();
  let attempts = 0;
  let chain = 0;
  let prev = null;
  let lastBytes = 0;
  let lastHash = null;
  let lastDiffBytes = null;
  for (;;) {
    const r = await http(HELPER + "/screenshot?format=jpg&quality=40&scale=0.35&cursor=0", "GET", 30000);
    if (!r.buf || !r.buf.length) {
      return { ok: false, stable: false, attempts, elapsedMs: Date.now() - t0, bytes: lastBytes, lastHash, timedOut: false, error: r.error || "screenshot failed (status " + r.status + ")" };
    }
    attempts++;
    lastBytes = r.buf.length;
    lastHash = crypto.createHash("sha256").update(r.buf).digest("hex");
    lastDiffBytes = prev ? frameDiffBytes(prev, r.buf) : null;
    if (prev && lastDiffBytes <= maxDiffBytes) chain++;
    else chain = 1;
    prev = r.buf;
    if (chain >= samples) {
      return { ok: true, stable: true, attempts, elapsedMs: Date.now() - t0, bytes: lastBytes, lastHash, timedOut: false, lastDiffBytes };
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= timeoutMs) {
      return { ok: false, stable: false, attempts, elapsedMs: elapsed, bytes: lastBytes, lastHash, timedOut: true, lastDiffBytes, error: "screen did not stabilize (" + samples + " frames within " + maxDiffBytes + " bytes) in " + timeoutMs + "ms" };
    }
    await new Promise((res) => setTimeout(res, Math.min(intervalMs, Math.max(0, timeoutMs - elapsed))));
  }
}

async function main() {
  const noAfter = flag("no-after", false) === true || flag("noAfter", false) === true;
  const opts = {
    noAfter,
    format: flag("format", "jpg"),
    scale: flag("scale", undefined),
    quality: flag("quality", undefined),
    out: flag("out", undefined),
    rect: flag("rect", undefined),
    // consumed before positional(), otherwise "--via sendinput" would leak "sendinput" into <text>
    via: flag("via", undefined),
    // consumed before positional(): otherwise "--force" would leak into the positional args
    force: flag("force", false),
    // P4: `key <combo> [--action down|up]` and `wait --stable [...]` (all consumed before positional())
    keyAction: flag("action", undefined),
    stable: flag("stable", false) === true,
    timeout: flag("timeout", undefined),
    interval: flag("interval", undefined),
    samples: flag("samples", undefined),
    maxDiffBytes: flag("max-diff", undefined),
  };
  const args = positional();

  switch (cmd) {
    case "status": {
      const r = await http(MONITOR + "/vdesk/status", "GET", 8000);
      return say(r.json || { ok: false, error: "monitor not answering" });
    }
    case "start": {
      flag("minutes", "240");
      const force = opts.force === true || args.includes("force=1");
      // P3-C: probe BEFORE touching anything. Refusing here never creates a session.
      const c = (await http(MONITOR + "/vdesk/conflict", "GET", 30000)).json || null;
      const found = c && Array.isArray(c.found) ? c.found : [];
      if (found.length > 0 && !force) {
        process.exitCode = 4;
        return say({
          ok: false,
          error: "singleton-conflict",
          found,
          advice:
            "这些程序是机器级单例，子会话会再起一份并与真机抢单例导致双崩。请先退出它们再启动；或确认接受风险后用 force=true 继续。",
        });
      }
      if (found.length > 0) {
        process.stderr.write(
          "[vdesk] !!! FORCE：无视 " + found.length + " 个单例程序继续启动（" +
            found.map((f) => f.name + "(pid " + f.pid + ")").join(", ") +
            "）—— 可能再次导致用户桌面双崩\n"
        );
      }
      const r = await http(MONITOR + "/vdesk/start" + (force ? "?force=1" : ""), "POST", 15000);
      return say(r.json || { ok: r.ok });
    }
    case "stop":
    case "restart": {
      const r = await http(MONITOR + "/vdesk/" + cmd, "POST", 15000);
      return say(r.json || { ok: r.ok });
    }
    case "window": {
      const on = (args[0] || "on") === "on" ? "1" : "0";
      const r = await http(MONITOR + "/vdesk/window?on=" + on, "POST", 10000);
      return say(r.json || { ok: r.ok });
    }
    case "resolution": {
      // RDP fixes the desktop size when the connection is made -> remember the target, then rebuild.
      const w = Math.round(Number(args[0]));
      const h = Math.round(Number(args[1]));
      if (!(w >= 320 && w <= 4096 && h >= 240 && h <= 4096)) {
        return say({ ok: false, error: "usage: resolution <width> <height> (320..4096 x 240..4096)", got: [args[0], args[1]] });
      }
      const file = DESIRED_RES_FILE;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ width: w, height: h, ts: new Date().toISOString() }) + "\n");
      } catch (e) {
        return say({ ok: false, error: "cannot write " + file + ": " + String((e && e.message) || e) });
      }
      const r = await http(MONITOR + "/vdesk/restart", "POST", 15000);
      const dispatched = !!(r.json ? r.json.ok !== false : r.ok);
      return say({ ok: dispatched, width: w, height: h, restarted: dispatched, desired: file, restart: r.json || { ok: r.ok } });
    }
    case "shot": {
      return say(await shot(opts));
    }
    case "wait": {
      // P4: `wait --stable` polls until the picture settles; plain `wait <ms>` keeps sleeping.
      if (opts.stable) return say(await waitStableCli(opts));
      const ms = Number(args[0] || 1000);
      await new Promise((r) => setTimeout(r, ms));
      return say({ ok: true, waitedMs: ms });
    }
    case "wait-stable": {
      // wait until two consecutive frames differ by less than --diff percent (or timeout)
      const timeout = Number(flag("ms", 6000));
      const diffPct = Number(flag("diff", 2.0));
      const t0 = Date.now();
      let prev = null;
      let stable = 0;
      while (Date.now() - t0 < timeout) {
        const r = await http(HELPER + "/screenshot?format=jpg&scale=0.4&quality=50", "GET", 15000);
        if (!r.buf) break;
        const cur = r.buf;
        if (prev) {
          const a = Buffer.from(prev.toString("base64"), "base64");
          const len = Math.min(a.length, cur.length);
          let diff = 0;
          for (let i = 0; i < len; i += 7) if (Math.abs(a[i] - cur[i]) > 8) diff++;
          const pct = (diff / (len / 7)) * 100;
          if (pct <= diffPct) {
            stable++;
            if (stable >= 2) return say({ ok: true, stable: true, elapsedMs: Date.now() - t0, diffPct: Number(pct.toFixed(2)) });
          } else stable = 0;
        }
        prev = cur;
        await new Promise((r2) => setTimeout(r2, 350));
      }
      return say({ ok: true, stable: false, elapsedMs: Date.now() - t0 });
    }
    case "click":
    case "dblclick": {
      const { w, h } = await size();
      const x = px(args[0], w);
      const y = px(args[1], h);
      const button = flag("button", "left");
      const count = cmd === "dblclick" ? 2 : Number(flag("count", 1));
      const t0 = Date.now();
      const r = await http(HELPER + "/mouse?action=click&x=" + x + "&y=" + y + "&button=" + button + "&count=" + count, "GET", 15000);
      return say({ ok: r.ok, x, y, button, count, ms: Date.now() - t0, ...uerr(r), ...(await after(opts)) });
    }
    case "move": {
      const { w, h } = await size();
      const x = px(args[0], w);
      const y = px(args[1], h);
      const r = await http(HELPER + "/mouse?action=move&x=" + x + "&y=" + y, "GET", 15000);
      return say({ ok: r.ok, x, y, ...uerr(r), ...(await after(opts)) });
    }
    case "drag": {
      const { w, h } = await size();
      const x1 = px(args[0], w);
      const y1 = px(args[1], h);
      const x2 = px(args[2], w);
      const y2 = px(args[3], h);
      const r = await http(HELPER + "/mouse?action=drag&x=" + x1 + "&y=" + y1 + "&x2=" + x2 + "&y2=" + y2, "GET", 20000);
      return say({ ok: r.ok, from: [x1, y1], to: [x2, y2], ...uerr(r), ...(await after(opts)) });
    }
    case "scroll": {
      const { w, h } = await size();
      const x = px(args[0], w);
      const y = px(args[1], h);
      const delta = Number(args[2] || 480);
      const r = await http(HELPER + "/mouse?action=scroll&x=" + x + "&y=" + y + "&delta=" + delta, "GET", 15000);
      return say({ ok: r.ok, x, y, delta, ...uerr(r), ...(await after(opts)) });
    }
    case "type": {
      const text = args.join(" ");
      const via = opts.via === undefined ? "auto" : String(opts.via).toLowerCase();
      if (!["auto", "clipboard", "sendinput"].includes(via)) {
        return say({ ok: false, error: "--via must be auto|clipboard|sendinput", got: String(opts.via) });
      }
      const r = await typeText(text, via);
      // requestedVia is the caller's flag; r.via is the path that actually ran (may be a fallback)
      return say({ text, ...r, requestedVia: via, ok: r.ok !== false, ...(await after(opts)) });
    }
    case "key": {
      const combo = args.join(" ");
      const action = opts.keyAction === undefined ? "combo" : String(opts.keyAction).toLowerCase();
      if (!["combo", "down", "up"].includes(action)) {
        return say({ ok: false, error: "--action must be combo|down|up", got: String(opts.keyAction) });
      }
      // P4: down/up hold or release ONE key through POST /input (old helper -> honest ok:false)
      if (action !== "combo") {
        return say({ ...(await keyHeld(combo, action)), ...(await after(opts)) });
      }
      const r = await keyCombo(combo);
      return say({ combo, action: "combo", ...r, vks: vksOf(combo), ok: r.ok !== false, ...(await after(opts)) });
    }
    case "apps": {
      // P2-B: forward to the helper's /apps verbatim -- including blocked-by-policy (never bypassed)
      const sub = (args[0] || "list").toLowerCase();
      if (sub === "list") {
        const r = await http(HELPER + "/apps?action=list", "GET", 30000);
        return say(r.json || { ok: false, error: r.error || "helper /apps failed", status: r.status });
      }
      if (sub === "launch") {
        const name = args.slice(1).join(" ");
        if (!name) return say({ ok: false, error: "usage: apps launch <name>" });
        const r = await http(HELPER + "/apps?action=launch&name=" + encodeURIComponent(name), "GET", 30000);
        return say(r.json || { ok: false, error: r.error || "helper /apps failed", status: r.status });
      }
      return say({ ok: false, error: "usage: apps list | apps launch <name>" });
    }
    case "clipboard": {
      // P4: normalised {ok,text,chars,truncated} / {ok,chars} (text is UTF-8 escaped on the wire)
      const sub = (args[0] || "get").toLowerCase();
      return say(await clipboardCommand(sub, args.slice(1).join(" ")));
    }
    default:
      return say({
        ok: false,
        error: "unknown command: " + cmd,
        usage: "status|start|stop|restart|window|resolution|apps|shot|click|dblclick|move|drag|scroll|type|key|wait|wait-stable|clipboard",
      });
  }
}

main().catch((e) => {
  say({ ok: false, error: String((e && e.message) || e) });
  process.exitCode = 1;
});
