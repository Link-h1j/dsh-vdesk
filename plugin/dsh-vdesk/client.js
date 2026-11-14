/**
 * Browser half of @local/dsh-vdesk.
 *
 * What the user asked for (2026-10-21): the 「虚拟桌面」 entry used to sit in the LEFT sidebar's
 * panel list. Move that icon to the RIGHT sidebar. So this half now registers a right-Sidebar
 * page type (`vdesk`) plus its guide capsule: opening the right sidebar shows a 「虚拟桌面」
 * card in its guide, and picking it opens the control page in the right column's tab strip.
 *
 * What the page holds: 开启 / 关闭 / 重启 / 独立窗口, the keeper status line, the last action's
 * message, the task step list, and the live MJPEG view with click / drag input.
 *
 * The right Sidebar's tab registry is the shipped cross-plugin service `ctx.sidebarRightTabs`
 * (see @deepseek-ai/dsh-client-ui-sidebar-right); its guide entries are the same capsules the
 * shipped 文件/终端/浏览器/画布 pages use. No DOM interception any more -- the old left row had
 * to swallow the host's click because the host rendered and owned that row; a right-Sidebar tab
 * is a normal registration and needs none of that.
 *
 * 独立窗口 is the keeper's own form brought on screen: a real RDP window, not a web page.
 * Local service: 127.0.0.1:8791 (CORS open).
 */

