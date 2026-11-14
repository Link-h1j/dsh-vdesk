// P1 offline self-check for the client half: loads client.js with a stubbed module loader + React,
// then renders the right-Sidebar panel and inspects the element tree (task line + step list).
// 2026-10-21: the entry moved from the left sidebar's panel list to the right Sidebar's guide,
// so the registration assertions now cover the tab type + body/title slots instead of the row.
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\plugin\\dsh-vdesk\\client.js";
const problems = [];
const okLog = [];
function check(cond, label, detail) {
  if (cond) okLog.push("ok   " + label);
  else problems.push("FAIL " + label + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
}

// default DOM stub: injectCss() writes a <style>, and nothing else in the component graph needs DOM
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} },
};

/* ---- scripted React stub: useState values come from a queue, effects never run ---- */
let queue = [];
let qi = 0;
const noop = () => {};
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [qi < queue.length ? queue[qi++] : typeof init === "function" ? init() : init, noop],
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
};
function resetHooks(values) { queue = values; qi = 0; }
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
const effects = [];
const ctx = {
  effect: (fn, label) => { effects.push(label); const d = fn(); return typeof d === "function" ? d : () => {}; },
  slots: {
    inject: (name, fn) => {
      check(name === "sidebar.right.pane.tab" || name === "sidebar.right.pane.tab.title", "inject target allowed: " + name);
      fn();
    },
    register: (cfg, comp) => { registered.push({ cfg, comp }); },
  },
  sidebarRightTabs: {
    register: (def) => { tabTypes.push(def); return () => {}; },
  },
};
plugin.apply(ctx);

const names = registered.map((r) => r.cfg.name);
check(names.join(",") === "sidebar.right.pane.tab,sidebar.right.pane.tab.title", "registers body + title slots only", names);
check(!names.some((n) => /workspaces|settings|panellist|^main$/.test(n)), "never touches left-sidebar / single-instance slots", names);
check(tabTypes.length === 1, "registers exactly one right-Sidebar tab type", tabTypes.length);

const def = tabTypes[0] || {};
check(def.id === "@local/dsh-vdesk" && def.kind === "vdesk", "tab type id/kind", { id: def.id, kind: def.kind });
check(typeof def.title === "function" && def.title() === "虚拟桌面", "tab title", def.title && def.title());
check(Array.isArray(def.guide) && def.guide.length === 1, "one guide capsule", def.guide);
const guide = (def.guide || [])[0] || {};
check(guide.id === "vdesk" && guide.order === 80, "guide capsule id/order", { id: guide.id, order: guide.order });
check(typeof guide.title === "function" && guide.title() === "虚拟桌面", "guide title", guide.title && guide.title());
check(typeof guide.description === "function" && /实时画面/.test(guide.description()), "guide description", guide.description && guide.description());
check(typeof guide.icon === "function", "guide icon component", typeof guide.icon);
check(effects.some((label) => /right-Sidebar tab type/.test(label)), "tab type registration is effect-scoped", effects);

const panel = registered[0].comp;
const title = registered[1].comp;
check(typeof panel === "function" && typeof title === "function", "body + title components captured");

/* ---- flatten + query helpers over the fake element tree ---- */
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
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children || []).map(textOf).join("");
}

const STATUS = { ok: true, keeper: { phase: "holding", candidates: "7:abc", uptimeSec: 42 }, helper: { ok: true, width: 1600, height: 900 }, window: false };
function render(task) {
  // useVdesk: st, task, reachable, busy ; panel: streamErr, liveNonce, inputMsg
  resetHooks([STATUS, task, true, "", false, 0, ""]);
  return panel();
}
const step = (n, tool, ok, ms) => ({ type: "step", n, tool, ok, ms, ts: "2026-10-02T00:00:00.000Z" });

/* ---- the page is one block, not a popup ---- */
let tree = render(null);
check(findAll(tree, "dsh-vdesk-panel").length === 1, "right-Sidebar page renders .dsh-vdesk-panel", true);
check(findAll(tree, "dsh-vdesk-pop").length === 0, "no fold-out markup left", true);

