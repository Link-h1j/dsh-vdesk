// P4 offline self-check for the DSH right-Sidebar LIVE panel (client half, task-3 / B2).
//
// Loads plugin/dsh-vdesk/client.js with a stubbed module loader + React (same paradigm as the P1
// panel check, plus recording state setters so a handler's real outcome is observable), then renders
// the right-Sidebar page and drives the frame/pointer handlers with a stubbed fetch.
//
// 2026-10-21: the entry moved from the left sidebar's panel list to the right Sidebar's guide;
// the body is registered at sidebar.right.pane.tab key @local/dsh-vdesk and the tab type at
// ctx.sidebarRightTabs. No fold-out / open state remains, so the live area mounts with the tab.
//
// LOCATION NOTE: the project temp dir (%TEMP%\dsh-childsession\) is read-only inside this sandbox,
// so this new self-check lives in the workspace (Lead-approved). No browser, no virtual desktop.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession";
const CLIENT = path.join(ROOT, "plugin", "dsh-vdesk", "client.js");
const ZH_PATH = path.join(ROOT, "plugin", "dsh-vdesk", "locale", "zh.json");
const EN_PATH = path.join(ROOT, "plugin", "dsh-vdesk", "locale", "en.json");

const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}

/* ---- scripted React stub ---------------------------------------------------------------
   useState pulls from a queue AND records every setter call with its hook slot, so the test can
   assert what a handler really did even though the stub never re-renders.
   Hook slots inside VdeskPanel: 0 st, 1 task, 2 reachable, 3 busy,
                                4 streamErr, 5 liveNonce, 6 inputMsg.                        */
let queue = [];
let qi = 0;
let hookSeq = 0;
let setCalls = [];
const noop = () => {};
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const slot = hookSeq++;
    const v = qi < queue.length ? queue[qi++] : typeof init === "function" ? init() : init;
    return [
      v,
      (nv) => {
        setCalls.push({ slot, value: typeof nv === "function" ? nv(v) : nv });
      },
    ];
  },
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
};
function resetHooks(values) {
  queue = values;
  qi = 0;
  hookSeq = 0;
  setCalls = [];
}
const requireStub = (name) => {
  if (name === "react") return fakeReact;
  throw new Error("unexpected require: " + name);
};

let mod = null;
globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
await import(pathToFileURL(CLIENT).href);
check(!!mod && mod.id === "@local/dsh-vdesk" && typeof mod.factory === "function", "client half loads via __ModuleLoader__");

const plugin = mod.factory(requireStub);
check(JSON.stringify(plugin.inject) === JSON.stringify(["slots", "sidebarRightTabs"]), "client injects slots + sidebarRightTabs", plugin.inject);

const registered = [];
const tabTypes = [];
const ctx = {
  effect: (fn, label) => { fn(); return noop; },
  slots: {
    inject: (name, fn) => { fn(); },
    register: (cfg, comp) => { registered.push({ cfg, comp }); },
  },
  sidebarRightTabs: {
    register: (def) => { tabTypes.push(def); return noop; },
  },
};
plugin.apply(ctx);
const names = registered.map((r) => r.cfg.name);
check(names.join(",") === "sidebar.right.pane.tab,sidebar.right.pane.tab.title", "registers right-Sidebar body + title", names);
check(!names.some((n) => /panellist|^main$/.test(n)), "no left-sidebar row / main fallback", names);
check(tabTypes.length === 1 && tabTypes[0].kind === "vdesk", "registers the vdesk tab type", tabTypes.length);
check(registered[0].cfg.key === "@local/dsh-vdesk", "body key is the tab type id", registered[0].cfg);
const VdeskPanel = registered[0].comp;
check(typeof VdeskPanel === "function", "panel component captured");

/* ---- element-tree helpers ---- */
function flatten(nodes, out = []) {
  for (const n of nodes) {
    if (n === null || n === undefined || n === false || n === true) continue;
    if (Array.isArray(n)) { flatten(n, out); continue; }
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}
function findAll(tree, cls) {
  return flatten([tree]).filter((n) => typeof n.type === "string" && String(n.props.className || "").split(" ").includes(cls));
}
function findTag(tree, tag) {
  return flatten([tree]).filter((n) => n.type === tag);
}
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children || []).map(textOf).join("");
}

const STATUS_RUN = { ok: true, keeper: { phase: "holding", candidates: "7:abc", uptimeSec: 42 }, helper: { ok: true, width: 1600, height: 900 }, window: false };
const STATUS_IDLE = { ok: true, keeper: { phase: "idle", candidates: null }, helper: { ok: true, width: 1600, height: 900 }, window: false };
const STATUS_NO_HELPER = { ok: true, keeper: { phase: "holding", candidates: "7:abc", uptimeSec: 42 }, helper: { ok: false }, window: false };

