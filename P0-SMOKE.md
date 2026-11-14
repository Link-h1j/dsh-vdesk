# P0-C 冒烟报告：CLI 端到端（记事本 + 中文 + 截图）

环境：2026-10-02 10:15–10:18（+08:00）；启动前 qwinsta 无 `#` 子会话行，**未检测到外来子会话，安全阀未触发**（8791 上已有一个 10-01 22:30 起的遗留 monitor，pid 43160，与本任务无关）。
启动：`powershell -NoProfile -ExecutionPolicy Bypass -File vdesk.ps1 start -Minutes 240` → exit 0，耗时 53.1s；子会话 **id=23**，keeper **pid=47844**，helper `{ok:true,1280x800}`；`vdesk-cli.mjs status` → `keeper.phase=holding`、`helper.ok=true`、`candidates=23:s0`。

## 截图实测（每项 3 次；ms 为 CLI 内部计时，不含 node 启动）
| 命令 | 体积 KB | 单次 ms |
|---|---|---|
| `shot --format jpg --scale 0.75` | 131 / 131 / 131 | 65 / 45 / 52 |
| `shot --format png --scale 1` | 1380 / 1380 / 1380 | 85 / 101 / 69 |

备注：jpg 0.75 恒为 133669 B、png 1.0 恒为 1412697 B（静态桌面，逐次完全一致）；证据副本 `out\shots\p0c-bench-jpg3.jpg`、`out\shots\p0c-bench-png3.png`。

## 冒烟步骤与结果
| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 3 | `key ctrl+esc` | ok，开始菜单弹出（键盘可用，与输入法无关） | `out\shots\p0c-01-startmenu.png` |
| 4a | `key win+r` | ok（vks=91,82），「运行」框弹出 | `out\shots\p0c-02-runbox.png` |
| 4b | `type notepad` | **sendinput 路径在运行框内乱码**：显示 `mlg-kcw`（运行框原文本 `cmd` 未自动选中） | `out\shots\p0c-03-notepad.png`、`p0c-04-ascii-map.png`（a–z → `zyxwvutsrqponmlkjihgfedcba`） |
| 4c | `clipboard set notepad` + `key ctrl+v` + `key enter` | ok：剪贴板路径文本正确落入运行框并回车 → 记事本启动 | `p0c-05-paste-notepad.png`、`p0c-09-notepad-launched.png` |
| 5 | `type 豆包虚拟桌面测试` | **ok，`via=clipboard+ctrl+v`，`set.chars=8`**；`clipboard get` 回读完全一致；记事本正文出现该 8 字（第 1 行第 9 列、状态栏「8 个字符」） | `out\shots\p0c-12-chinese.png` |
| 5b | `type ABC-42`（纯 ASCII，sendinput） | 记事本内**精确正确**（说明 sendinput 本身没问题，乱码只发生在运行框这个控件） | `out\shots\p0c-13-ascii-in-notepad.png` |

中文路径结论：**成功**，路径为 `type(非 ASCII) → helper GET /clipboard?action=set(UTF-8 URL 编码) → key ctrl+v`，双重验证（截图看图 + clipboard 回读）。

## 收尾
`vdesk.ps1 stop` 10:18:48 → 10:18:58 exit 0（注销子会话 23、停 helper）；`qwinsta` 中 `#` 行数 **= 0**，仅 services/console/rdp-tcp；`status` → `keeper.stopped=true`、8790 已释放。本任务只新增 `P0-SMOKE.md` 与 `out\shots\*`，未改任何源码。

