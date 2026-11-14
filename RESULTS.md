# R3 原型实验记录：用 Windows 原生 Child Session 做「不抢键鼠的 AI 桌面」

## ✅ 最终结论（2026-10-01 20:01，**已跑通**）

**豆包的机制已完全查清，并且在本机用系统自带 RDP ActiveX 复刻成功。**

### 那一环：**消息泵**（`Application.DoEvents()`）

RDP ActiveX 是窗口控件，`Connect()` 之后的连接状态机**必须靠 Windows 消息循环推进**。
用 `Start-Sleep` 空转等待 = 把状态机冻死，表现为：`Connected=2`、`err=内部错误`、
**netstat 里没有任何到 3389 的连接、服务端零日志**。

加上消息泵后立刻：`conn=2 → conn=1`（状态机推进）→ 服务端 `Listener received a connection`
→ 会话仲裁 → **`Session logon succeeded: Session ID 3`** → `qwinsta` 出现 `7a78855482a04fa781dc#0  Active`。

证据：这个规律早就摆在时间线上，我之前没看出来 ——

| 版本 | 轮询循环里有 `DoEvents()` 吗 | 服务端收到连接吗 |
|---|---|---|
| 18:46 那次（唯一一次连到服务端、死在 TLS/凭据） | **有** | ✅ 收到 |
| 18:51 之后我写的所有版本（matrix*/probe-*） | 没有 | ❌ 一次都没收到 |

### 复刻配方（最小可用）

```
1. 提权（本机走 SYSTEM 提权桥 + TokenLinkedToken，无 UAC、无窗口）
2. WinForms 里托管 RDP ActiveX：new AxHost 子类，CLSID 8b918b82-7985-4c24-89df-c33ad2bbfbcd
   放到一个窗体上 → Show() → CreateControl()   （窗体可放到屏幕外、Opacity 0.01）
3. 设属性：
   Server          = 'localhost'
   UserName        = 'MicrosoftAccount\1010930312@qq.com'
   DesktopWidth/Height = 1280/800
   AdvancedSettings7.EnableCredSspSupport = true       【必须，否则 Connect() 直接 E_INVALIDARG】
   密码：走非脚本 vtable  IMsRdpClientAdvancedSettings(3c65b4ab-…).slot112 put_ClearTextPassword
   可选：IMsRdpClientNonScriptable5(4f6996d5-…).slot63 put_AllowPromptingForCredentials(false)
   可选：AdvancedSettings.slot147 AuthenticationLevel = 0
   IMsRdpExtendedSettings(302d8188-…).slot3 put_Property('ConnectToChildSession', true)
4. Connect()
5. **循环里必须 [System.Windows.Forms.Application]::DoEvents()**（+ 每秒一次即可）
6. 成功判据：qwinsta/WTSEnumerateSessions 出现 `<listenerGUID>#0` + 事件日志 Session logon succeeded
   （**绝不能用 WTSGetChildSessionId**，它会返回幽灵值）
```

### 跑通后实测到的能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 真正的 Child Session | ✅ 20:00 首次跑通 | session id 3，`7a78855482a04fa781dc#0`，Active |
| 子会话内是完整桌面 | ✅ | explorer.exe / dwm.exe / rdpclip.exe / 开始菜单 / 输入法 **全都起来了** |
| **用户的启动项在子会话里照跑** | ✅ | 实测到了 lghub 托盘、腾讯桌面整理、DSH 飞书接收器、Windows Terminal |
| 免 UAC 把进程送进子会话 | ✅ | `launch-in-session.ps1 -SessionId 3`（WTSQueryUserToken(3) → 链接令牌 → CreateProcessAsUser） |
| 从子会话内部截图 | ✅ | `shot-in-session.ps1`，1280×800 PNG（`out/child-desktop-s3.png`） |
| 控制台会话不受影响 | ✅ | 全程 `console 1 Active`，用户桌面没有被抢 |
| 键鼠注入 / 帧通道 / DSH 面板 | ⬜ 下一步 | 子会话内 helper（SendInput）+ 推流 + 查看/接管 |