function render(o = {}) {
  resetHooks([
    o.status === undefined ? STATUS_RUN : o.status,
    o.task === undefined ? null : o.task,
    o.reachable === undefined ? true : o.reachable,
    o.busy === undefined ? "" : o.busy,
    o.streamErr === undefined ? false : o.streamErr,
    o.nonce === undefined ? 0 : o.nonce,
    o.inputMsg === undefined ? "" : o.inputMsg,
  ]);
  return VdeskPanel();
}

/* ---- fetch stub ---- */
let calls = [];
let reply = { ok: true };
const fetchStub = async (url, init) => {
  calls.push({ url: String(url), init: init || null });
  return { status: 200, json: async () => reply };
};
globalThis.fetch = fetchStub;
const tick = () => new Promise((r) => setTimeout(r, 5));

const RECT = { left: 0, top: 0, width: 200, height: 100 };
const fakeImg = () => ({ getBoundingClientRect: () => RECT });
const evt = (o) => ({ currentTarget: fakeImg(), button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...o });

/* ---- 1. the frame is mounted only while open + running + helper ready ---- */
let tree = render();
let liveImgs = findAll(tree, "liveimg");
check(liveImgs.length === 1, "live frame mounted when open + running + helper ready", liveImgs.length);
const img = liveImgs[0];
const src = String(img.props.src);
const u = new URL(src);
check(u.origin + u.pathname === "http://127.0.0.1:8791/stream", "stream URL targets the monitor /stream (no side channel)", src);
check(u.searchParams.get("format") === "jpg" && u.searchParams.get("quality") === "72" && u.searchParams.get("scale") === "0.75", "stream query format=jpg quality=72 scale=0.75", src);
check(u.searchParams.get("fps") === "10" && u.searchParams.get("cursor") === "1" && u.searchParams.get("maxSeconds") === "300", "stream query fps=10 cursor=1 maxSeconds=300", src);
check(Number.isFinite(Number(u.searchParams.get("t"))) && Number(u.searchParams.get("t")) > 0, "stream query carries a cache-bust timestamp", u.searchParams.get("t"));
check(img.props.draggable === false, "frame <img> opts out of native dragging");

check(findAll(tree, "dsh-vdesk-panel").length === 1, "page renders as the right-Sidebar body", true);
check(findAll(render({ status: STATUS_IDLE }), "liveimg").length === 0, "stopped session unmounts the stream");
check(findAll(render({ status: STATUS_NO_HELPER }), "liveimg").length === 0, "helper not ready unmounts the stream");
check(findAll(render({ status: null }), "liveimg").length === 0, "unreachable service unmounts the stream");

/* ---- 2. frame error -> placeholder + manual retry (never an auto-retry loop) ---- */
tree = render();
findAll(tree, "liveimg")[0].props.onError();
check(setCalls.some((c) => c.slot === 4 && c.value === true), "img onError marks the stream failed", setCalls);

tree = render({ streamErr: true });
check(findAll(tree, "liveimg").length === 0, "frame error unmounts the <img>");
const ph = findAll(tree, "liveph");
check(ph.length === 1, "frame error shows the placeholder", ph.length);
check(textOf(ph[0]).includes("画面加载失败") && textOf(ph[0]).includes("重试"), "placeholder copy + retry label", textOf(ph[0]));
const retryBtn = findTag(ph[0], "button")[0];
check(!!retryBtn && typeof retryBtn.props.onClick === "function", "retry control present");
retryBtn.props.onClick({ stopPropagation: noop });
check(setCalls.some((c) => c.slot === 4 && c.value === false), "retry clears the error flag");
check(setCalls.some((c) => c.slot === 5 && c.value === 1), "retry bumps the stream nonce so the <img> remounts", setCalls);

/* ---- 3. single click -> monitor /click with normalised coordinates ---- */
calls = [];
reply = { ok: true, count: 1, ms: 3 };
tree = render();
const im = findAll(tree, "liveimg")[0];
im.props.onPointerDown(evt({ clientX: 50, clientY: 25 }));
im.props.onPointerUp(evt({ clientX: 50, clientY: 25 }));
await tick();
const click = calls.find((c) => c.url.includes("/click"));
check(!!click, "single click posts to the monitor /click route", calls.map((c) => c.url));
check(!!click && click.init.method === "POST", "click uses POST");
if (click) {
  const cu = new URL(click.url);
  check(cu.pathname === "/click" && cu.searchParams.get("x") === "0.25" && cu.searchParams.get("y") === "0.25" && cu.searchParams.get("button") === "left", "click coords are px/rect (0.25, 0.25)", click.url);
}
check(setCalls.some((c) => c.slot === 6 && c.value === ""), "a successful click clears the input message", setCalls.filter((c) => c.slot === 6));