## 遗留问题（未修，仅报告）
1. **运行框 ASCII `type` 乱码**：`notepad→mlg-kcw`、`abcde→zyxwvu`、a–z→倒序；记事本内同一命令正确 → 疑似运行框 AutoComplete/编辑控件对注入字符的兼容问题，未定位根因；建议运行框一律走 `clipboard set`+`ctrl+v`。
2. `click 0.632 0.365` 本意点开始菜单「记事本」磁贴，实际打开了「手机连接」（布局/坐标映射需复核，随后误回车把 Enter 送进了该窗口）。
3. 记事本会**恢复上次会话**并直接打开用户的 `changes.md`（带未保存提示 + MOTW「不受信任来源」提示）；本次一律选择「重新打开文件/取消」以保证不写用户文件，自动化前应先 `ctrl+n` 开新标签。
4. 8791 上的遗留 monitor（pid 43160）`stop` 不回收，是否有意为之未验证。
5. 未验证项：`window on/off`、（原生窗口模式）、`dblclick/drag/scroll`、`wait-stable`。→ 已由下面 P0.5 一节补齐。

---

# P0.5 补充验证（2026-10-02 10:22–10:30）

环境：启动前 `qwinsta` 无 `#` 行（无外来子会话，安全阀未触发）；`vdesk.ps1 start` exit 0（53.3s）→ 子会话 **id=24**、keeper **pid=38088**、helper `{ok,1280x800}`；`vdesk.ps1 stop` 10:29:46→10:29:56 exit 0，`qwinsta` 中 `#` 行 **= 0**，`status`→`keeper.stopped=true`。本轮用了 1 次真实鼠标拖动（已按闸门授权）。
两个环境事实：① `status.helper` 本轮**恒为 null**（8791 上 monitor 是 10-01 遗留进程，不跟踪 helper），但 `/health` 正常 → **判就绪不要用 `status.helper.ok`**；② `vdesk-cli.mjs` 在本任务期间被 task-6 改动（sha256 `BAC52A92…`→`7DF89037…`）；本节未用 `type` 命令，结论不受影响。

### ① 坐标映射：**正确**（冒烟②是读数错误，不是映射错误）
- `click 0.02 0.99` → 实际 (26,792) → 开始菜单弹出（`out\shots\p05-01-startmenu-open.png`）。
- 在同一帧上量出「记事本」磁贴中心 (560,290)=0.4375,0.3625 → 点击 → **记事本启动**（`p05-02-click-notepad-tile.png`）。结论：归一化 = `round(x*1280)`,`round(y*800)`（helper /health 报 1280x800），无系统偏移、无需 DPI 缩放。
- **冒烟②根因**：P0-C 用的 0.632/0.365=(809,292) 落在开始菜单**右侧「你的移动设备」卡片**里 → 复现实验**再次打开「手机连接」**（`p05-03-a3-negative.png`）。即坐标一直是对的，是当时从 0.75 缩放帧上错认了磁贴位置。附带：该布局下左栏宽 650px，`click 0.5 0.5`=(640,400) **仍在菜单内**（不会关闭菜单，任务里"点桌面空白"的建议在此布局不成立），改点任务栏空白 `0.5 0.995` 才关闭（`p05-04`、`p05-05`）。

### ② dblclick / drag / scroll：**均通过**
- dblclick：`dblclick 0.4883 0.3338` 双击我自建临时夹 `%TEMP%\dsh-childsession\p05-dbl\sub` → 地址栏变 `…>p05-dbl>sub`、列表出现 inner.txt（`out\shots\p05-08-dblclick-sub.png`）。桌面**没有回收站图标**，故用自建临时夹替代（收尾已删除）。
- drag：`drag 0.508 0.134 0.703 0.375` 拖资源管理器标题栏 (650,107)→(900,300) → 窗口整体位移 **+250,+193**（`p05-09-drag-window.png`）。
- scroll：记事本 `ctrl+n` 新标签 → `clipboard set` 80 行（1679 字符，状态栏「行 80」）→ `scroll 0.5 0.4 ±600`：**+600 视口向文档头移 15 行、−600 向尾移 15 行**（`p05-10`…`p05-14`）。
- **发现（文档与实现相反）**：CLI 头部注释写 `delta>0 = down`，实测 **delta>0 = 滚轮上（向文档头）**、delta<0 = 滚轮下；600 = 5 格 = 15 行。
- 附加发现：`shot --rect` **无效**——helper 忽略 rect，带 rect 的请求与整屏请求体积完全相同（1072KB）。