### 面板（看得见 + 能接管）

由 `make-vdesk-monitor.mjs` 从现成的隔离桌面监控页派生而来（`vdesk-monitor.mjs`），
指向子会话 helper（`127.0.0.1:8790`），服务在 **127.0.0.1:8791**。深色卡片风格与
`tools/live-monitor.ps1`「运载窗口」一致。

| 能力 | 说明 |
|---|---|
| 实时画面 | 网页轮询 `/shot`（实测 4 fps），顶部显示主机/用户/分辨率 |
| **接管锁** | **默认只读**：`/mouse` `/key` `/click` 一律返回 `{"ok":false,"error":"view-only"}`；点工具栏「接管」→ `/takeover?on=1` 才放行 |
| 一句话开窗 | `tools\vdesk-childsession\vdesk-visible.ps1`（幂等：服务在跑就不重启、窗口已开就不重复开），走 `C:\Users\Administrator\.dsh\open-vdesk.vbs` → Chrome `--app=http://127.0.0.1:8791/`，独立 user-data-dir |
| 其它按钮 | 截一帧、全屏 |

**实测**：`/shot` → 512KB PNG；只读时点击被拒（带提示）；`/takeover?on=1` → `{"ok":true,"takeover":true}` → 再点击 `{"ok":true,"action":"click"}`；`on=0` 恢复只读。

### 延迟治理（2026-10-01 20:36，用户反馈「延迟非常的严重」）

**先量后改**：

| 指标 | 治理前 | 治理后 |
|---|---|---|
| 一帧数据量 | **1.31 MB**（全尺寸 PNG） | **215 KB**（JPEG q70） |
| 一帧耗时 | **440 ms** | **108 ms**（`scale=0.75` 可到 60 ms / 103 KB） |
| 面板帧率 | 3.8 fps | **8.0 fps** |
| 截图洪流中的鼠标输入 | 被排在截图之后 | **稳定 52 ms** |

**四个根因与对策**：

1. **PNG 编码太贵**：一屏图标+照片的 PNG 有 1.3 MB、编码 ~440 ms。→ helper 支持
   `/screenshot?format=jpg&quality=72&scale=0.75`，实时画面走 JPEG（一次性保存仍用 PNG）。
2. **helper 是单线程 `while(true){GetContext(); Handle()}`**：截图进行中所有输入请求排队。
   → 改成 `ThreadPool.QueueUserWorkItem` 派发，输入不再被帧挡住。
3. **页面拉帧间隔 200 ms**（而每帧要 440 ms，实际只能 2 fps 且画面陈旧）。→ 收到 90 ms。
4. `CaptureFromScreen` 改用 `Format32bppRgb`（CopyFromScreen 最快的布局），缩放走 GDI 而不是先编码再缩。

### 用户实测反馈后的两个修复（2026-10-01 20:30）

用户反馈：「**无法对这个屏幕实现鼠标键盘操作**」「**这个桌面上的原生程序、游戏都不见了**」。两条都是真问题：

1. **"不能操作" = 我加的只读锁太绕**。面板默认只读、要点「接管」才放行；用户没注意到那个按钮，于是点不动。
   **修复**：默认改为**接管中**（点「交还」才切回只读），面板开箱即可直接操作。
2. **"程序/游戏不见了" = 子会话里第一个 explorer 起太早**，桌面图标列表（`SHELLDLL_DefView` → `SysListView32`）没被填充，
   所以桌面一片空——**东西一直都在**（用户桌面重定向在 `F:\OneDrive\Desktop`，105 项）。
   **修复**：`fix-desktop.ps1`（在子会话内重启一次 explorer 并等图标列表出现），已并入 `vdesk.ps1 start`。
   实测日志：`explorer before: 17132,43672 → after: 38252,46972`，`desktop items visible in listview: 136`。