/* ---- running task: task line + step list, failure in red ---- */
tree = render({ taskId: "t-1", goal: "g", steps: [step(1, "vdesk_click", true, 20), step(2, "vdesk_key", true, 12), step(3, "vdesk_type", false, 300)], summary: null, active: true });
let lines = findAll(tree, "taskline");
check(lines.length === 1, "task line rendered", lines.length);
check(textOf(lines[0]) === "当前任务 · 第 3 步 · 最近：type 失败", "running task line text", textOf(lines[0]));
let stepsEl = findAll(tree, "steps");
check(stepsEl.length === 1, "step list rendered", stepsEl.length);
let stepEls = findAll(stepsEl[0], "step");
check(stepEls.length === 3, "all steps listed", stepEls.length);
check(stepEls[0].props.className === "step" && stepEls[2].props.className === "step bad", "failed step carries .bad", stepEls.map((s) => s.props.className));
check(textOf(stepEls[0]) === "#1 click ok · 20ms", "step text format", textOf(stepEls[0]));
check(textOf(stepEls[2]) === "#3 type 失败 · 300ms", "failed step text", textOf(stepEls[2]));

/* ---- finished task: summary line ---- */
tree = render({ taskId: "t-1", goal: "g", steps: [step(1, "vdesk_click", true, 20)], summary: { ok: true, total: 4, failed: 1, durationMs: 12345 }, active: false });
check(textOf(findAll(tree, "taskline")[0]) === "任务已结束 · 成功 · 共 4 步 · 失败 1 · 12s", "finished task summary line", textOf(findAll(tree, "taskline")[0]));

/* ---- no task ---- */
tree = render(null);
check(textOf(findAll(tree, "taskline")[0]) === "无进行中的任务", "no-task line", textOf(findAll(tree, "taskline")[0]));
check(findAll(tree, "steps").length === 0, "no step list without a task", findAll(tree, "steps").length);

/* ---- at most ten steps, newest kept ---- */
const many = [];
for (let i = 1; i <= 12; i++) many.push(step(i, "vdesk_wait", true, i));
tree = render({ taskId: "t-1", goal: "g", steps: many, summary: null, active: true });
stepEls = findAll(findAll(tree, "steps")[0], "step");
check(stepEls.length === 10, "step list caps at 10", stepEls.length);
check(textOf(stepEls[0]).startsWith("#3 ") && textOf(stepEls[9]).startsWith("#12 "), "last ten kept", [textOf(stepEls[0]), textOf(stepEls[9])]);

/* ---- source-level guarantees ---- */
const src = (await import("node:fs")).readFileSync(CLIENT, "utf8");
check(src.includes('fetch(API + "/vdesk/task"'), "panel polls /vdesk/task");
check(src.includes(".dsh-vdesk-panel .step.bad"), "failed-step CSS present");
check(src.includes("sidebarRightTabs.register"), "registers through the right-Sidebar tab registry");
check(!src.includes("sidebar.panellist"), "left-sidebar panel list no longer referenced");
check(!/slots\.register\(\{\s*name:\s*"sidebar\.(workspaces|settings)/.test(src), "no single-instance slot registration in source");

/* ---- P4: the live area lives inside the same page ---- */
function renderLive(status) {
  resetHooks([status, null, true, "", false, 0, ""]);
  return panel();
}
const liveImgs = (t) => flatten([t]).filter((n) => n.type === "img" && String(n.props.className || "").includes("liveimg"));
tree = renderLive(STATUS);
check(liveImgs(tree).length === 1, "P4: live frame renders inside the page", liveImgs(tree).length);
check(
  String(liveImgs(tree)[0].props.src).startsWith(
    "http://127.0.0.1:8791/stream?format=jpg&quality=72&scale=0.75&fps=10&cursor=1&maxSeconds=300&t="
  ),
  "P4: frame src is the frozen monitor stream URL",
  liveImgs(tree)[0].props.src
);
check(liveImgs(renderLive({ ok: true, keeper: { phase: "idle" }, helper: { ok: true } })).length === 0, "P4: stopped session renders no frame");
check(liveImgs(renderLive({ ok: true, keeper: { phase: "holding", candidates: "7:abc" }, helper: { ok: false } })).length === 0, "P4: helper not ready renders no frame");

/* ---- tab chip ---- */
resetHooks([]);
const chip = title();
check(textOf(chip) === "虚拟桌面", "tab chip shows the name", textOf(chip));

for (const l of okLog) console.log(l);
console.log("---");
console.log("ok=" + okLog.length + " fail=" + problems.length);
for (const p of problems) console.log(p);
process.exit(problems.length === 0 ? 0 : 1);
