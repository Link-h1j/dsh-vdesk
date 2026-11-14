# 原生 RDP 窗口「打不开里面的程序」诊断（2026-10-02 11:12–11:22）

**实验环境**：会话 30（**不是我起的**：keeper pid 38592、11:09 起、window 11:09:05 打开 = 用户录屏那一次；11:2x 被其 owner 停掉）→ 我另起**会话 31**（keeper 35744、helper `session=31`、桌面 1280x800）做实验。收尾：`window off` 已确认（`windowed=false`）→ `vdesk.ps1 stop` exit 0 → `qwinsta` `#` 行=0、helper 进程=0、session 31 进程=0；真机桌面无我方窗口/终端。

## 1 几何：client 与桌面严格 1:1（两次独立测量，会话 30/31 各一次）
`window on` 后：`rect=80,80,1376,919`(1296x839)、**client=1280x800**、clientOrigin=88,111、`GetDpiForWindow`=96、系统 DPI=96；helper `/health` 桌面=1280x800 ⇒ **无 letterbox、无缩放**。⇒ Lead 已降权的"落点偏移"假设**不成立**（数据支持）。

## 2 输入路径：`window on` 后焦点**确在** RDP 输入控件里（两次测量）
`GetGUIThreadInfo(keeper UI 线程 47836)`：`hwndActive`=form、**`hwndFocus`=IHWindowClass（mstscax 的 input-host 子窗口）**；系统前台窗口=form。⇒ "控件从不拿焦点"假设**不成立**（至少在 on 刚完成时）。
`keeper.ps1`（11:57:48 版）全文**没有** `.Focus()`/`.Select()`/`GrabFocusOnConnect`/`EnableInput`/`TabStop`/`KeyPreview` 的任何设置，只在 ApplyWindow 里调 `$form.Activate()`（keeper.ps1:224）；RDP 子窗口 style 里也**无 WS_TABSTOP**。keeper 实际设置的 RDP 选项仅：`Server`、`UserName`、`DesktopWidth/Height=1280/800`、`AdvancedSettings7.EnableCredSspSupport=true`、`[IMsRdpClientAdvancedSettings] put_ClearTextPassword`（idx112）、`put_AuthenticationLevel=0`（idx147，不校验证书）、`[IID_NS5] FnBool(idx63)=false`（**该索引对应的属性名未证实**，keeper 无注释）、`[IID_Ext] ConnectToChildSession=true`。→ 这批里**没有**渲染/DWM 相关项。

## 3 ★关键新发现：guest 桌面图标层对注入点击**完全无响应**（在 guest 内复现，与宿主无关）
- guest 内注入：`win+d` 显示桌面后 `click(595,370)`+`Enter`、`dblclick(595,370)`（Discord 图标）→ **两次截图逐字节相同**（sha256 `ebaf7137…`）、无 Discord 进程、无选中高亮；而 `/health.pointer` 确实更新为 `{595,370}`（注入**到达**了 guest）。
- 同会话同时刻对照：**任务栏点击有效**（点任务栏记事本按钮 → 窗口恢复，帧 1381KB→95KB）、开始菜单搜索启动记事本 ✓、`win+r` ✓、`win+e` ✓。
⇒ **不是"输入没进 RDP"，也不是"点偏了"，而是 guest 里"桌面图标这一层"不吃注入点击**；同一批注入对任务栏/窗口/键盘全部有效。这正是"在原生窗口里点不开程序"的已复现机理（用户录屏中"桌面完全没变"＝点在桌面图标上）。旁证：task-7 与本轮 Explorer **窗口内**双击都有效。

## 4 渲染"白板"：控制组通过，Electron/GPU 应用**未验证**
- **控制组**：guest 内启动**记事本** → 渲染完全正常（标题栏/菜单/状态栏/行列表齐全，`out\shots\p07e-2-discord.png` 那一帧其实就是记事本最大化）。**空记事本本身就是一个"带边框的大白矩形"** ⇒ 录屏里那块白板**最可能是空记事本**（**未证实**：录屏帧太小，看不到标题栏文字）。
- **Electron/GPU 应用（Discord）未验证**：第一次 dblclick 被"刚恢复的记事本窗口"挡住；第二次因桌面图标层无响应而无效；随后 CLI 被并发改动打断（见 §6）→ 实验未完成。
- **画面通道**：`window on` 时抓宿主 client 区(1280x800) → 肉眼确认**就是 guest 桌面**（图标＋Explorer 窗口）✓。但数值比对（67.1%、85.9%）**无效**：我的抓屏相对 `ClientToScreen` 的 client 原点**整体低了约 31px（一个标题栏高）**，平移使差异爆表。**未证实**：窗口渲染与 helper 帧之间疑似还有约 1.2× 图标尺度差（平移未校正前不能判定）。
- guest 渲染环境：session 31 里 **dwm 在跑**（pid 27088）；GPU 是 RTX 5080（系统级）；**子会话的每会话 GPU 加速状态未测**。

