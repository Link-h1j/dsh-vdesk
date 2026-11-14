# P0.7 隔离测试矩阵（宿主 session 1 ↔ 子会话 guest）

环境：2026-10-02 10:50–（+08:00）；**子会话 28**（keeper pid 21292、holding）；helper 在**子会话内**（pid 17032 session=28，`/health` 返回 1280x800、pointer=null）；8790 除 `/health` 外需 `X-VDesk-Token`（实测无 token → 401，带 token → 200）。
**前提校验（隔离是否成立）**：guest 里打开开始菜单 → 宿主 session 1 的窗口列表**没有出现新窗口**（21→20，唯一变化是 Shell_TrayWnd 消失）⇒ guest 是独立会话，不是宿主桌面的镜像。
**干扰记录（诚实）**：真机用户同时在操作（宿主鼠标位置/前台窗口在两次命令之间自行变化）；task-10 换 helper + 另一个自测 helper 抢占 8790 使我会话 27 的 helper 掉线，10:50 已 `vdesk.ps1 stop/start` 恢复为会话 28。

## 一、键盘：guest 注入 → 宿主（用户最关心）
仪器 = 宿主机内 **WH_KEYBOARD_LL 全局钩子**（不依赖焦点，任何漏到 session 1 的按键都会被记录）+ 宿主记事本 UIA 文本 + 宿主 `GetCursorPos`/`GetForegroundWindow` 采样 + guest 截图。
1. **仪器控制实验**：宿主自己注入 SHIFT 下/上 → 钩子记录 2 条（`vk=160 msg=0x100/0x101`）⇒ 钩子确实能记录注入按键（不是"哑"钩子）。
2. **guest 连续 20 次按键**：`node vdesk-cli.mjs key z --no-after` ×20（另 3 次打印完整 JSON：`{"ok":true,"vks":[90],"result":{"ok":true,"action":"combo"}}`）→ 宿主钩子 **vk=90 事件 = 0 条**；**宿主记事本文本不变**（UIA：len=1，内容 `'\r'`）；宿主 cursor 20 次采样为 `1359,1317 → 1360,1315`（1-2px，真机用户手在鼠标上；若是 guest 泄漏会**跳到 guest 注入坐标**）；宿主前台 hwnd 20 次采样**恒定**（2491602，另一段为 985302），从未变成 guest 坐标。证据：`out\shots\p07-08-after-20keys.png`。
3. **注入确实发生在 guest（不是空转）**：guest 的「运行」框里出现 `notepad` + 一串 `z`/`y` ⇒ 那 20+10 次按键实实在在进了 guest。证据：`out\shots\p07-09-guest-after-3keys.png`、`out\shots\p07-12-guest-runbox-crop.png`。
4. **反向：宿主按键 → guest 无反应**：宿主注入 3×`q` + 3×`p`（钩子记录 `vk=81 ×6`、`vk=80 ×6`，证明宿主按键确实产生）→ guest「运行」框字符为 `notepad` + `y…`，**没有 q/p**（`p07-12-guest-runbox-crop.png`）；guest `/health.pointer` 仍为 `null`。注：宿主控制键注入时宿主记事本**未取得焦点**（真机用户的前台窗口占着焦点，`SetForegroundWindow` 未生效），因此"宿主窗口吃字"这一条以**钩子**为准据；CDP 读 DSH GUI 全部输入框均为空，**未污染用户输入**。
5. **并发**：guest 后台连续 10×`key y` 的同时宿主注入 3×`p` → 钩子 `vk=89(y)=0`、`vk=80(p)=6`；guest 框里只有 `y`、宿主侧只有 `p` ⇒ 两条输入路径互不干扰、互不覆盖。证据：`out\shots\p07-11-guest-after-both.png`。
6. **已知不对称（设计如此，不是泄漏）**：guest **收不到**真机键盘（不同会话，两个方向都隔离）；唯一能把用户的按键送进 guest 的通道是 **`window on` 的原生 RDP 窗口**——RDP 会像 mstsc 一样把该窗口的按键转发进 guest。用户"打字进了 guest"的现象即源于此，**不是隔离失效**。

**键盘结论：已验证隔离（guest→宿主、宿主→guest、并发三项都通过）。**