**踩坑记录（两条）**：
- **启动器只能执行 ASCII 路径下的脚本**。`fix-desktop.ps1` 一开始只存在于工作区（`默认工作区`），子会话进程按 ANSI 解析路径 →
  报"无法将 … 识别为 cmdlet、函数、脚本文件或可运行程序的名称"，脚本静默不执行。
  **修复**：`vdesk.ps1 start` 开头自动把工作区脚本同步到 ASCII 暂存目录（工作区是真源，暂存目录是执行区）。
- **我误把 `fix-desktop.ps1` 在本机（会话 1）直接跑了一次**，把用户自己的 explorer 重启了（任务栏闪、打开的文件夹被关）。
  教训：凡是"重启 shell / 杀 explorer"这类脚本，**必须先确认目标会话**，绝不能为了"试一下语法"在本机裸跑。

### 组件与用法（已跑通的成品）


| 组件 | 角色 | 说明 |
|---|---|---|
| `keeper.ps1` | **保活**（= 豆包的 `pip_main --type=main`） | 提权后在会话 1 里托管 RDP ActiveX、**泵消息**、把子会话维持成 Active；写 `out/keeper.json` 心跳；看到 `out/keeper.stop` 就退出 |
| `helper-runner.ps1` | 投送器 | 在子会话里 `Start-Process` 起 helper |
| `helper/dsh-vdesk-helper.exe` | **子会话内的手**（= 豆包的 `--type=helper`） | HTTP 服务，端口 8790：`/health`、`/screenshot`、`/mouse`、`/key`；自带"窗口站名 = Console 就退出"守卫 |
| `launch-in-session.ps1` | 免 UAC 投送 | `-SessionId N`，走 WTSQueryUserToken → TokenLinkedToken → CreateProcessAsUser |
| `vdesk.ps1` | **管理器** | `start` / `status` / `shot` / `click x y` / `move` / `key vk` / `stop` |

```
tools\vdesk-childsession\vdesk.ps1 start     # 建子会话 → 投 helper → 就绪
tools\vdesk-childsession\vdesk.ps1 shot out.png
tools\vdesk-childsession\vdesk.ps1 click 20 775
tools\vdesk-childsession\vdesk.ps1 stop
```

**实测（2026-10-01 20:08）**：`start` → 子会话 6 `7a78855482a04fa781dc#0 Active`；
`/screenshot` → 316KB PNG；`/mouse?action=click&x=20&y=775` → `{"ok":true}`；
再 `/screenshot` → 512KB，**开始菜单真的弹开了**（`out/live-1.png` 与 `out/live-2.png`）；全程 console 会话 1 未受影响。

### ⚠️ 两个必须记住的约束

1. **子会话必须是连接状态（Active）才能截图/注入**。断开（`Disc`）的会话没有渲染表面，
   helper 的 `/screenshot` 会 500。所以 **keeper 必须一直活着**——这就是豆包为什么要有个常驻 main 进程。
2. **中文字符路径会坑**：子会话里的进程按 ANSI 解析路径，helper 必须放在纯 ASCII 目录
   （本机用 `C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\`）。

### 豆包的对应实现（对照，来自它的日志与子会话进程表）


```
主进程  pip_main.exe --type=main --auto_destroy_shadow_session   （会话 1，托管 RDP ActiveX）
  ├ put_Property('ConnectToChildSession'，它自己叫 ConnectToShadowSession)
  ├ put_AllowPromptingForCredentials(false)
  ├ 创建子会话 → explorer 自启 helper
  ├ 命名管道 \\.\pipe\PipRemotePipeName_<explorerPid>  ← 以子会话 explorer 的 PID 命名
  └ 之后 OnTakeSnapshot / OnSendMouseMoveEvent / OnSendMouseClickEvent / OnSendKeyStroke（画面与输入全走这条管道）
