# P4 收口报告 —— B 组欠账（对标豆包）

> **2026-10-21 更新：入口已从左侧栏移到右侧栏。** 用户要求把「虚拟桌面」图标从左侧
> 面板列表挪到右边栏。现在浏览器半区注册的是右侧栏页类型 `vdesk` + 它的 guide 卡片
> （`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` + `ctx.sidebarRightTabs`），
> 左栏不再有这一行，也不再需要拦截宿主行点击的 DOM 补丁。本文档下列「侧栏折叠菜单」
> 的描述是当时的历史实现，功能（开启/关闭/重启/独立窗口/步骤面板/直播区）未变。

> 日期：2026-10-02 · 负责：Lead + 3 个并行子 Agent（task-1 stream-dev / task-2 tools-dev / task-3 panel-dev）
> 范围：`tools/vdesk-childsession`。真机子会话 session 35 全程保持存活，**没有** stop/start/restart 会话、**没有**干扰豆包。

---

## 一句话结论

本报告记录 P4 交付的 B 组五项欠账（实时流与批量输入、侧栏内嵌直播面板、剪贴板、按下/抬起、等画面稳定）及验收结果：18 套 mock 自检全绿、helper 自检 ok=43、真机整链 ok=18 fail=0、真机 CLI 走通 B3/B4/B5，重启 DSH 并刷新页面即可使用。

## 0. 一句话

B 组五条欠账全部交付并验收：**B1 实时流(MJPEG)+持久批量输入**、**B2 DSH 侧栏内嵌直播面板**、**B3 剪贴板工具**、**B4 按下/抬起**、**B5 等画面稳定**。
mock 自检 **18 套全绿**、helper 纯函数自检 **ok=43**、真机整链验收 **ok=18 fail=0**、真机 CLI 走通 B3/B4/B5。
剩最后一步「**生效**」：宿主半区要完整重启 DSH、浏览器半区要刷新页面（见 §6）。

---

## 1. 交付物（谁写的）

| # | 交付 | 文件 | 作者 |
|---|---|---|---|
| B1 | helper `GET /stream`（MJPEG，逐字节冻结分帧、fps 节流、断连即释放、JPEG 编码器进程级缓存） | `helper/dsh-vdesk-helper.cs` → `helper/dsh-vdesk-helper.exe` | T1 |
| B1 | helper `POST /input` + `GET /input?events=`（move/down/up/click/drag/scroll/key/combo/text；≤1 归一化 >1 像素） | 同上 | T1 |
| B1 | helper `--selftest`（43 条纯函数断言，在 FreeConsole/控制台守卫/监听**之前**） | 同上 | T1 |
| B1 | `/key` 未知 action：静默 `ok:true` → **400**（消除静默失败） | 同上 | T1 |
| B1 | monitor `GET /stream`（token+钉扎、multipart 原样 pipe、401 透出、断连 destroy upstream）、`POST /input`（Origin 白名单 + 接管锁）、`/click` 接受归一化坐标 | 生成器 `make-vdesk-monitor.mjs` → `vdesk-monitor.mjs` | T1 |
| B1 | 生成器唯一真源 + 逐字节可复现 | 同上 | T1 |
| B3 | `vdesk_clipboard {action:get\|set}` + CLI `clipboard get\|set`（4000 字符截断，UTF-8 转义） | `plugin/dsh-vdesk/index.js`、`vdesk-cli.mjs` | T2 |
| B4 | `vdesk_key {action:combo\|down\|up}`（down/up 走 `/input`；多键拒绝；旧 helper 诚实报错）+ CLI `key --action` | 同上 | T2 |
| B5 | `vdesk_wait {stable:true,…}`（轮询小图，连续 N 帧字节相同即稳定；超时诚实失败）+ CLI `wait --stable` | 同上 | T2 |
| B2 | 侧栏折叠菜单内嵌直播区（8791 `/stream` 的 `<img>`，展开+运行+helper 就绪才挂载；单击 `/click`、拖拽单次 `/input`；失败占位+重试；不绕接管语义） | `plugin/dsh-vdesk/client.js`、`locale/*.json` | T3 |
| — | **`vdesk.ps1 helper`**：只热替换子会话内的 helper，不拆会话、不抢唯一名额 | `vdesk.ps1` | Lead |
| — | 真机验收台 `accept-p4.mjs`（18 项） | `accept-p4.mjs` | Lead |

产物哈希：helper exe **60928 B** @13:30:49 SHA256 `A54BA5EC…4FA2`；`vdesk-monitor.mjs` **43134 B** SHA256 `FF73787B…0C75`。