window.__ModuleLoader__.load({
  id: "@local/dsh-vdesk",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const API = "http://127.0.0.1:8791";
    const TAB_ID = "@local/dsh-vdesk";
    const TAB_KIND = "vdesk";
    const TAB_TITLE = "虚拟桌面";
    const POLL_MS = 2500;

    const C = {
      ok: "#2ecc71",
      warn: "#e8a33d",
      bad: "#e5544b",
      line: "var(--dsw-alias-border-l3, rgba(127,127,127,.3))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))",
      fill: "var(--dsw-alias-button-elevated-fill, #ffffff)",
      ink: "var(--dsw-alias-label-primary, inherit)",
    };

    // ---- locale ------------------------------------------------------------------------------
    // Live-area copies live in locale/zh.json + locale/en.json ("panel" section). The browser
    // half declares ["slots", "sidebarRightTabs"]; the locale service is registered when the
    // host exposes it (guarded, never fatal), with these in-bundle copies as the fallback.
    const NS = "dsh-vdesk";
    const ZH = {
      tabTitle: "虚拟桌面",
      guideDescription: "开启 / 关闭 · 实时画面 · 独立窗口",
      liveTitle: "实时画面",
      liveHint: "点击 / 拖拽直接操作",
      liveFailed: "画面加载失败（服务未就绪或流已结束）",
      liveRetry: "重试",
      viewOnly: "只读模式：尚未接管，未发送输入",
      inputFailed: "输入失败",
      inputUnreachable: "服务未响应，输入未发送",
      actUnreachable: "服务未响应，操作未发送",
      actFailed: "失败",
      conflictRefused: "已拒绝启动",
      conflictWays: "先退出它们，或点「强制启动」接受风险",
      startRequested: "已受理：正在启动（约 1 分钟）…",
    };
    const EN = {
      tabTitle: "Virtual desktop",
      guideDescription: "Start / stop · Live view · Native window",
      liveTitle: "Live view",
      liveHint: "Click / drag to control",
      liveFailed: "The live view failed to load (service not ready, or the stream ended).",
      liveRetry: "Retry",
      viewOnly: "View-only: takeover is off, input not sent",
      inputFailed: "Input failed",
      inputUnreachable: "Service did not respond, input not sent",
      actUnreachable: "Service did not respond, action not sent",
      actFailed: "failed",
      conflictRefused: "Start refused",
      conflictWays: "exit them first, or accept the risk with Force start",
      startRequested: "Accepted: starting (about 1 minute)…",
    };
    let localeT = null;
    function T(key, fallback) {
      if (localeT) {
        try {
          const v = localeT(key);
          if (typeof v === "string" && v && v !== key) return v;
        } catch {
          /* fall through to the in-bundle copy */
        }
      }
      return fallback !== undefined ? fallback : key;
    }

    // ---- P4 live view (B2) --------------------------------------------------------------------
    // The frame source is the monitor's MJPEG stream (T1 froze the query shape); input goes back
    // through the SAME monitor so its takeover lock stays authoritative -- a read-only monitor
    // answers view-only and we show that honestly instead of opening a side channel.
    const LIVE_Q = { format: "jpg", quality: 72, scale: 0.75, fps: 10, cursor: 1, maxSeconds: 300 };
    const DRAG_MIN = 0.004; // ~0.4% of the frame: below this a press is a click, not a drag
    const MAX_MOVE_PTS = 40; // bound the single-request drag payload

    function liveStreamUrl() {
      return (
        API +
        "/stream?format=" + LIVE_Q.format +
        "&quality=" + LIVE_Q.quality +
        "&scale=" + LIVE_Q.scale +
        "&fps=" + LIVE_Q.fps +
        "&cursor=" + LIVE_Q.cursor +
        "&maxSeconds=" + LIVE_Q.maxSeconds +
        "&t=" + Date.now()
      );
    }

    function frameRect(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") return null;
      const r = el.getBoundingClientRect();
      if (!r || !r.width || !r.height) return null;
      return r;
    }

    /** Screen pixel -> normalised 0..1 point inside the frame (the monitor's /mouse semantics). */
    function normPoint(clientX, clientY, r) {
      const clamp = (v) => Math.min(1, Math.max(0, v));
      const x = clamp((clientX - r.left) / r.width);
      const y = clamp((clientY - r.top) / r.height);
      return { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 };
    }

    function mouseButton(n) {
      return n === 2 ? "right" : n === 1 ? "middle" : "left";
    }

    /** Evenly thin a pointer path while keeping both ends (payload stays small on long drags). */
    function thinPoints(pts, max) {
      if (pts.length <= max) return pts;
      const out = [];
      const step = (pts.length - 1) / (max - 1);
      for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
      out[out.length - 1] = pts[pts.length - 1];
      return out;
    }

    /** T1 frozen POST /input contract: move -> down -> move* -> up, all in one request. */
    function dragEvents(pts, button) {
      const btn = button || "left";
      const out = [{ type: "move", x: pts[0].x, y: pts[0].y }];
      out.push({ type: "down", x: pts[0].x, y: pts[0].y, button: btn, count: 1 });
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const prev = out[out.length - 1];
        if (prev.type === "move" && prev.x === p.x && prev.y === p.y) continue;
        out.push({ type: "move", x: p.x, y: p.y });
      }
      const last = pts[pts.length - 1];
      out.push({ type: "up", x: last.x, y: last.y, button: btn, count: 1 });
      return out;
    }

    // ---- CSS for the right-Sidebar page ----
    // It is a normal tab body now (not a fixed-position fold-out anchored to a host-rendered row):
    // fill the pane, scroll when short, and keep the same control language as the rest of DSH.
    function injectCss() {
      if (typeof document === "undefined") return;
      // Replace the existing tag's text on a hot reload instead of leaving the first copy behind,
      // so a CSS edit is picked up without a page refresh.
      const existing = document.querySelector('style[data-plugin="@local/dsh-vdesk"]');
      const tag = existing || document.createElement("style");
      tag.dataset.plugin = "@local/dsh-vdesk";
      tag.textContent =
        ".dsh-vdesk-panel{box-sizing:border-box;height:100%;min-height:0;width:100%;max-width:560px;" +
        "margin:0 auto;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px;color:" + C.ink + ";" +
        "font-size:12px;line-height:18px}" +
        ".dsh-vdesk-panel .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}" +
        ".dsh-vdesk-panel button{font:inherit;font-size:12px;line-height:18px;padding:5px 6px;border-radius:7px;" +
        "border:1px solid " + C.line + ";background:transparent;color:inherit;cursor:pointer;white-space:nowrap}" +
        ".dsh-vdesk-panel button:hover:not(:disabled){background:" + C.hover + "}" +
        ".dsh-vdesk-panel button:disabled{opacity:.42;cursor:default}" +
        ".dsh-vdesk-panel button.primary{font-weight:600;background:" + C.hover + "}" +
        ".dsh-vdesk-panel .meta{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums;padding:0 2px}" +
        // P4.1: the outcome of an action — a refusal must be visible, never silent
        ".dsh-vdesk-panel .actmsg{font-size:11px;line-height:1.45;padding:1px 2px 0;color:" + C.warn + "}" +
        // P1 step panel: same theme vars as everything else (no hard-coded colours)
        ".dsh-vdesk-panel .taskline{font-size:11px;padding:5px 2px 1px;border-top:1px solid " + C.line + ";opacity:.85}" +
        ".dsh-vdesk-panel .steps{max-height:148px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:1px 0}" +
        ".dsh-vdesk-panel .step{font-size:11px;line-height:15px;opacity:.75;font-variant-numeric:tabular-nums;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        ".dsh-vdesk-panel .step.bad{color:" + C.bad + ";opacity:1;font-weight:600}" +
        ".dsh-vdesk-panel .stephead{font-size:11px;opacity:.55;padding:0 2px}" +
        // P3-C conflict warning: amber = "needs your decision", same language as the rest of the UI
        ".dsh-vdesk-panel .conflictwrap{display:flex;flex-direction:column;gap:5px;padding:5px 2px 1px}" +
        ".dsh-vdesk-panel .conflictline{font-size:11px;line-height:15px;color:" + C.warn + ";font-weight:600}" +
        // P4 live area: the monitor's MJPEG stream in an <img>, with click/drag going straight back
        ".dsh-vdesk-panel .livewrap{display:flex;flex-direction:column;gap:4px;padding:5px 2px 1px;" +
        "border-top:1px solid " + C.line + "}" +
        ".dsh-vdesk-panel .livetitle{font-size:11px;line-height:15px;opacity:.75;display:flex;" +
        "justify-content:space-between;gap:6px}" +
        ".dsh-vdesk-panel .livenote{opacity:.55;white-space:nowrap}" +
        ".dsh-vdesk-panel .liveimg{display:block;width:100%;border-radius:6px;background:rgba(127,127,127,.12);" +
        "cursor:crosshair;touch-action:none;-webkit-user-select:none;user-select:none}" +
        ".dsh-vdesk-panel .liveph{font-size:11px;line-height:15px;opacity:.7;padding:6px;" +
        "border:1px dashed " + C.line + ";border-radius:6px}" +
        ".dsh-vdesk-panel .liveph button{margin-top:5px;width:100%}" +
        ".dsh-vdesk-panel .liveerr{font-size:11px;line-height:15px;color:" + C.warn + "}" +
        ".dsh-vdesk-title{display:inline-flex;align-items:center;gap:6px;min-width:0}" +
        ".dsh-vdesk-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
      document.head.appendChild(tag);
    }

    /** Guide capsule + tab-chip glyph: two overlapping windows, same mark the left row used. */
    function VdeskArtwork({ size = 24, className }) {
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          className,
          "aria-hidden": true,
        },
        h("rect", { x: 3, y: 5.5, width: 12.5, height: 9.5, rx: 2 }),
        h("rect", { x: 8.5, y: 9, width: 12.5, height: 9.5, rx: 2 })
      );
    }

    function fmtUptime(sec) {
      const s = Number(sec) || 0;
      if (s < 60) return s + " 秒";
      if (s < 3600) return Math.floor(s / 60) + " 分钟";
      return Math.floor(s / 3600) + " 小时 " + Math.floor((s % 3600) / 60) + " 分";
    }

    function useVdesk() {
      const [st, setSt] = React.useState(null);
      const [task, setTask] = React.useState(null);
      const [reachable, setReachable] = React.useState(true);
      const [busy, setBusy] = React.useState("");
      const alive = React.useRef(true);

      const refresh = React.useCallback(async () => {
        try {
          const j = await (await fetch(API + "/vdesk/status", { cache: "no-store" })).json();
          if (alive.current) {
            setSt(j);
            setReachable(true);
          }
        } catch {
          if (alive.current) {
            setReachable(false);
            setSt(null);
          }
        }
        // Step panel: the monitor reads the newest task journal from disk, so this poll is read-only
        // and cheap. It must never break the status path, hence its own try/catch.
        try {
          const j = await (await fetch(API + "/vdesk/task", { cache: "no-store" })).json();
          if (alive.current) setTask(j && j.task ? j.task : null);
        } catch {
          if (alive.current) setTask(null);
        }
      }, []);

      React.useEffect(() => {
        alive.current = true;
        refresh();
        const a = setInterval(refresh, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(a);
        };
      }, [refresh]);

      // P4.1: the response used to be THROWN AWAY, so a server-side refusal (e.g. the P3-C
      // "singleton-conflict" 409) looked exactly like a button that does nothing — the user reported
      // "点不起开启" on 2026-10-02 14:47. Return the parsed body so the caller can say what happened.
      const call = React.useCallback(
        async (path, label) => {
          setBusy(label);
          try {
            const res = await fetch(API + path, { method: "POST", cache: "no-store" });
            let j = null;
            try {
              j = await res.json();
            } catch {
              j = null;
            }
            return j || { ok: false, error: "http " + res.status, status: res.status };
          } catch {
            return { ok: false, error: "unreachable", network: true };
          } finally {
            setBusy("");
            setTimeout(refresh, 1600);
          }
        },
        [refresh]
      );

      const keeper = st && st.keeper;
      const helper = st && st.helper;
      // "up" must depend ONLY on the keeper actually holding our child session.
      // It used to also require the helper health probe, but that cache is refreshed
      // asynchronously and is briefly null on every poll -- which made 关闭/重启 flicker to
      // disabled and look broken (2026-10-01: CDP showed 保活中 + 关闭 disabled while the server
      // reported phase=holding, connected=1, helper.ok=true). The helper only affects the status
      // dot / the picture channel below, never whether an action is available.
      const helperOk = !!(helper && helper.ok);
      const up = !!(keeper && keeper.phase === "holding" && keeper.candidates);
      return {
        keeper,
        up,
        reachable,
        busy,
        call,
        task,
        conflict: st && st.conflict ? st.conflict : null,
        windowed: !!(st && st.window),
        childId: keeper && keeper.candidates ? String(keeper.candidates).split(":")[0] : "",
        w: (helper && helper.width) || (keeper && keeper.width) || 1280,
        hgt: (helper && helper.height) || (keeper && keeper.height) || 800,
        helperOk,
        text: !reachable ? "服务未启动" : up ? "运行中" : keeper && keeper.phase === "holding" ? "保活中" : "未运行",
        dot: reachable ? (up ? C.ok : C.warn) : C.bad,
      };
    }

    /** The right-Sidebar page: controls, status, task steps and the live view. */
    function VdeskPanel() {
      const v = useVdesk();
      // P4 live area state (order matters to the offline self-check's scripted hook queue)
      const [streamErr, setStreamErr] = React.useState(false);
      const [liveNonce, setLiveNonce] = React.useState(0);
      const [inputMsg, setInputMsg] = React.useState("");
      const dragRef = React.useRef(null);

      const meta = v.up
        ? "会话 " +
          v.childId +
          (v.keeper && v.keeper.uptimeSec ? " · " + fmtUptime(v.keeper.uptimeSec) : "") +
          " · " +
          v.w +
          "×" +
          v.hgt
        : v.text;

      // Every menu button reports its own outcome. A silent refusal is indistinguishable from a dead
      // button (that was the whole "点不起开启" report), so the server's answer is shown verbatim.
      const actError = (r, label) => {
        const err = r && r.error ? String(r.error) : "unknown";
        if (err === "singleton-conflict") {
          const names = (r.found || []).map((f) => f && f.name).filter(Boolean);
          const listed = names.slice(0, 3).join("、") + (names.length > 3 ? " 等 " + names.length + " 个" : "");
          return (
            T("conflictRefused", "已拒绝启动") +
            "：" +
            (listed || "机器级单例程序") +
            (r.advice ? " —— " + T("conflictWays", "先退出它们，或点「强制启动」接受风险") : "")
          );
        }
        if (err === "view-only") return T("viewOnly", "只读模式：尚未接管，未发送输入");
        if (r && r.network) return T("actUnreachable", "服务未响应，操作未发送");
        return label + " " + T("actFailed", "失败") + "：" + err;
      };

      const act = (path, label) => (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
        setInputMsg("");
        Promise.resolve(v.call(path, label))
          .then((r) => {
            if (r && r.ok === false) setInputMsg(actError(r, label));
            else if (r && r.action === "start") setInputMsg(T("startRequested", "已受理：正在启动（约 1 分钟）…"));
          })
          .catch(() => setInputMsg(T("actUnreachable", "服务未响应，操作未发送")));
      };

      // ---- P1 step panel: "current task · step n · last status" + the last ten steps ----
      const tk = v.task;
      const allSteps = tk && Array.isArray(tk.steps) ? tk.steps : [];
      const shown = allSteps.slice(-10);
      const lastStep = shown.length ? shown[shown.length - 1] : null;
      const sum = tk && tk.summary;
      const toolName = (t) => String(t || "").replace(/^vdesk_/, "");
      const taskLine = !tk
        ? "无进行中的任务"
        : sum
          ? "任务已结束 · " +
            (sum.ok ? "成功" : "失败") +
            " · 共 " +
            (sum.total === undefined ? allSteps.length : sum.total) +
            " 步" +
            (sum.failed ? " · 失败 " + sum.failed : "") +
            " · " +
            Math.round((sum.durationMs || 0) / 1000) +
            "s"
          : "当前任务 · 第 " +
            allSteps.length +
            " 步" +
            (lastStep
              ? " · 最近：" + toolName(lastStep.tool) + (lastStep.ok === false ? " 失败" : " ok")
              : "");
      const stepList = shown.length
        ? h(
            "div",
            { className: "steps" },
            shown.map((s) =>
              h(
                "div",
                { key: "step-" + s.n, className: "step" + (s.ok === false ? " bad" : "") },
                "#" +
                  s.n +
                  " " +
                  toolName(s.tool) +
                  (s.ok === false ? " 失败" : " ok") +
                  (s.ms === undefined ? "" : " · " + s.ms + "ms")
              )
            )
          )
        : null;

      const btn = (label, path, disabled, primary, title) =>
        h(
          "button",
          {
            type: "button",
            className: primary ? "primary" : "",
            disabled: !!disabled,
            title: title || label,
            onClick: act(path, label),
          },
          label
        );

      // ---- P4 live area: MJPEG frames + click / drag straight into the session ------------------
      // Every input goes through the monitor (8791) so its takeover lock stays the single source of
      // truth; its answers are surfaced verbatim, "view-only" included.
      const postJson = (path, body) =>
        fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });

      const explain = (j, status) => {
        if (j && j.ok === true) return "";
        const err = j && j.error ? String(j.error) : "http " + status;
        if (err === "view-only") return T("viewOnly", "只读模式：尚未接管，未发送输入");
        const idx = j && typeof j.index === "number" ? "（第 " + (j.index + 1) + " 个事件）" : "";
        return T("inputFailed", "输入失败") + "：" + err + idx;
      };

      const send = (fn) => {
        Promise.resolve()
          .then(fn)
          .then(async (res) => {
            let j = null;
            try {
              j = await res.json();
            } catch {
              j = null;
            }
            setInputMsg(explain(j, res && res.status));
          })
          .catch(() => setInputMsg(T("inputUnreachable", "服务未响应，输入未发送")));
      };

      const doClick = (p, button) =>
        fetch(API + "/click?x=" + p.x + "&y=" + p.y + "&button=" + (button || "left"), {
          method: "POST",
          cache: "no-store",
        });

      const onDown = (ev) => {
        const r = frameRect(ev.currentTarget);
        if (!r) return;
        const p = normPoint(ev.clientX, ev.clientY, r);
        dragRef.current = { start: p, pts: [p], moved: false, button: mouseButton(ev.button), pid: ev.pointerId };
        const el = ev.currentTarget;
        if (typeof el.setPointerCapture === "function" && ev.pointerId !== undefined) {
          try {
            el.setPointerCapture(ev.pointerId);
          } catch {
            /* capture is a nicety, not a requirement */
          }
        }
        if (typeof ev.preventDefault === "function") ev.preventDefault();
      };

      const onMove = (ev) => {
        const d = dragRef.current;
        if (!d) return;
        const r = frameRect(ev.currentTarget);
        if (!r) return;
        const p = normPoint(ev.clientX, ev.clientY, r);
        if (!d.moved && (Math.abs(p.x - d.start.x) > DRAG_MIN || Math.abs(p.y - d.start.y) > DRAG_MIN)) {
          d.moved = true;
        }
        if (d.moved) d.pts.push(p);
      };

      const onUp = (ev) => {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d) return;
        if (ev.currentTarget && typeof ev.currentTarget.releasePointerCapture === "function" && d.pid !== undefined) {
          try {
            ev.currentTarget.releasePointerCapture(d.pid);
          } catch {
            /* already released */
          }
        }
        const r = frameRect(ev.currentTarget);
        const end = r ? normPoint(ev.clientX, ev.clientY, r) : d.start;
        if (!d.moved) {
          send(() => doClick(d.start, d.button));
          return;
        }
        if (d.pts.length < 2) d.pts.push(end);
        const events = dragEvents(thinPoints(d.pts, MAX_MOVE_PTS), d.button);
        send(() => postJson("/input", { events }));
      };

      const onRetry = (ev) => {
        ev.stopPropagation();
        setStreamErr(false);
        setLiveNonce((n) => n + 1);
      };

      // Mounted only while the keeper holds a session and the helper is healthy. Closing the tab
      // unmounts this component, so no stream keeps pulling in the background. A frame error swaps
      // in a placeholder with a manual retry (never an auto-retry loop).
      const liveReady = v.up && v.helperOk;
      const liveArea = !liveReady
        ? null
        : h(
            "div",
            { className: "livewrap" },
            h(
              "div",
              { className: "livetitle" },
              h("span", null, T("liveTitle", "实时画面")),
              h("span", { className: "livenote" }, T("liveHint", "点击 / 拖拽直接操作"))
            ),
            streamErr
              ? h(
                  "div",
                  { className: "liveph" },
                  h("div", null, T("liveFailed", "画面加载失败（服务未就绪或流已结束）")),
                  h("button", { type: "button", onClick: onRetry }, T("liveRetry", "重试"))
                )
              : h("img", {
                  key: "vdesk-live-" + liveNonce,
                  className: "liveimg",
                  alt: T("liveTitle", "实时画面"),
                  draggable: false,
                  src: liveStreamUrl(),
                  onError: () => setStreamErr(true),
                  onPointerDown: onDown,
                  onPointerMove: onMove,
                  onPointerUp: onUp,
                  onPointerCancel: onUp,
                  onContextMenu: (ev) => {
                    ev.preventDefault();
                    const r = frameRect(ev.currentTarget);
                    if (r) send(() => doClick(normPoint(ev.clientX, ev.clientY, r), "right"));
                  },
                }),
            inputMsg ? h("div", { className: "liveerr" }, inputMsg) : null
          );

      // ---- P3-C: machine-wide singleton conflict (amber warning + explicit force button) ----
      const conflictFound = v.conflict && Array.isArray(v.conflict.found) ? v.conflict.found : [];
      const conflictNames = conflictFound
        .map((f) => String((f && f.name) || "").replace(/\.exe$/i, ""))
        .filter(Boolean)
        .join("、");
      const conflictLine = conflictFound.length
        ? "⚠ 检测到 " + (conflictNames || conflictFound.length + " 个") + " 在运行，启动可能双崩"
        : "";

      return h(
        "div",
        { className: "dsh-vdesk-panel" },
        h(
          "div",
          { className: "grid" },
          btn(
            v.busy === "开启" ? "开启中…" : "开启",
            "/vdesk/start",
            !!v.busy || v.up || !v.reachable,
            !v.up,
            conflictFound.length
              ? "会被拒绝：" + (conflictNames || conflictFound.length + " 个") + " 正在运行 —— 请用「强制启动」，或先退出它们"
              : undefined
          ),
          btn(v.busy === "关闭" ? "关闭中…" : "关闭", "/vdesk/stop", !!v.busy || !v.up),
          btn(
            v.busy === "重启" ? "重启中…" : "重启",
            "/vdesk/restart",
            !!v.busy || !v.up,
            false,
            "先停再起（约 1 分钟）"
          ),
          btn(
            v.busy === "窗口" ? "处理中…" : v.windowed ? "关闭窗口" : "独立窗口",
            "/vdesk/window?on=" + (v.windowed ? "0" : "1"),
            !!v.busy || !v.reachable,
            false,
            "原生 RDP 窗口（不是网页）：可直接用鼠标键盘"
          )
        ),
        // Always show the last action result while the live area is NOT on screen (when it is,
        // the same message is rendered inside it as .liveerr).
        !liveReady && inputMsg ? h("div", { className: "actmsg" }, inputMsg) : null,
        h("div", { className: "meta" }, meta),
        liveArea,
        conflictFound.length
          ? h(
              "div",
              { className: "conflictwrap" },
              h("div", { className: "conflictline" }, conflictLine),
              btn(
                v.busy === "强制启动" ? "启动中…" : "强制启动",
                "/vdesk/start?force=1",
                !!v.busy || v.up || !v.reachable,
                false,
                "确认接受风险：忽略单例冲突启动（会记入 status 与任务 journal）"
              )
            )
          : null,
        h("div", { className: "taskline" }, taskLine),
        stepList
      );
    }

    /** Tab chip: the same mark as the guide capsule, then the localized name. */
    function VdeskTabTitle() {
      return h(
        "span",
        { className: "dsh-vdesk-title" },
        h(VdeskArtwork, { size: 14 }),
        h("span", null, T("tabTitle", TAB_TITLE))
      );
    }

    return {
      inject: ["slots", "sidebarRightTabs"],
      apply(ctx) {
        injectCss();
        // P4 locale: register the live-area copies when the host exposes the locale service. Guarded
        // because the browser half declares ["slots", "sidebarRightTabs"], so this may be absent --
        // the in-bundle copies are then used and the page behaves identically.
        try {
          if (ctx && ctx.locale && typeof ctx.locale.register === "function") {
            const dict = { zh: ZH, en: EN };
            if (typeof ctx.effect === "function") ctx.effect(() => ctx.locale.register(NS, dict), "dsh-vdesk: dictionaries");
            else ctx.locale.register(NS, dict);
            if (typeof ctx.locale.bind === "function") localeT = ctx.locale.bind(NS);
          }
        } catch {
          /* keep the in-bundle copies */
        }
        // The entry point moved from the left sidebar's panel list to the right Sidebar's guide:
        // one page type + one guide capsule (the icon card the user sees in「开始」), then the body
        // and chip title for that type. No left-sidebar row and no DOM interception any more.
        if (!ctx || !ctx.sidebarRightTabs || typeof ctx.sidebarRightTabs.register !== "function") {
          console.warn("[dsh-vdesk] sidebarRightTabs service is missing; the 虚拟桌面 page cannot register");
          return;
        }
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => T("tabTitle", TAB_TITLE),
              guide: [
                {
                  id: "vdesk",
                  order: 80,
                  title: () => T("tabTitle", TAB_TITLE),
                  description: () => T("guideDescription", "开启 / 关闭 · 实时画面 · 独立窗口"),
                  icon: VdeskArtwork,
                },
              ],
            }),
          "dsh-vdesk: right-Sidebar tab type"
        );
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, VdeskPanel)
        );
        ctx.slots.inject("sidebar.right.pane.tab.title", () =>
          ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, VdeskTabTitle)
        );
      },
    };
  },
});