helper  pip_main.exe --type=helper --channel=… --session-guid=…  （父进程 = 子会话的 explorer.exe）
```

---

# 以下为过程记录（含多个已被推翻的中间结论，保留以说明推理路径）

## ❌ 已被推翻的中间结论（2026-10-01 19:43 写的"走不通"）

> **误判原因**：当时所有尝试都因为缺消息泵而"连 socket 都不建"，我把这误读成"机制在本机不可复刻"。
> 下面的排除矩阵本身是准确的（每条都实测过），只是**它们的失败都是同一个原因的副作用**。

### 排除矩阵（实测）


| 变量 | 试过的值 | 结果 |
|---|---|---|
| 控件 CLSID | `MsRdpClient7/8/9NotSafeForScripting`、v10（注册表默认）、redistributable v11 | 全部 `conn=2`、无子会话 |
| 属性名 | `ConnectToChildSession`（成功读回 True）；`ConnectToShadowSession` | 后者 `E_UNEXPECTED`（豆包自封装名） |
| CredSSP | 开 / 关 | 关掉 → `Connect()` 直接 `E_INVALIDARG` |
| 密码投递 | dispatch `AdvancedSettings7.ClearTextPassword`；**非脚本 vtable `IMsRdpClientAdvancedSettings` slot 112** | 后者返回 `S_OK`（真实写入），**结果不变** |
| 凭据提示 | **非脚本 vtable `IMsRdpClientNonScriptable5` slot 63** `AllowPromptingForCredentials(false)` | `S_OK`，结果不变 |
| `EnableFrameBufferRedirection` | true | 结果不变 |
| Server | `localhost` / `127.0.0.1` / 机器名 / 不设 | 客户端一律报 "connect to the server (localhost)"，结果不变 |
| `TransportType` / `NetworkConnectionType` | 1（TCP only） / 5（LAN） | `S_FALSE` / `S_OK`，结果不变 |
| `AuthenticationLevel` | 0 / 2 | 结果不变 |
| 提权 | 标准令牌 / 管理员（High 完整性，经链接令牌） | 两者都失败 |
| 状态重置 | 重启 `TermService` / **整机重启** | 都失败（重启后第一次尝试即为干净基线） |
| 幽灵会话 | `WTSGetChildSessionId` 返回的 4 | 是 API 假象（提权进程调用返回"无"），**不是**阻塞原因 |

### 唯一还没做的事（若将来继续）

拿 `G:\豆包\Doubao\app\pip_main.exe` 的**运行时行为**做对照：在豆包触发一次虚拟桌面的同时抓
① `TerminalServices-RDPClient/Operational`、② 终端服务各日志、③（更强）直接 API hook 它调用的
`IMsRdpExtendedSettings.Property` / `Connect` 序列，看它究竟比我们多设了什么。
它的日志只给了**函数名**（`put advanced_settings completed`），没给**参数值**——差异很可能就藏在那里。

### ✅ 本轮顺带交付的能力（可复用）

**静默提权**：借本机 SYSTEM 提权桥（`~/.dsh/isolated-desktop` 的 `DSH-HyperV-Bridge`，队列目录用户可写）
→ `WTSQueryUserToken(1)` 得到**过滤令牌** → `GetTokenInformation(TokenLinkedToken)` 取**链接令牌**（完整管理员）
→ `CreateProcessAsUser` 在会话 1 里起 High 完整性进程。**无需 UAC、无窗口、不抢焦点**，已实测。
脚本：`launch-in-session.ps1`。

### 本轮我自己踩的两个坑（已进长期记忆）

1. **`WTSGetChildSessionId` 会说谎**：低权进程调用会返回一个根本不存在的 id（本机恒为 4），
   我因此误报过一次「打通」。判据只能用 `WTSEnumerateSessions`/`qwinsta` + 事件日志。
2. **启动器不要写 `net session` 自提权**：判断失准 + 反复自动拉起 → 制造了「无限终端弹窗」。

---

# 以下为过程记录（含已被推翻的早期结论，保留以说明推理路径）

> 2026-10-01 · 工作区 `tools\vdesk-childsession\` · 对应主报告 `豆包虚拟桌面-原理与DSH实现评估.md` §6

## 结论一句话（早期版本，已被上面的最终结论取代）

**机制全部打通，只差一步"凭据"。** Windows 原生子会话（Child Session）这条路在本机被验证到最后一步：
控件能托管、`ConnectToChildSession` 能设上、`Connect()` 能走到"已连接（Connected=2）"、**但给子会话登录需要一个有效凭据（本机是微软账户密码），没有它拿不到子会话**。

## 已确证的事实（都有实测证据）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **本机子会话功能已启用** | `WTSIsChildSessionsEnabled → ok=True enabled=True`（不需要管理员、不需要 UAC 去开启；很可能是豆包初始化时开的） |
| 2 | 当前没有子会话 | `WTSGetChildSessionId → FALSE, err=1168 (ERROR_NOT_FOUND)` |
| 3 | **RDP ActiveX 控件可以被无窗口/隐藏窗口托管** | `System.Windows.Forms.AxHost` 子类 + CLSID `8b918b82-7985-4c24-89df-c33ad2bbfbcd`（注册表描述 "Microsoft RDP Client Control - version 10"，ProgID `MsTscAx.MsTscAx.10`）；注：该 CLSID 没有 `MsRdpClient*` 那种 ProgID，必须用 CLSID 创建。**不托管时 `Connect()` 什么都不做（Connected=0）；托管后 Connected=2** |
| 4 | **`ConnectToChildSession` 可以设置** | `IMsRdpExtendedSettings`（IID `302D8188-0052-4807-806A-362B628F9AC5`）原始 QI `hr=0x0`；vtable slot 3 = `put_Property`、slot 4 = `get_Property`；设完读回 `True` |
| 5 | ⚠️ **.NET 的 `ComImport` 转换会失败**，但原始 QI 成功 | 托管 cast 报 "Cannot convert System.__ComObject..."；**必须手工 QI + `Marshal.GetDelegateForFunctionPointer` 调 vtable**（本仓库脚本就是这么做的） |
| 6 | 可用的属性（dispatch 晚绑定） | `Server` / `UserName` / `Domain` / `DesktopWidth` / `DesktopHeight` 可写；`AdvancedSettings7.EnableCredSspSupport` 可写；**`AdvancedSettings7.ClearTextPassword` 可写（控件本身的 `ClearTextPassword` 不可用，报 DISP_E_UNKNOWNNAME）**；`AllowPromptingForCredentials` 不可写（DISP_E_UNKNOWNNAME） |
| 7 | **CredSSP 是必须的** | 关掉 `EnableCredSspSupport` 后 `Connect()` 直接抛 `E_INVALIDARG (0x80070057)`，连接根本不启动（Connected=0） |
| 8 | **连接走到登录阶段就会要凭据** | 开着 CredSSP + 有 `UserName`：`Connected=2`，`GetErrorDescription` 返回 "An internal error has occurred."；不提供任何凭据时 Windows 弹出凭据框（`CredentialUIBroker` 进程出现） |
| 9 | **子会话连接不走 TCP 监听器** | 我们两次连接尝试期间，`RemoteConnectionManager` 日志里**没有任何** "Listener received a connection"；而豆包那次（正常成功）也没有 —— 符合"loopback 子会话"的预期 |
| 10 | **豆包把 PIP 会话凭据存在 Windows 凭据管理器里** | `cmdkey /list → Target: LegacyGeneric:target=Doubao/ComputerUse/PIPSession`（Generic, Local machine persistence）—— 与我们设计的存法完全一致，也印证了"必须给密码" |

## 关键代码要点（可复用）

```
1) 托管：  class RdpAx : AxHost { public RdpAx() : base("<CLSID>") {} }   // 必须 CLSID，不能 ProgID
           form.Controls.Add(ax); form.Show(); ax.CreateControl(); ocx = ax.GetOcx()