### ③ wait-stable：**通过**
- 静态：`wait-stable --ms 6000 --diff 2.0` → `{stable:true, elapsedMs:807, diffPct:0}`。
- 动态：后台跑同一命令，同时 10 轮 ±600 滚动制造变化 → `{stable:false, elapsedMs:6046}`（正确地"等不稳定"）。

### ④ window on/off：**通过**（附一个权限层发现）
- `window on` → 真实窗口出现：hwnd 723816（此后因 ShowInTaskbar 切换重建为 789352）、标题「DSH 虚拟桌面（子会话）」、class `WindowsForms10.Window…`、rect **80,80,1376,919**（1296x839 = 1280x800 + 16/39）、pid 38088（keeper）。
- 样式：`style=0x16CF0000`（WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MIN/MAXBOX|WS_VISIBLE）、`exstyle=0x00050100`（**无 WS_EX_LAYERED**、无 TOOLWINDOW）→ 标准可拖动/可缩放窗口；`keeper.ps1:241` 只在开关**切换时**设位置，**不会把窗口拉回**。
- **可移动性已实证**：用本项目自己的 SYSTEM 桥 `launch-in-session.ps1 -SessionId 1` 跑探针（与 keeper 同为提权 IL）→ SetWindowPos 成功，rect **80,80 → 400,300（+320,+220）**，并在随后约 200 个 200ms tick 内保持不动。证据：`%TEMP%\dsh-childsession\p05-move.log`（第二次运行读到 `before=400,300,1696,1139`）、探针 `p05-move.ps1`。
- **权限层发现**：本会话（Medium IL）对 keeper 窗口 `SetWindowPos` 返回 False/`GetLastError=5`(ACCESS_DENIED)，真实鼠标拖标题栏（已用 `WindowFromPoint(700,95)` 确认该点就是此窗口标题栏）**窗口纹丝不动** —— 因为 keeper 由 SYSTEM 桥以**未过滤 Administrator 令牌（High IL）**启动，UIPI 拦截了跨 IL 的窗口消息与 SendInput 注入（SendInput 被拦**不报错**）。**这不是窗口缺陷**：真实用户的物理鼠标不走 SendInput、不受 UIPI 限制，可以拖动；若后续要程序化控制它，必须在同等 IL 下运行。
- `window off` → 窗口不销毁，而是 `ShowInTaskbar=false` + 移到 **-3200,-3200**，尺寸被 `MinimumSize 520x400` 夹住（代码想缩到 320x200，实际 520x400）→ 完全离开可视区，`WindowFromPoint(700,95)` 不再命中；子会话不受影响（`phase=holding`）。

### ⑤ 8791 monitor 控制台窗口：**通过（无可见终端，无需重启服务）**
- monitor = pid 43160 `node.exe "…\Temp\dsh-childsession\vdesk-monitor.mjs"`（起于 10-01 22:30:03，父进程已退出）。
- 它有 `ConsoleWindowClass` 顶层窗口（hwnd 2950734），但 **IsWindowVisible=False** → 任务栏/桌面上没有属于它的终端窗口，故**未**执行 `vdesk-visible.ps1 -NoWindow` 重启。
- 本会话唯一的可见终端是 `CASCADIA_HOSTING_WINDOW_CLASS`（pid 2128 WindowsTerminal，起于 10:19:24，标题 `powershell.exe`），与 vdesk-monitor 无关（monitor 的窗口标题是 `node.exe`）。

### P0.5 遗留 / 未验证
- 仍未定位：运行框 ASCII `type` 乱码（P0-C ①）；`shot --rect` 无效；`scroll` 符号与注释相反；隐藏窗口尺寸被 MinimumSize 夹住（无害）；`status.helper` 恒 null。
- 未验证：`move` 命令；`window on` 状态下**用真实鼠标**拖动（受 UIPI 限制，需提权上下文或用户手动复核）；`dblclick` 用的是自建临时夹（桌面无回收站图标）。清理情况：`p05-dbl` 已删，`p05-move.ps1/.log` 留在 `%TEMP%\dsh-childsession` 作证据。
