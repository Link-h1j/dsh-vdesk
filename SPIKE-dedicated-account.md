# P3-A spike：专用本地账户能否登录为子会话 —— 结论 **NO-GO（结构性绑定；已用管理员身份复验）**

## 做法与原始证据
- 账户（SYSTEM 桥提权创建，最小权限）：`dshvdesk` 普通用户、`PasswordNeverExpires`；
  `NetUserAdd rc=0 parm=0`、**`LogonUser(NETWORK) ok=True win32=0`**（证明凭据管理器里的密码与账户密码一致）、
  `PasswordRequired=True / PasswordExpires=False / Disabled=False`、SID `S-1-5-21-4242634412-3209933812-2329559529-1004`；
  组成员 **仅 `Remote Desktop Users`**（Administrators 仍只有 Administrator）。原始输出见
  `%TEMP%\dsh-vdesk-p3a\account-log.txt`。
- 凭据：Credential Manager 目标 **`DSH-VDesk-ChildSession`**（user=dshvdesk，24 字符随机密码，blob 48 字节）；
  **密码只在内存与凭据库里，未落任何文件/日志**（报告不含密码）。写入用 in-process `CredWrite`，账户创建由
  session 1 的**提权**进程完成（自己读同一凭据 → `NetUserAdd`），所以明文不必过桥。
- spike keeper：`%TEMP%\dsh-childsession\keeper-spike.ps1` = 官方 `keeper.ps1` **只改两处**
  （`CredTarget`→`DSH-VDesk-ChildSession`、`Username`→`dshvdesk`），由 `w-keeper-spike.ps1` 包装
  （状态/停止文件放 `out\spike\`，不碰官方 `out\keeper.json`），经 `launch-in-session.ps1` 在 session 1 启动
  （回显 `linked token acquired (unfiltered)`）；官方 `keeper.ps1` 未被修改。

## 结果（两次独立尝试：11:38:40 与 11:40:58，`qwinsta` 1 秒粒度轮询）
- **从未出现 `dshvdesk` 的 `#` 子会话**；keeper 60 秒超时后自行退出，状态 `{"ok":false,"stopped":true}`。
- 事件日志：`RemoteConnectionManager/Operational` **id=261「侦听程序已收到一个连接」**（TCP 通了）→
  Security **4648**（Administrator 用显式凭据登录 dshvdesk）→ **4624 登录成功，登录类型 3（网络）、NtLmSsp** →
  紧接着 **4634 注销**（该登录会话被销毁）。**完全没有** `LocalSessionManager` 的 21/22/24（会话登录成功/Shell 启动），
  也没有 `1149 用户身份验证已成功` / `263 WDDM 图形模式`。
- 对照（同一窗口 11:29:34–36，控制台用户的 MSA 凭据）：`1149 → 263 → 21/22`，子会话 33 正常建立 ⇒ 机制本身可用，
  **唯一变量就是换了账户**。
- 已排除项：RDP 登录权不缺 —— `secedit` 导出 `SeRemoteInteractiveLogonRight = *S-1-5-32-544,*S-1-5-32-555`
  （Administrators + Remote Desktop Users），dshvdesk 正在 RDU；System 日志无 TermService/TermDD 报错；无 4625 拒绝事件。

## 结论与下一步
- **NO-GO（dshvdesk 仅在 Remote Desktop Users）**：失败点**不在认证、也不在登录权**，而在**认证成功之后、子会话建立之前**
  ——服务器明确接受了该账户（4624 type 3）随即丢弃连接（4634），始终没有创建会话。这与"外来子会话"那种
  TCP 16 秒超时 / reason 516（11:38 之前的历史实测）是**两种不同现象**。
- 要走通需要什么条件（**我没有擅自试**，等你拍板）：
  ① 把 `dshvdesk` 加入 `Administrators` 再试一次 —— 若这样就能起，说明只是"目标账户需管理员"的限制；
  ② 若加了仍不通，则说明 **child session 与"控制台会话用户"身份绑定**（Windows 的 child session 本质是同一用户的影子会话），
     "专用账户"这条路不成立，只能改成"同一账户 + 干净启动项隔离"（子会话内禁用/替换 Startup、或给子会话套专用 profile/策略）。
- 收尾：spike keeper 已退出、`qwinsta #`=0、session 1 仍 `Administrator / Active`、Administrator 账户未被改动
  （`PasswordLastSet=2026/10/1 18:50:39`）、官方 `out\keeper.json` 未动；`dshvdesk` 账户按 NO-GO 要求**保留不动**；
  `C:\Users\dshvdesk` **不存在**（从未发生交互登录），故"新账户 profile 首次登录自动创建"这一点**未验证**。

## 追加：option A —— 把 `dshvdesk` 加进 `Administrators` 再试（用户/Lead 批准后执行）→ 结论不变，**结构性绑定坐实**

- 权限改动**只此一处**，事后已回退；`net localgroup` 前后回读：
  - `Administrators BEFORE: 堂客陈ROG全家桶\Administrator , 堂客陈ROG全家桶\dshvdesk`
  - `Administrators AFTER : 堂客陈ROG全家桶\Administrator`（已移除；`Remote Desktop Users` 仍保留 dshvdesk）
- 完全复刻同一 spike 流程（attempt 3，11:59:29–12:00:30，qwinsta 1 秒轮询、`out\spike\` 独立状态、
  `launch-in-session.ps1` 在 session 1 起、unfiltered linked token）：**仍没有出现 `dshvdesk` 的 `#` 子会话**；
  keeper 60 秒超时自退 `{"ok":false,"stopped":true}`；`C:\Users\dshvdesk` 仍未创建。
- 事件链（这次还证明"管理员身份确实已生效"）：
  `RemoteConnectionManager id=261 侦听程序已收到一个连接` → Security **4648**（Administrator 用显式凭据登录 dshvdesk）
  → **4624 登录成功（登录类型 3 网络 / NtLmSsp）** → **4672 为新登录分配了特殊权限**
  （SeSecurityPrivilege / SeBackupPrivilege / SeDebugPrivilege / SeTakeOwnershipPrivilege / SeRestorePrivilege …）
  → **4634 立刻注销**；**窗口内 LocalSessionManager 事件 0 条**（无 21/22/24，也无 1149/263）。
- 判定：**"目标账户需管理员"这一条也被排除** ⇒ **child session 与控制台会话用户身份绑定**（Windows child session 本质是
  同一用户的影子会话）。因此"专用本地账户"这条治本路线 = **NO-GO（条件不足，非配置可解）**；可行方向只剩
  "同一账户 + 干净启动项隔离"（子会话内禁用/替换 Startup、或给子会话套专用 profile/策略）。
- 收尾：spike keeper 已退出、`qwinsta #`=0、session 1 仍 `Administrator / Active`、Administrator 账户与官方文件零改动；
  `dshvdesk` 账户保留，但**已退回最小权限（仅 Remote Desktop Users）**；要彻底清理：`net user dshvdesk /delete`
  ＋ `cmdkey /delete:DSH-VDesk-ChildSession`。