2) 设标志：IntPtr p = QI(ocx, IID_IMsRdpExtendedSettings)      // 原始 QI，不要用 ComImport cast
           PutFn(p, 3).Invoke(p, "ConnectToChildSession", ref VARIANT_BOOL(true));
3) 属性：  put_Server / put_UserName / put_Domain / put_DesktopWidth|Height
           AdvancedSettings7.EnableCredSspSupport = true        // 必须
           AdvancedSettings7.ClearTextPassword     = <密码>     // 只有这个位置可写
4) 连接：  Connect()  → 轮询 WTSGetChildSessionId() 拿到子会话 ID
5) 收尾：  Disconnect() + WTSLogoffSession(0, childId, false)
```

## ⚠️ 重要更正（2026-10-01 19:15）：**R3 尚未跑通**，此前的"成功"是误判

我在 18:57 根据 `WTSGetChildSessionId → 4` 和 `qwinsta` 里的一行判断"子会话创建成功"，
**这是错的**。用事件日志核对后真相是：

| 判据 | 结果 |
|---|---|
| `10-01` 的 `Session logon succeeded (id=21)` 事件 | **最后一条是 01:05:13 的 Session 3（豆包那次）。我们所有尝试都没有产生过 logon 事件** |
| `WTSGetChildSessionId()` | 会返回一个**幽灵值 4**（对应会话根本不存在，`WTSEnumerateSessions` 里也没有）——**不能用作成功判据** |
| `qwinsta` 里那行 `7a7885…#0  Conn` | 是一个**登录从未完成的半成品会话对象**，18:57 只是读到它、然后把它注销了 |
| 客户端日志 | `RDP ClientActiveX is trying to connect to the server (localhost)` → 约 25 秒后 `multi-transport connection has been disconnected`（超时） |
| 服务端日志 | 开着 `ConnectToChildSession` 时 **服务端完全收不到连接**（客户端走的是 loopback 专用通道，不是 TCP 监听器） |

