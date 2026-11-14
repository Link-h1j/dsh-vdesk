# 已知限制（KNOWN-LIMITS）—— 为什么"彻底隔离"做不到，以及你有哪三种选择

## 30 秒结论

- **为什么隔离失败**：子会话是你当前账户的影子会话，不能换账户；自启走登录计划任务（`DeskGo`）和 `Run` 键，改启动文件夹拦不住。
- **代价**：腾讯桌面整理等机器级单例会在子会话里再起一份，与真机那份抢单例 → 双崩；我们不杀你的进程，也不改系统。
- **现在的默认**：P3-C 起检测到冲突默认拒绝启动（`exit 4` / `singleton-conflict`），是否继续交给你决定。
- **怎么办**：先退出白名单程序再启动（推荐、零风险）；要冒险继续用 `-Force` 强制启动；临时禁用登录任务尚未实现，需你授权。
- **白名单**：`out\singleton-watchlist.txt`，每行一个进程名；文件不存在 = 内置默认，存在但只有注释/空行 = 关闭探测。

> 结论先行：**子会话无法与你的控制台会话隔离自启程序**。我们的策略已从"堵"改成 **探测 + 告知 + 由你拍板**（P3-C）。

## 1) 为什么不能彻底隔离
- **无法换账户**：子会话（`<guid>#0`）是**当前控制台用户**的影子会话 —— 事件链 `4648 → 4624(类型3) → 4634`，LocalSessionManager 21/22/24 = 0 条；即使把 `dshvdesk` 加进 Administrators（`4672` 已生效）也一样。所以"专用账户"（豆包 Pip 的做法）在本机**结构上不可行**。
- **自启不走启动文件夹**：P3-B 已把 `%APPDATA%\...\Startup` 整目录改名，子会话**照样**起腾讯套件。只读取证到的真正启动器：
  - 计划任务 **`DeskGo`**（`MSFT_TaskLogonTrigger` → `D:\Program Files (x86)\Tencent\DeskGo\4.3.1829.127\DesktopMgr64.exe /StartFrom=AutoRun`）
  - 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（ctfmon / LGHUB / Tabbit updater）、`HKLM\...\Run`（SecurityHealth / RtkAudUService）
  - 以及 `\ASUS\ledcontrolservice3_sdk` 等：凡是"每个登录会话都起一份"的 Run 键/登录计划任务，**改启动文件夹都拦不住**。
- **抢单例的代价**：这类套件是机器级单例。子会话里再起一份 → 两份互相抢 → **双崩**；真机那份靠守护进程自修复，子会话那份不修。
- 我们**不改系统**（不动任务/Run/服务/账户），也**不杀你的进程**（实测杀不掉，还会牵动真机）。

## 2) 你的三种选择
1. **先退出它们再启动（推荐，零风险）**：退出腾讯桌面整理（`DesktopMgr64` / `DesktopAITaskCenter` / `QQPCExternal`）等白名单程序，再让我们启动。探测不到命中就会正常启动。
2. **强制继续（接受风险）**：`vdesk.ps1 start -Force` / `POST /vdesk/start?force=1` / 工具 `vdesk_start{force:true}` / 面板「强制启动」按钮。会打印醒目警告，并在 `/vdesk/status.conflict.forced` 与任务 journal 里标记这次是"明知有冲突"启动的；启动后仍会实测子会话里有没有白名单进程（`guest.hermetic`）。
3. **以后允许我们临时禁用登录任务**（目前**未做**，需你明确授权）：会话期内临时禁用 `DeskGo` 这类 Logon 计划任务与相关 Run 值，结束后恢复。这属于"改系统"，只有你点头才做。

## 3) 真实事故记录
- **11:29** 第一次双崩：子会话登录起了腾讯套件，与真机那份抢单例；用户桌面被影响（真机侧自修复）。
- **12:04（会话 34）** 第二次（P3-B 实测）：启动文件夹已改名（`Startup.vdesk-held` 生效），子会话里仍起 `DesktopMgr64(40952)`/`DesktopAITaskCenter(40136)`/`QQPCExternal(14360,37816,40112,29140)`；会话 1 的腾讯 PID 整轮更换（22516/38416/6812,15120,25208,50388 → 29108/35844/20584,44156,46668,47312，数量 2+4 不变）= 双崩→自修复重演。详见 `STARTUP-ISOLATION.md`。
- 因此 **P3-C 起默认拒绝启动**（`exit 4` / `singleton-conflict`），把决定权交还给你。

## 4) 白名单怎么改
`out\singleton-watchlist.txt`，每行一个进程名（可带 `.exe`，`#` 开头是注释）。文件不存在 = 内置默认（`DesktopMgr64, DesktopAITaskCenter, QQPCExternal, QQPCTray, QQPCSoftCmd`）；**文件存在但只有注释/空行 = 显式关闭探测**（`vdesk.ps1 status` 会显示"空：已关闭冲突探测"）。