calls = [];
tree = render();
const im2 = findAll(tree, "liveimg")[0];
im2.props.onPointerDown(evt({ clientX: 250, clientY: 140 }));
im2.props.onPointerUp(evt({ clientX: 250, clientY: 140 }));
await tick();
const clamped = calls.find((c) => c.url.includes("/click"));
if (clamped) {
  const cu2 = new URL(clamped.url);
  check(cu2.searchParams.get("x") === "1" && cu2.searchParams.get("y") === "1", "coords clamp into 0..1", [cu2.searchParams.get("x"), cu2.searchParams.get("y")]);
} else {
  check(false, "coords clamp into 0..1", "no /click call");
}

/* ---- 4. drag -> ONE POST /input batch (T1 frozen shape) ---- */
calls = [];
reply = { ok: true, count: 4, ms: 12 };
tree = render();
const im3 = findAll(tree, "liveimg")[0];
im3.props.onPointerDown(evt({ clientX: 10, clientY: 10 }));
im3.props.onPointerMove(evt({ clientX: 60, clientY: 40 }));
im3.props.onPointerUp(evt({ clientX: 60, clientY: 40 }));
await tick();
check(!calls.some((c) => c.url.includes("/click")), "drag never falls back to a plain click", calls.map((c) => c.url));
const inp = calls.find((c) => c.url.includes("/input"));
check(!!inp, "drag posts exactly one /input request", calls.map((c) => c.url));
check(!!inp && inp.init.method === "POST" && String((inp.init.headers || {})["content-type"]).includes("application/json"), "drag posts JSON", inp && inp.init);
let body = null;
try { body = JSON.parse(inp.init.body); } catch { body = null; }
check(!!body && Array.isArray(body.events), "drag body carries events[]", body);
const ev = (body && body.events) || [];
check(ev.length === 4, "drag events = move, down, move, up", ev);
check(JSON.stringify(ev[0]) === JSON.stringify({ type: "move", x: 0.05, y: 0.1 }), "event 1 move to the press point", ev[0]);
check(JSON.stringify(ev[1]) === JSON.stringify({ type: "down", x: 0.05, y: 0.1, button: "left", count: 1 }), "event 2 down", ev[1]);
check(JSON.stringify(ev[2]) === JSON.stringify({ type: "move", x: 0.3, y: 0.4 }), "event 3 move", ev[2]);
check(JSON.stringify(ev[3]) === JSON.stringify({ type: "up", x: 0.3, y: 0.4, button: "left", count: 1 }), "event 4 up", ev[3]);

/* ---- 5. read-only monitor is surfaced honestly (no bypass) ---- */
calls = [];
reply = { ok: false, error: "view-only", hint: "press 接管 in the toolbar first" };
tree = render();
const im4 = findAll(tree, "liveimg")[0];
im4.props.onPointerDown(evt({ clientX: 20, clientY: 20 }));
im4.props.onPointerUp(evt({ clientX: 20, clientY: 20 }));
await tick();
check(setCalls.some((c) => c.slot === 6 && String(c.value).includes("只读模式")), "view-only answer is reported, not swallowed", setCalls.filter((c) => c.slot === 6));
check(!setCalls.some((c) => c.slot === 6 && c.value === ""), "view-only is never treated as success");
const VO = "只读模式：尚未接管，未发送输入";
tree = render({ inputMsg: VO });
const errEls = findAll(tree, "liveerr");
check(errEls.length === 1 && textOf(errEls[0]) === VO, "input message renders in the live area", errEls.map(textOf));

/* ---- 6. a failed batch reports the 1-based event index ---- */
calls = [];
reply = { ok: false, index: 2, error: "bad vk" };
tree = render();
const im5 = findAll(tree, "liveimg")[0];
im5.props.onPointerDown(evt({ clientX: 10, clientY: 10 }));
im5.props.onPointerMove(evt({ clientX: 60, clientY: 40 }));
im5.props.onPointerUp(evt({ clientX: 60, clientY: 40 }));
await tick();
check(setCalls.some((c) => c.slot === 6 && String(c.value).includes("bad vk") && String(c.value).includes("第 3 个事件")), "failed batch reports error + 1-based index", setCalls.filter((c) => c.slot === 6));