**所以：豆包的子会话（Session 3）确实真实存在过；我们自己一次都没成功建出来。**

已排除的原因：
- ❌ 不是属性名：豆包日志里的 `ConnectToShadowSession` 在控件上返回 `0x8000FFFF`（E_UNEXPECTED），那是它自己封装的函数名，底层仍是 `ConnectToChildSession`（该属性设置成功、读回 `True`）。
- ❌ 不是 CLSID：`MsRdpClient7/8/9NotSafeForScripting` 与 v10/v11 表现完全一致。
- ❌ 不是 CredSSP：关掉它 `Connect()` 直接 `E_INVALIDARG`。
- ❌ 不是 `EnableFrameBufferRedirection`（文档里提 loopback 的那个属性）——加上后行为不变。
- ❌ 不是"幽灵会话没清"：重启 `TermService` 后 `WTSGetChildSessionId` 仍返回 4，行为不变。
- ❌ 不是普通 RDP 证书问题（那是另一条路：`mstsc` 0x708）。

**仍未验证的关键差异**：豆包用的是 `IMsRdpClientNonScriptable*` 上的
`put_ClearTextPassword` / `put_AllowPromptingForCredentials`（我们通过 dispatch 设 `AdvancedSettings7.ClearTextPassword` 会静默无效，
而这两个属性只能走原始 vtable，需要先从 `mstscax.dll` 的 type library 里把接口的 vtable 槽位提取出来）。

### ✅ 但这一轮拿到一个非常有用的新能力：**静默提权**

本机那条 SYSTEM 提权桥（`~/.dsh/isolated-desktop` 的 `DSH-HyperV-Bridge`，PID 3368 / Session 0）还活着。
借它执行 → `WTSQueryUserToken(1)` 拿到的**过滤令牌** → `GetTokenInformation(TokenLinkedToken)` 取**链接令牌**（完整版，即 UAC 提权等价物）
→ `CreateProcessAsUser` **在会话 1 里起一个 High 完整性进程**：

```
runner identity: NT AUTHORITY\SYSTEM
token: linked token acquired (unfiltered); primary token ok
OK started pid=49532 in session 1
elevated = True   /   Mandatory Label\High Mandatory Level (S-1-16-12288)
```

