# helper `/clipboard` 说明（P0-A）

- 新增路由（子会话内 `127.0.0.1:8790`）：
  - `GET /clipboard?action=get` → `{"ok":true,"text":"<剪贴板文本>"}`；剪贴板无文本时 `text` 为空串；打不开剪贴板 → HTTP 500 `{"ok":false,"error":"clipboard busy"}`。
  - `GET /clipboard?action=set&text=<UTF-8 URL 编码>` → `{"ok":true,"chars":N}`（N = 写入的 UTF-16 字符数，可中文）；`action` 为其它值 → HTTP 400；省略 `action` 等同 `get`。
- Win32 实现：`OpenClipboard/EmptyClipboard/SetClipboardData(CF_UNICODETEXT, GlobalAlloc+Marshal.Copy)/CloseClipboard`；读取 `GetClipboardData(CF_UNICODETEXT)+Marshal.PtrToStringUni`。`SetClipboardData` 成功后缓冲归剪贴板所有（不 `GlobalFree`），失败才释放。
- 重试：`OpenClipboard`/`GlobalLock` 失败最多 **3 次尝试、间隔 50ms**（`ClipboardAttempts=3`、`ClipboardRetryMs=50`）。
- **编码修正（重要）**：HttpListener 按 ANSI 代码页（本机 GBK）解查询串，标准 UTF-8 转义 `%E4%B8%AD`(中) 会被解成 `U+6D93 U+003F`。故 `text` 参数改由新增的 `QUtf8()` 从 `Request.RawUrl` 按 UTF-8 自行解码（`+`→空格）；其余参数是 ASCII，仍走原 `Q()`。同一原因也影响 `/key?action=text` 的中文（**P0-E 已同样修掉，见文末追加**）。
- 编译：`csc /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll`（Framework64 v4.0.30319）→ **零错误零警告**；`dsh-vdesk-helper.exe` 17408 字节（旧 15360），2026-10-02 10:14:08。
- 暂存目录：**已替换** `%LOCALAPPDATA%\Temp\dsh-childsession\helper\dsh-vdesk-helper.exe`（未遇占用，无需 `.new.exe`）；exe SHA256 与仓库一致 `D494308A…7B02`，`.cs` 同步复制。
- 实测（**从 %TEMP% 副本、端口 8790，非子会话**）：`/health` ok；`set/get` 「豆包虚拟桌面测试」8 字码点逐一相符；`+`→空格、空串 `chars:0`、非法 action 400 均正常；测试后原剪贴板内容已还原。**未在真子会话内验证**（未启动虚拟桌面）→ 留给 P0-C 冒烟。
- 环境注记：在宿主里直接运行「工作区路径下」的该 exe，会在 `new HttpListener()` 抛 `PlatformNotSupportedException`（疑似本机沙箱对工作区可执行文件的限制）；同一二进制复制到 `%TEMP%` 运行完全正常，子会话部署路径（暂存目录 → hv.ps1/SYSTEM 桥）不受影响。

## P0-E 追加（修 `/key?action=text` 同一缺陷，2026-10-02 10:16）
- 改了：`/key?action=text` 的文本也改走 `QUtf8(ctx.Request.RawUrl, "text")`（原 `ctx.Request.QueryString["text"]`）；`QUtf8` 顺带改成纯函数 `QUtf8(string rawUrl, string key)`，两个调用点都传 `ctx.Request.RawUrl`（便于不起监听器就能单测）。
- 验证：csc **零错误零警告**（源码保持纯 ASCII）；最终 exe 17408 字节 @10:16:38，SHA256 `E4FF2309…63DA`；对**同一份源码**编译出的程序集做反射级单测（真机 .NET Framework 执行，无 HTTP、无按键注入）**11/11 通过**，含 `/key?action=text&text=%E4%B8%AD%E6%96%87`→`U+4E2D U+6587`、8 个中文、ASCII 不变、`+`→空格、`%2B%26`→`+&`、缺参/空参/参数乱序/无查询串。
- 未做真实 HTTP 自测：8790 正被 P0-C 冒烟占用，且 `/key?action=text` 会向真实桌面注入按键（会打到当前焦点窗口），故改用纯函数单测；`/key` 端到端中文输入留给 task-3/后续。
- 暂存目录：`dsh-vdesk-helper.exe` **被 P0-C 运行中的 helper 占用，未强杀**，新 exe 已放为 `dsh-vdesk-helper.new.exe`（SHA256 与仓库一致）；`.cs` 已同步；下次 `vdesk.ps1 start` 会自动用仓库 helper\* 覆盖暂存目录。