## 2. 冻结接口（真机已按此验证）

- `GET /stream?format=jpg|png&quality&scale&fps&cursor&maxSeconds[&rect]` → `Content-Type: multipart/x-mixed-replace; boundary=dshframe`，每帧 `--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: <n>\r\n\r\n<bytes>\r\n`。
- `POST /input` body `{"events":[…]}` → 成功 `{"ok":true,"count":N,"ms":M}`；结构/字段非法 → **400** `{"ok":false,"index":i,…}`（一个都没执行）；执行中出错 → 200 `{"ok":false,"index":i,…}`（i 之前已执行）。
- 8791 `/stream` 与 `/input` 的查询/字段与 helper 逐字一致；`/input` 属写路由（非白名单 Origin → 403）且受接管锁约束。

## 3. 验收证据

### 3.1 mock / 纯函数（18 套，全 fail=0）
```
selftests/selftest-p4-stream.mjs   ok=40    p4-tools ok=58   p4-panel ok=72
selftests/selftest-p0-tools.mjs    ok=158   p05-type ok=55   p1-tasks ok=53
selftests/selftest-p1-panel.mjs    ok=30    p2a-node ok=22   p2bc     ok=46
selftests/selftest-p06-auth.mjs    ok=48    p09-monitor ok=20
真实 temp 原件 selftest-p3c-monitor.mjs  ok=20（此前在本沙箱被 spawn EPERM 挡住，现复跑通过）
selftests/selftest-p4-helper-redeploy.ps1 ok=20   p09-keeper ok=49
selftests/selftest-p2a-resolution.ps1     ok=21   p3c-conflict ok=28   p3b-startup ok=44
helper\dsh-vdesk-helper.exe --selftest    ok=43
```

### 3.2 真机整链 `node accept-p4.mjs` → **ok=18 fail=0**
- helper `/stream`：200 + `multipart/x-mixed-replace; boundary=dshframe`，**25 帧 / 3.25 s ≈ 7.7 fps（请求 8 fps）**，平均 65.9 KB/帧，25/25 帧 Content-Length 与字节数一致且为 JPEG(FFD8)
- 客户端断开后 helper 仍存活；无 token → 401；`/screenshot`/`/apps`(200 项)/`/clipboard` 零回归
- `/input`：4 事件批量 `{"ok":true,"count":4,"ms":15}`；非法事件 → `400 {"ok":false,"index":0,"error":"unknown event type: nope"}`；GET 形式可用
- monitor `/stream` 透传 13 帧；`/input` 非白名单 Origin → **403**、白名单 → 200；`/shot` 零回归

### 3.3 真机 CLI（不依赖宿主重启，直接打真 helper）
- B3：`clipboard set "P4-accept 13:36:17"` → `get` 读回同一串（chars=18）
- B4：`key shift --action down/up` → `ok:true action=down/up count=1`；`key ctrl+shift --action down` → 诚实拒绝 `action:down needs exactly one key (got 2)`
- B5：`wait --stable` → `{ok:true,stable:true,attempts:4,elapsedMs:1348,lastDiffBytes:0}`

## 4. Lead 侧顺带修掉的真缺陷

1. **`make-helper.ps1` 是破坏性的**（T1 发现）：它会把 `helper/*.cs` 从 `isolated-desktop/guest/dsh-agent.cs`（13 KB 老 agent）**重新派生**，跑一次就抹掉 P0~P4 全部功能。已改为默认只编译、旧派生逻辑收进 `-Regen`（带 LOSSY 警告），并补上 .ps1 的 UTF-8 BOM。
2. **`vdesk.ps1 helper` 的复制竞态**（Lead 现场抓到的）：`Stage` 在停旧 helper **之前**执行，而旧 helper 锁着执行区里的 exe → `Copy-Item` 失败、**新构建永远落不了地**（首次实测 stderr 就是这条）。且 Bridge 是**异步返回**的，光调换顺序不够。最终：kill → 用「重试到真正成功」的循环复制（实测第 3 次成功）→ 打印 `workspace exe` vs `staged exe` 逐项核对 → 启动。

## 5. 环境/踩坑（写下来省下一次）