## 5 腾讯桌面整理：确实在 guest 里跑，但**没能禁用**（前后对照未完成）
- guest(31) 进程：`DesktopMgr64`、`QQPCExternal`×4、`QQPCTray`、`DesktopAITaskCenter`、`QQPCSoftCmd`；启动项 `%APPDATA%\...\Startup\腾讯桌面整理.lnk` ⇒ **它随启动项在子会话里也跑**（"只在真机跑"的猜测不成立）。
- 从宿主（Medium IL）`Stop-Process` session 31 的这批进程 **全部失败**（它们由 SYSTEM 桥以未过滤 Administrator 令牌启动 → High IL，权限不足）；改走"guest 内 Run 框粘贴 `taskkill`"时 **Run 框把命令粘坏**（`taskkill`→`skkill`、引号丢失）⇒ **"杀掉它再看能否点开"未完成**。备用通道已就绪：`%TEMP%\dsh-childsession\p07-kill-desktopmgr.cmd`（用 guest 的 Explorer 双击它即可，只会 taskkill session 31 的实例）。

## 6 环境/阻塞项（待修）
- **`vdesk-cli.mjs` 曾在 11:21:04 处于半成品**：`SyntaxError: Identifier 'http' has already been declared`（第 236 行）→ 期间全部 CLI 调用失败（我改用 8790 HTTP + `X-VDesk-Token` 绕过）；11:22 后已恢复。
- （已修）`vdesk.ps1` 10:57:01–10:57:48 之间是无 BOM 版，PS 5.1 按 GBK 解析失败（`start`/`stop` 全挂）；现首字节 `EF BB BF`、`status` 正常。
- 录屏末尾那个可见终端 = `[dsh-screen-capture] 停止录制…`，属**录屏插件的宿主控制台**（vdesk-monitor 是隐藏启动）→ 另立"待修"：插件宿主进程不应有可见控制台/不应进任务栏。本次未动它。

## 下一步建议（按优先级）
1. 用 guest Explorer 双击 `p07-kill-desktopmgr.cmd` 杀掉 DesktopMgr64（及其守护 QQPCTray/QQPCExternal）→ 再测桌面图标点击；若仍无响应则元凶另有其人（覆盖窗口/explorer 桌面层）。
2. 仍建议给 keeper 的 window on 补 `$ax.Focus()`（或 `GrabFocusOnConnect=true`）+ 把 RDP 控件设为 TabStop，并处理"首次点击被吃"（本测显示 on 后焦点已在 IHWindowClass，但**用户实点的第一下**仍待复测）。
3. 验证"白板"是否 GPU 渲染失败：guest 内同一应用默认/`--disable-gpu` 两次启动对比（未做）。

**未证实清单**：① 白板＝空记事本（最可能，未证实）② Electron/GPU 应用是否白板 ③ 窗口渲染与 helper 帧的尺度差 ④ 桌面图标层失效的具体元凶 ⑤ 用户物理点击"第一下被吃"。

---

## 7 追加实验（11:23–11:26，会话 32）："杀掉腾讯桌面整理再复测" + **对 §3 的更正**

### 7.1 杀不掉（自保护）——按 Lead 的"杀不掉"分支收束
- 通道：先用 Lead 指定的**剪贴板路径**（`vdesk-cli.mjs type` → `clipboard+ctrl+v`）把命令写进 guest「运行」框，**这次文本完整**（`out\shots\p07j-1-runbox.png`、`p07j-2-runbox2.png` 可见 `taskkill /F /IM DesktopMgr64.exe /T`）——但该命令**没有会话过滤**，而**真机 session 1 也在跑** DesktopMgr64/QQPCExternal 等（6 个进程），执行它**可能杀掉用户真机上的实例**，因此我**没有按 Enter**，改为会话过滤的脚本。
- 改用 `cmd /c %TEMP%\dsh-childsession\p07-kill-suite.cmd`（内含 `/FI "SESSION eq 32"`，对 DesktopMgr64/QQPCExternal/QQPCSoftCmd/QQPCTray/DesktopAITaskCenter **逐个** `taskkill /F /T`）在 **guest 内**执行 → **全部失败**，原文如 `错误: 无法终止 PID 37400 (属于 PID 4060 子进程)的进程。`（共 12 条；套件互为父子链 + session 0 的 `QQPCRTP` 自保护驱动）⇒ **不是"杀了会重生"，而是根本杀不掉**。完整日志（含 before/after 的 tasklist）：`%TEMP%\dsh-childsession\p07j-kill-out.txt`。
- **真机未被波及**：session 1 的 6 个同类进程全程原样存在（收尾复查仍为 6）✅。
⇒ **"杀它再复测"这条路走不通**；"腾讯桌面整理接管了桌面图标层"**仍未证实**。

