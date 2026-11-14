# helper token 鉴权（P0.6-A）

- **协议（host 侧见 task-11，必须严格一致）**：除 `GET /health` 外，**所有**路由（`/screenshot /mouse /key /clipboard`）都要带请求头 `X-VDesk-Token: <token>`；缺失或不匹配 → HTTP **401** `{"ok":false,"error":"unauthorized"}`，且**在任何动作之前**返回（实测：指针不动、剪贴板不写、按键不注入）。`/health` 无鉴权，且响应里没有 token 字样。
- **token 文件**：`%LOCALAPPDATA%\Temp\dsh-childsession\out\token`（固定路径，host 与 guest 共读）。内容为 **32 个 hex**（16 字节 `RNGCryptoServiceProvider`）。启动时文件不存在或非法就生成；**每次启动**都用 `FileSecurity.SetAccessRuleProtection(true,false)` 把 ACL 重设为「**当前用户 + SYSTEM**」两条 ACE（实测 `icacls` 只有这两行，无继承项）。
- **每次请求重读文件**（`ReadToken()`），轮换不用重启：实测「写入新 token → 旧 token **401** / 新 token **200** → 写回原值 → 再 **200**」。比较用长度固定、无提前返回的 `SameToken()`。
- **排障开关**：`VDESK_NO_AUTH=1` 跳过鉴权（仅本机），启动时 stderr 打 `vdesk-helper: VDESK_NO_AUTH=1 -- token auth DISABLED (debug only)`。
- **自测（宿主 session 1 的 `%TEMP%` 副本 + 8790，脚本 `%TEMP%\dsh-vdesk-p06\auth-test*.ps1`；token 值全程未打印，只记 len=32 / hexOnly=true / sha8）**：
  - 无 token → `/clipboard?action=get`、`/screenshot`、`/key?action=text`、`/mouse?action=click`、`/clipboard?action=set` **五条全 401**；「动作没发生」证据：无 token 的 click 后宿主 `GetCursorPos` `2247,942 → 2247,942` 不变，无 token 的 set 后剪贴板 `86 → 86` 不变。
  - 错 token（`deadbeef…` / `0000…`）→ **401**；正确 token → `/clipboard?action=get` **200**、`/screenshot` **200**（501829 字节，magic `89 50 4E 47`）、`/clipboard?action=set` **200** `{"ok":true,"chars":25}`。
  - `/health` 无 token → **200**，响应里 `contains "token" = False`、`contains <真实 token> = False`。
  - `VDESK_NO_AUTH=1` → 无 token `/clipboard?action=get` **200**（把宿主剪贴板设成唯一标记 `auth-discriminator-<rand>`，响应原样回显该标记 → 证明响应者确实是本次带 `NO_AUTH` 的进程，而不是别的 helper）。
- **编译**：csc `/nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll` → **零错误零警告**；`dsh-vdesk-helper.exe` 23040 字节 @2026-10-02 10:46:52，SHA256 `F0F456C896DA2D5C9416EBBDA33232ACFCDB730F2EF4D870ECBA4F8880CAC7EA`。
- **暂存目录**：`Temp\dsh-childsession\helper\dsh-vdesk-helper.exe` **已替换**（未遇占用，无需 `.new.exe`），`.cs` 已同步。
- **host 侧要做什么（task-11）**：每次请求前读同一 token 文件并加 `X-VDesk-Token` 头（`/health` 探活不用）；monitor(8791) 与 CLI 两条调用链都要带；401 时提示「token 缺失/已轮换」。**注意时序**：只要新 helper 随下次 `vdesk.ps1 start` 进子会话，而 host 半区还没带 token，受保护调用会全部 401（`/health` 仍 200）。