- 沙箱（workspace-write）下 **`C:\Users\Administrator\AppData\Local\Temp\dsh-childsession` 只读**（读 OK、写「访问被拒绝」），且 `$env:TEMP` 是私有目录 `…\Temp\dsh-xxxx`，**不等于**项目真实临时目录 → 三个 Agent 改成"新建自检放工作区 `selftests/`、旧测试复制到工作区改副本"。
- 沙箱不给子进程开命名管道：`spawn(..., {stdio:'pipe'})` → `spawn EPERM`（副本改用文件 fd 后全绿）。**这条也解释了此前 `p3c-monitor.mjs` 的假失败。**
- `p3b-startup.ps1` 的 2 条 FAIL 是**环境性**的：活会话把 `Startup` 持有成 `Startup.vdesk-held` 时，"原始状态"断言必然失败。工作区副本改成**自证**：若处于持有态，则断言"这次持有可归因于我们自己的 marker（original + held 指向 Startup.vdesk-held + pid + heldAt）"→ 44/0；只读原件未改（仍 42/2，属预期）。
- 生效条件：`plugin/dsh-vdesk` 在 desktop profile 里是**指向工作区的 Junction**（client.js/index.js 哈希与工作区一致）→ 重启 DSH 会加载新 index.js，刷新页面会加载新 client.js。

## 6. 生效与遗留

**要让 B2/B3/B4/B5 在界面里可用（两步，按代价从小到大）**
1. **刷新页面**（Ctrl+R）：client.js 是浏览器半区 → 侧栏出现直播画面。`/stream`、`/input` 已由本次真机验收证明可用，无需再等服务重启。
2. **完整重启 DSH 桌面版**：`index.js` 是宿主半区 → 工具表才会出现 `vdesk_clipboard`、`vdesk_key action:down|up`、`vdesk_wait stable`（当前会话里这三个工具**还没注册**，是设计使然，不是坏了）。

**遗留（都不阻塞）**
- monitor 自带的独立窗口页面仍用 `/shot` 轮询（T1 保留原交互；观感升级由 T3 的 DSH 内嵌面板承担）。
- 面板 `<img>` 的 `maxSeconds=300`：连续看 5 分钟后停在最后一帧，**收起再展开即重挂**。
- 面板文案仍未走 `ctx.locale` 服务（要改 package.json 的 `dsh.client.inject`，会牵动 P1 的注入断言）；当前用内联兜底，中文正常。
- 独立窗口/面板宽度 190–260 px。

---

## 7. P4.1（2026-10-02 晚）· 修复「点不起开启」

**用户录屏（14:47）**：在侧栏「虚拟桌面」里反复点「开启」，没有任何反应。

**真因（三层把拒绝吃掉了）**
1. `vdesk.ps1 start` 检测到机器级单例程序 → **`exit 4` 拒绝**（当时 13 个腾讯套件进程）；
2. monitor 的 `vdeskRun()` 是 **fire-and-forget**（`spawn` + `unref`，立刻返回 `{ok:true,"spawned pid N"}`）→ 把"已拒绝"报成了"已启动"；
3. 面板 `call()` **把 fetch 响应整个丢弃**（只 catch 网络错）→ 界面上一个字都没有。

三者叠加：按钮闪一下 → 看着就是"点不起"。

**修法**
- monitor `/vdesk/start`：**先同步探测**（只读、带缓存）。有冲突且未 `force` → **409** `{ok:false,error:"singleton-conflict",found:[…],advice:"…"}`，**一个进程都不 spawn**；`force=1` 才 spawn。
- 面板：`call()` 解析并返回响应体；失败时在菜单里渲染 `.actmsg`（写明命中的进程名与「强制启动」出路）；冲突存在时「开启」的 tooltip 预告会被拒绝；新增 zh/en 文案 5 键（含自带字典镜像）。
- 测试钩子：`VDESK_LOG` 可覆盖（与既有 `VDESK_PS1`/`VDESK_KEEPER_JSON` 同风格）。

**验收**：新回归 `selftests/selftest-p4-refusal.mjs` **23/0**（普通 start → 409 且零 spawn；force → 200 且真的带 `-Force`）；`p4-panel` **82/0**；`p3c-monitor` 工作区副本按新契约 **21/0**（只读原件 18/2 = 把旧坏行为写成预期，按惯例不动原件）；全量 20 套全绿。**真机**：重启 8791 后 `POST /vdesk/start` → `409` + 13 个命中进程名单 + 处置建议（与用户点「开启」发出的请求逐字一致）。

**同时发现的隐形拦路石**：子会话已从 `qwinsta` 消失，但 `dsh-vdesk-helper.exe`（pid 27860, session 35）仍是孤儿进程并**占着机器级端口 8790**；`keeper.json` 只剩 `{"ok":false,"pid":42452,"stopped":true}`（无 `candidates`）→ 我方 `stop` 也认不出它。**不清掉它，下一次启动的新 helper 会绑不上 8790、没有画面。**