## 二、鼠标/指针：guest 注入 → 宿主
仪器 = 宿主 `GetCursorPos` 高频采样 + `GetForegroundWindow` + guest `/health.pointer`（helper 只在自己的 `/mouse` 注入后更新该记录）。
1. **五类动作前后宿主指针**（guest 像素坐标：`move 100,100` / `click 640,700` / `dblclick 1240,400` / `drag 300,600→800,600` / `scroll 640,400 -600`）：宿主 cursor 依次 `2056,1005→2051,1003→2042,999→1982,979→1750,998→1635,965` —— **全程连续漂移（真机用户的手就在鼠标上），从未跳到任何 guest 注入坐标**；宿主前台窗口全程恒为 `985302`（用户自己的 DSH 窗口）。行动作后 guest `/health.pointer = {x:800,y:600}`（= drag 终点）⇒ 注入确实落在 guest 内。
   **诚实说明**：用户正在用鼠标，所以"严格前后不变"无法断言；判据改为"(a) 从未等于 guest 坐标 (b) 漂移是人手连续轨迹"。另做**严格版**：guest 连续 `move 5,5` 期间宿主指针高频采样 **0/145 个样本落在 (5,5)±6px 内**。
2. **宿主前台窗口在 guest 点击期间不变**：guest 连点 8 次 `click 640,740`，期间采样 24 次 `GetForegroundWindow` → **全部 985302，changed=False** ✓。
3. **并发 / 两套指针互不覆盖**：guest `12×(move 5,5 + click 5,5)` 的同时宿主 `SetCursorPos(2300,1200)`：宿主指针 **145/145 样本 = 2300,1200**（服从自己的指令）；同一时段 guest `/health.pointer` = `{200,200}` → `{5,5}`（guest 自己的注入值，**与宿主指针停在哪里无关**）；guest 帧差 0.1%（= guest 虚拟光标从 (200,200) 画到 (5,5)，与 task-8 的虚拟光标实现一致）⇒ **互不打断、互不覆盖**。
4. **反向（宿主操作 → guest）**：宿主 `SetCursorPos` 与宿主按键期间，guest 的 `pointer`/画面只反映 guest 自己的注入（见键盘节第 4 条：guest 框里无宿主字符）。

## 三、window on/off（原生 RDP 窗口，只在测试那一刻开启）
`window on` → hwnd 1509468、`rect=80,80,1376,919`、title「DSH 虚拟桌面（子会话）」、`style=0x16CF0000`(CAPTION|THICKFRAME)、`exstyle=0x00050100`、**layered=False**；3 秒后立即 `window off` → 窗口移到 `-3200,-3200`（尺寸被 MinimumSize 夹为 520x400）、`WindowFromPoint(700,95)` 不再命中、`status.windowed=false` ✓（收尾确认未留在开启状态）。
**用户"键盘没隔离"的真正原因（机制，非泄漏）**：`window on` 时真机用户对着那个 RDP 窗口打字会被 RDP **正常转发进 guest**（与 mstsc 相同，设计如此）。跨会话隔离本身没坏：guest 注入的键不会进宿主（键盘节）。此项我只做**机制解释**，**未**用程序化输入复现（我的 SendInput 对该 High-IL 的 keeper 窗口被 UIPI 拦截，见 P0-SMOKE.md 的 P0.5 记录）。

## 结论清单
**已验证隔离**：① 键盘 guest→宿主（钩子 vk=90/89=0、宿主记事本不变）② 键盘 宿主→guest（guest 框无 q/p）③ 键盘并发不干扰 ④ 指针位置（guest 注入不移动宿主指针；宿主 SetCursorPos 不改变 guest pointer 记录）⑤ 宿主前台窗口不被 guest 抢 ⑥ guest 是独立会话（窗口标记实验）⑦ window off 后无残留。
**未验证 / 存疑**：
- "宿主指针在 guest 注入前后**严格**不变"——真机用户同时在用鼠标，只能给"从未等于 guest 坐标且漂移连续"的结论（严格样本 0/145 例外）。
- "用户物理按键经 `window on` 转发进 guest"——仅机制解释，**未实测**。
- 会话 27（10:43 那次）曾出现 guest 画面与宿主画面高度相似（像素差 11.8%），该次的镜像判别实验因 helper 恰好重启失败而**未完成**；当前会话 28 的 guest 桌面与宿主明显不同（干净桌面）+ 窗口标记实验 ⇒ 判定为独立会话。
**环境缺陷（阻塞级，需修）**：`vdesk.ps1` 现为 **UTF-8 无 BOM**（mtime 10:57:01、首字节 `23 20 76 64`），Windows PowerShell 5.1 按 GBK 读 → 第 127 行 mojibake `鎷掔粷鍚姩`（=拒绝启动）→ **`start`/`stop` 全部解析失败**（我 10:56:51 的 `stop` 就因此 exit 1）。该文件头部第 22 行自己写明"必须 UTF-8 with BOM"。我用"写 `out\keeper.stop` + SYSTEM 桥 `logoff`"完成收尾：会话 28 已消失、`qwinsta` 的 `#` 行=0、helper 进程=0、8790 空闲、`keeper.stop` 已删除。
