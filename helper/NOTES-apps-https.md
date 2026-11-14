# helper `/apps` + HTTPS（P2-A）

- **路由（都过 token 鉴权；`/health` 仍豁免）**
  - `GET /apps?action=list` → `{"ok":true,"count":N,"apps":[{"name","target","source"}...]}`，上限 200：来源 `startmenu`（**当前会话** Start Menu 的 .lnk，用 WScript.Shell 解析 TargetPath，只收 .exe/.com/.bat/.cmd）、`apppaths`（HKLM 64/32 位视图 + HKCU 的 App Paths，只读）、`appx`（shell AppsFolder，只收 `!App` 结尾的打包应用——**Win11 的「记事本」只存在于这里**）。
  - 去重按 name（忽略大小写），最终按 name 排序（OrdinalIgnoreCase）。**超过 200 时：保留全部 apppaths+appx，再用 startmenu 按名字顺序补足到 200**——实测纯按名字截断时，「记事本」排在 241 条第 231 位会被截掉。
  - `GET /apps?action=launch&name=<UTF-8 urlencoded>` → 精确匹配 → 忽略大小写包含匹配（多条命中取排序第一条，并在返回里附 `candidates`）→ 最后当路径试（含 `\`//`、或 .exe 且文件存在）。命中：`{"ok":true,"matched":"<名字>","pid":N,"source":"..."}`；匹配不到：`{"ok":false,"error":"no-match","candidates":[≤5]}`（候选=首字符相同的名字提示）。appx 用 `IApplicationActivationManager` 激活（能拿到真实 pid），失败才退 `shell:AppsFolder\<AppID>`。
  - **策略**：`name` 含 `doubao` 或 `豆包` → `{"ok":false,"error":"blocked-by-policy"}`（解析到的名字与 target 再查一遍，绝不启动）。中文 `name` 走 `QUtf8()` 自解，列表输出为 UTF-8 JSON。
- **HTTPS**：首次启动生成自签证书（`CN=vdesk-helper-local`、1 年、SAN 127.0.0.1+localhost、RSA2048+SHA256），PFX 存 `out\helper-cert.pfx`、随机密码存 `out\helper-cert.pwd`，两者与 `out\helper-cert.sha256`（**单行小写 SHA256**，供 host 钉扎）都 ACL 收紧为「当前用户 + SYSTEM」。启动先试 `https://127.0.0.1:<port>/`。
- **踩到的坑（值得记）**：`HttpListener.Start()` 在 http.sys **没有**该端口证书绑定时**也会成功**，故障只在握手时出现（TLS 客户端 "connection reset"、http 客户端无响应）。所以启动后追加一次 **TLS 握手探针**（`SslStream.AuthenticateAsClient`）；探针失败就 `Stop()` 并**回退 http**，同时把一次性命令写进 `out\helper-cert.setup.cmd` 并打到 stderr。`VDESK_HTTP_ONLY=1` 直接 http（stderr 警告）；`/health` 与 marker 都带 `tls:true|false`。
- **netsh 需不需要**：需要。本机 `netsh http show sslcert` 无任何绑定 → 探针必失败 → 回退 http。host 跑一次 `out\helper-cert.setup.cmd`（管理员）即可，内容 = `Import-PfxCertificate … Cert:\LocalMachine\My` + `netsh http add sslcert ipport=127.0.0.1:<port> certhash=<40 位> appid={2f0e9e5c-7f3b-4c2a-9e1a-5c6b0d7a1f11}`。
- **自测（宿主 session 1 + `VDESK_ALLOW_CONSOLE=1` + **8795**，全程没碰 8790；用完立即停）**
  - `list`：无 token → **401**；带 token → **200**，`count=200`（≥30 ✓、≤200 ✓）、sorted ✓、unique ✓、`sources=apppaths,appx,startmenu` ✓、**含「记事本」**（target=`Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`，source=appx）✓、UTF-8 原始字节解码一致 ✓；耗时 **525 ms / 22243 字节**。
  - `launch`：`doubao`/`Doubao.exe`/`%E8%B1%86%E5%8C%85`(豆包) → 全 **blocked-by-policy**；`zzz-not-an-app` → **no-match** + candidates；`记事本` → `{"ok":true,"matched":"记事本","pid":50292,"source":"appx"}`，pid 50292 确为 Notepad（其余三个已存在的记事本未被触碰），**测完立刻关掉**。
  - HTTPS：stderr `listening https://127.0.0.1:8795/` → `TLS handshake probe failed` → 打出 `netsh http add sslcert ipport=127.0.0.1:8795 certhash=68285B442202300B57780698E870CA50D6257019 …` → `falling back to plain HTTP` → `/health` `tls:false` ✓。证书：subject=`CN=vdesk-helper-local`、`hasPrivateKey=True`、notAfter=`2027-10-02`、**`helper-cert.sha256` 与实际证书 SHA256 完全一致**（`95c943c5893ad411624452682fc8545cd724a705e1faeee71032f5f4d640a1b0`）、icacls 仅 `SYSTEM` + 当前用户 ✓。
  - `VDESK_HTTP_ONLY=1`：`listening http://…` + stderr 警告 ✓；测完 8795 已释放、8790 未受影响。
- **host 侧待办**：① 以管理员跑一次 `out\helper-cert.setup.cmd`（之后 `/health` 的 `tls` 会变 `true`，证书用 `helper-cert.sha256` 钉扎）；② 本轮改的是 helper——**已在运行的那个 8790 helper 是旧构建**（缺 appx 的 `Items` 方法修复），下次 `vdesk.ps1 start` 自动换新（暂存 exe 被占用时已放 `dsh-vdesk-helper.new.exe`）。
- 编译：csc 零错误零警告；exe 40960 字节 @2026-10-02 11:18:31，SHA256 `6FD286E4F24D21550BBD39AF4BA4636AEE92F8991D089D54BEBAB9DAF3358F5C`。