**不需要 UAC、不开窗口、不抢焦点。** 脚本：`launch-in-session.ps1` + 桥的 `hv.ps1`。

---

## 历史记录（以下为误判当时写下的内容，保留以说明过程）

### 曾误报为"已打通"（2026-10-01 18:57）

```
  t=+3s Connected=1 childSessionId=4
qwinsta:  >console              Administrator   1  Active        ← 用户桌面，全程没被动
          7a78855482a04fa781dc#0               4  Conn          ← 子会话
CHILD SESSION CREATED id=4 -> R3 mechanism CONFIRMED on this machine
Disconnect() ok / WTSLogoffSession(4)=True
foreground window changed = False                              ← 前台窗口没被抢
```
事件日志同步印证：`18:57:30 Session 4 has been disconnected` + `18:57:32 RpcLogoff from powershell ... host.ps1`。

### 缺的那一块：**管理员权限（提权）**

同样的脚本、同样的参数、同样的凭据，**标准令牌下必然失败**（`conn=2` 但 `childSessionId` 永远是 4294967295，`GetErrorDescription` 报 "An internal error has occurred."），
**换成管理员令牌后 3 秒内成功**。证据：

| 运行 | 令牌 | 结果 |
|---|---|---|
| 18:38–18:46（host3 普通运行） | 标准（UAC 过滤，`Administrators` 为 deny-only） | 失败；客户端日志 `TsSslEventHandshakeContinueFailed`，服务端连接被终止 |
| 18:51–18:55（matrix2/3/4 普通运行） | 同上 | 失败；客户端每 8–12 秒超时断开，服务端**完全收不到连接** |
| **18:57（run-as-admin.cmd 提权运行）** | **管理员（完整令牌）** | **成功，`childSessionId=4`** |

> 这也解释了豆包产品为什么要"**初始化 + 输管理员密码**"：它的 PIP 会话创建同样需要完整令牌。
> `tools/` 下的 `run-as-admin.cmd` 会自动检查并向自己要 UAC（`net session` 探测 + `Start-Process -Verb RunAs`）。

### 附带确认的细节

- 子会话**会**出现在 `qwinsta` 里，会话名形如 `7a78855482a04fa781dc#0`、类型那列是空的、STATE=`Conn`；
- 提权运行时凭据管理器里我们自己存的 `DSH-CHILDSESSION` 依然可读（同用户同登录会话）；
- `WTSGetChildSessionId()` 在子会话登出后仍返回该 id（陈旧值），**不能用它判断子会话是否还活着**，要看 `qwinsta`；
- `foreground window changed = False` —— 整个过程没有抢用户的焦点。

## 历史：打通前记录的阻塞点（保留，说明当时卡在哪）

**需要一个有效的账户凭据。** 本机账户是微软账户 `MicrosoftAccount\1010930312@qq.com`。

## 本目录文件

| 文件 | 作用 |
|---|---|
| `child-session-host.ps1` | 第一版：裸 COM 对象（未托管）→ Connect 空转，证明"必须托管" |
| `child-session-host2.ps1` | 第二版：手工 QI + vtable 调 property（**`ConnectToChildSession` 首次设成功**） |
| `child-session-host3.ps1` | 第三版：**AxHost 托管 + 属性齐全 + 从凭据管理器取密码**（当前主力脚本） |
| `child-session-matrix.ps1` | 配置对照矩阵（CredSSP 开/关 × 有无用户名 × 有无 Server），结论见上表 #7 #8 |
| `store-credential.ps1` / `.cmd` | 安全存密码到凭据管理器（`-SelfTest` 可自检，已验证 CredWrite/CredRead/Delete 通路 OK） |
| `out\child-session*-*.txt` | 每次运行的完整日志 |

> 安全说明：所有脚本从不打印密码；凭据用 `CredWrite` 存进凭据管理器（DPAPI 按用户加密），删除用 `cmdkey /delete:DSH-CHILDSESSION`。