/* ---- 7. unreachable monitor is reported, not silent ---- */
globalThis.fetch = async () => { throw new Error("boom"); };
tree = render();
const im6 = findAll(tree, "liveimg")[0];
im6.props.onPointerDown(evt({ clientX: 20, clientY: 20 }));
im6.props.onPointerUp(evt({ clientX: 20, clientY: 20 }));
await tick();
check(setCalls.some((c) => c.slot === 6 && String(c.value).includes("服务未响应")), "unreachable monitor is reported", setCalls.filter((c) => c.slot === 6));
globalThis.fetch = fetchStub;

/* ---- 8. right click maps to button=right ---- */
calls = [];
reply = { ok: true };
tree = render();
const im7 = findAll(tree, "liveimg")[0];
let prevented = false;
im7.props.onContextMenu({ currentTarget: fakeImg(), clientX: 100, clientY: 50, preventDefault() { prevented = true; } });
await tick();
const rc = calls.find((c) => c.url.includes("/click"));
check(!!rc && prevented, "context menu is suppressed and routed to the monitor", calls.map((c) => c.url));
if (rc) {
  const ru = new URL(rc.url);
  check(ru.searchParams.get("button") === "right" && ru.searchParams.get("x") === "0.5" && ru.searchParams.get("y") === "0.5", "right click -> button=right at 0.5, 0.5", rc.url);
} else {
  check(false, "right click -> button=right at 0.5, 0.5", "no /click call");
}

/* ---- 9. source-level guarantees ---- */
const srcText = fs.readFileSync(CLIENT, "utf8");
check(srcText.includes('"/stream?format="'), "source builds the frozen /stream query");
check(srcText.includes('postJson("/input"'), "source posts drags as one /input request");
check(srcText.includes('"/click?x="'), "source posts clicks to /click");
check(srcText.includes("liveStreamUrl"), "source has a single stream-URL builder");
check(!/slots\.register\(\{\s*name:\s*"sidebar\.(workspaces|settings)/.test(srcText), "source never registers a single-instance sidebar slot");

/* ---- 10. locale dictionaries ship in locale/*.json and the bundle mirrors them ---- */
const zh = JSON.parse(fs.readFileSync(ZH_PATH, "utf8"));
const en = JSON.parse(fs.readFileSync(EN_PATH, "utf8"));
check(zh.meta && zh.meta.title === "DSH 虚拟桌面", "zh meta preserved", zh.meta);
check(en.meta && en.meta.title === "DSH Virtual Desktop", "en meta preserved", en.meta);
check(!!zh.panel && !!en.panel, "panel dictionary present in zh + en");
const zk = zh.panel || {};
const ek = en.panel || {};
check(JSON.stringify(Object.keys(zk).sort()) === JSON.stringify(Object.keys(ek).sort()), "zh/en panel key sets match", [Object.keys(zk), Object.keys(ek)]);
check(Object.keys(zk).length === 14, "panel dictionary size", Object.keys(zk).length);
for (const k of Object.keys(zk)) {
  check(srcText.includes(k + ': "' + zk[k] + '"'), "zh copy mirrored in the bundle: " + k);
  check(srcText.includes(k + ': "' + ek[k] + '"'), "en copy mirrored in the bundle: " + k);
}

/* ---- 11. when the host DOES expose ctx.locale, the copies switch to it (guarded path, last) ---- */
let regArgs = null;
let bindNs = null;
const locCtx = {
  slots: { inject: (n, fn) => { fn(); }, register: noop },
  effect: (fn) => { fn(); },
  sidebarRightTabs: { register: noop },
  locale: {
    register: (ns, dict) => { regArgs = { ns, dict }; return noop; },
    bind: (ns) => { bindNs = ns; return (k) => (k === "liveTitle" ? "LOCALE-TITLE" : k); },
  },
};
plugin.apply(locCtx);
check(!!regArgs && regArgs.ns === "dsh-vdesk" && !!regArgs.dict && !!regArgs.dict.zh && !!regArgs.dict.en, "ctx.locale.register receives the zh+en dictionaries", regArgs && regArgs.ns);
check(bindNs === "dsh-vdesk", "ctx.locale.bind uses the plugin namespace", bindNs);
tree = render();
const imL = findAll(tree, "liveimg")[0];
check(!!imL && imL.props.alt === "LOCALE-TITLE", "rendered copy comes from the locale service when available", imL && imL.props.alt);

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