### 7.2 ★更正 §3：桌面图标层**其实有效**（上一次是"打偏了"）
- guest 内 `dblclick(255,240)` → **真的打开了 Explorer 窗口**，路径 `主页 > 剑星mod`（正是该坐标处的文件夹图标）：`out\shots\p07j-5-chrome-dblclick.png`；`p07j-3` 里还能看到桌面图标的**悬停提示**（`类型: NetPowerZipT.zip / 大小: 505 MB`）⇒ 连 hover 都有反应。
- 因此 **§3 的"guest 桌面图标层对注入点击完全无响应"作废**：session 31 的两次"逐字节相同"极可能是**坐标打偏**（Discord 图标位置取自缩放帧，且那次刚恢复的记事本窗口挡住了桌面）＋ Discord 启动器在子会话里可能起不来（未验证）。**由此推出的"图标层被接管"推断不成立。**
- 本轮另有一次 `dblclick(163,45)` 之后出现了腾讯「软件管家」窗口（`p07j-4`），但它与"taskkill 被拦截后套件弹窗"的时序重叠，**不能确定**是我点开的还是套件自弹 ⇒ 记**未证实**。

### 7.3 更正后的问题图景
- guest 自身输入链（helper → Shell：开始菜单 / 任务栏 / Explorer / **桌面图标双击**）**全部有效**；
- 于是"用户点不开程序"的剩余疑点集中在 **宿主 → 原生 RDP 窗口的物理点击路径**（我测不了：我的 SendInput 对 High-IL 的 keeper 窗口被 UIPI 拦）。该测**只能由用户做**：① 先在窗口 client 区点一下（激活）② 再双击一个图标（如桌面 `剑星mod` 文件夹）③ 若仍无效，请记录"标题栏是否变活动色、鼠标指针在窗口内是否变化"。

---

## 8 授权用 UIA 关闭那个未保存测试标签页 → **无法执行（当前没有该 UI 元素）**（2026-10-02 12:00 起）
- 只读盘点（UIA `AutomationElement.FromHandle` + `ControlType.TabItem` / 其子 `Button`）：**枚举不到任何 Notepad 顶层窗口**（`EnumWindows` 按 class 匹配 `Notepad`：可见窗口 0 个，连**隐藏**窗口也 0 个）；`Get-Process notepad` 依次为 0 →（一次瞬时）1 → 0（瞬时那次无 `MainWindowHandle`，找不到窗口，疑似 stub/后台进程）。**没有窗口就没有 TabItem 元素可 invoke** ⇒ 按 Lead 要求 #4 **停手**：没关窗口、没敲键盘、没点坐标、没改任何文件。
- 该标签页仍"存在"于**磁盘上的会话状态**：`%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\5bc3afb2-8554-481d-b1cb-8c3efb424517.bin`（3381 B，mtime **10:29:49**，即 task-7 写入）**仍能搜到 `LINE-001` / `scroll-test`** ⇒ **下次打开记事本（开启"还原上次会话"时）很可能又恢复出该标签**（所以不是"关掉又被恢复"，是这次根本没有窗口可关）。
- 干净的收尾两条路：① 等它再次出现在窗口里时，用 UIA 精确 invoke 该标签的关闭按钮 → 对话框里**只点「不保存」**（本脚本随时可执行）；② 经授权后删除上面那个 TabState 文件（属改动 app 状态，**未动**）。
- 顺带（**只列不改**）——此刻会话 1 可见窗口里属于"自动化遗留"类的只有两个，都不是活跃窗口：① `CASCADIA_HOSTING_WINDOW_CLASS` pid 2128（Windows Terminal，标题 `…powershell.exe`）**被推到屏幕外** `rect=-21333,-21333`（即之前记的"录屏/终端控制台"待修项）；② `PseudoConsoleWindow` pid 47620（`rect=0,0,0,0`，零尺寸 ConPTY 瞬态）。**没有**我们的 marker / 原生虚拟桌面 / 记事本窗口。
- 我方磁盘遗留（全在 `%TEMP%\dsh-childsession\`，**不在用户桌面**）：`p05-move.ps1/.log`、`p07-host-marker.ps1`、`p07-host-target.txt`、`p07-host2.txt`（各 5 B 空文件）、`p07-hostwin-A/B.txt`、`p07-kbd-hook.ps1` + 3 个 `.log`、`p07-kill-desktopmgr.cmd`、`p07-kill-suite.cmd`、`p07-read-inputs.js`、`p07j-kill-out.txt`（自保护报错原始日志）、`p07d-*/p07i-*/p07-03-host-small.png`；另有**别人的**运行数据 `out\tasks\t-20261002-110346-6j1ctb.jsonl`（P1 任务运行器日志，非我产出）。
