# P4/B1 — helper+monitor 实时流（MJPEG `/stream`）与批量输入通道（`/input`）

> 负责：task-1（T1）/ stream-dev。范围：`helper/**`、`make-helper.ps1`、`make-vdesk-monitor.mjs`、`vdesk-monitor.mjs`、本文件，以及工作区 `selftests/` 里我名下的自检。
> 真机红线全程遵守：没有 stop/start/restart 虚拟桌面、没有杀 helper、没碰 Windows 会话、没向真机注入键鼠；helper 一律走 `--selftest`（纯函数）与 Node mock，**没有起过真 helper**。

---

## 1. 交付物

| 文件 | 变化 | 体量 / 哈希 |
|---|---|---|
| `helper/dsh-vdesk-helper.cs` | 新增 `/stream`、`/input`、`--selftest`；`/key` 未知 action → 400；抽出 `DragAtomic` / `ParseRect` / `ResolveCoord`；JPEG 编码器缓存 | 96303 字节（原 62633），**纯 ASCII、无 BOM** |
| `helper/dsh-vdesk-helper.exe` | 重新编译产物 | 60928 字节 @2026-10-02T13:30:49，SHA256 `A54BA5EC91342234323FCB1C13750D59C5831C15E601E4A5B895663D1AFF4FA2` |
| `make-helper.ps1` | **语义修正**：默认只编译现有 `.cs`；旧「从 isolated-desktop 重新派生」改为 `-Regen` 显式开关（原因见 §3.7） | UTF-8 **with BOM**（前 3 字节 239,187,191） |
| `make-vdesk-monitor.mjs` | 新增第 22 节：`/stream` 透传、`/input` 转发、`/click` 归一化、`/input` 进写路由表与接管锁 | 生成器唯一真源 |
| `vdesk-monitor.mjs` | 由生成器重新生成 | 43134 字节，SHA256 `FF73787BAE52969D432A06A0C2A1BAA7A101D1B7EA1B1937FC745597700A8C75` |
| `selftests/selftest-p4-stream.mjs` | **新建**（mock helper + 真生成 monitor） | 40 断言 |
| `selftests/selftest-p06-auth.mjs` | 真实 `%TEMP%` 原件只读 → 工作区副本，改 17→18 | 48 断言 |
| `selftests/selftest-p09-monitor.mjs` | 真实 `%TEMP%` 原件只读 → 工作区副本，未改内容 | 20 断言 |

---

## 2. 冻结接口 v1 的实现（逐字对照）

### A) `GET /stream`
```
GET /stream?format=jpg|png&quality=1..100&scale=0.1..1&fps=1..30&cursor=0|1&maxSeconds=1..3600[&rect=x,y,w,h]
默认 format=jpg quality=72 scale=0.75 fps=10 cursor=1 maxSeconds=300
响应 200  Content-Type: multipart/x-mixed-replace; boundary=dshframe
每帧 part 逐字节：
  --dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: <n>\r\n\r\n<bytes>\r\n
```
实现要点：
- 分帧只用 `FrameHeader(len, jpg)` 造**头部**字节，帧体与尾 `\r\n` 分别 `Write` + 一次 `Flush` → 全程**没有任何整帧拼接/多余拷贝**。
- `format=png` 时头部为 `Content-Type: image/png`（冻结文本给的是默认 jpg 的样例；两种格式各自自洽）。
- 节流：`frameDelay = round(1000/fps)`，每帧后补 `frameDelay - 耗时`，抓屏比目标帧率慢时不额外等待。
- `maxSeconds` 到点即主动收尾；`SendChunked=true`，写失败/客户端断开 → 立刻跳出并返回，响应流由既有 `finally` 关闭释放。
- 抓屏/缩放/编码完全复用既有 `Capture(fmt, quality, scale, src, cursor, ring)`（ring=900，使面板点按后 ~0.9s 能在画面里看到琥珀环）。
- 需要 token（在 `/health` 之后统一鉴权），所以 helper 无 token → 401，monitor 原样透出。
- `rect` 解析/裁剪与 `/screenshot` 共用新的 `ParseRect()`（原 `/screenshot` 里那段内联代码改成调用它，行为逐字不变）。

### B) `POST /input`（另支持 `GET /input?events=<urlencoded json>`）
按顺序执行，成功 `{"ok":true,"count":N,"ms":M}`，失败 `{"ok":false,"index":i,"error":"..."}`。

| type | 字段 | 行为 |
|---|---|---|
| `move` | x,y（必填） | 移动 + 记录虚拟指针 |
| `down` / `up` | x,y（**可省**）, button | 可选先移动；按下/抬起 |
| `click` | x,y（**可省**）, button, count=1 | 可选先移动；点 count 次 |
| `drag` | x1,y1,x2,y2, button | 走 `DragAtomic`（与 `/mouse?action=drag` **同一实现**：先落点按下，150ms 后整段滑行+抬起一次 SendInput） |
| `scroll` | x,y（**可省**）, delta（必填） | 可选先移动；滚轮 |
| `key` | vk=1..255, down=true\|false | down=true 按下、false 抬起（单键） |
| `combo` | vks=[1..255,…] 非空 | 顺序按下、逆序抬起 |
| `text` | text 字符串 | 逐字符 Unicode 注入（同 `/key?action=text`） |

坐标语义：`ResolveCoord(v, dim)` = `v <= 1` 视为 0..1 归一化（×desktop 后按 JS 的 round-half-up，钳到最后一像素），`v > 1` 当像素 —— 与 `plugin/index.js px()`、`vdesk-cli.mjs` 现行规则一致。

HTTP 状态码约定（冻结文本未规定，写明以免误读）：
- 文档结构/字段非法（含非法 JSON、未知 type、缺必填、越界）→ **400** + `{"ok":false,"index":i,"error":...}`；`index` 为出错事件下标（结构性问题为 `-1`）。校验在执行前整体完成，**此时一个事件都没执行**。
- 文档合法但第 i 个事件执行抛错 → **200** + `{"ok":false,"index":i,...}`，此时 `0..i-1` 已执行（符合冻结文本「index 之前的事件已执行」）。
- `events:[]` → `{"ok":true,"count":0,"ms":0}`。

### C) 8791 monitor
- `GET /stream?...`：查询串**逐字**转给 helper `/stream`，带 `X-VDesk-Token` + 证书钉扎（沿用既有 `resolveTransport`），multipart **原样 pipe**（不被 `agentRequest` 缓冲），helper 非 200（401）原样透出为 JSON；浏览器断开 → `res.on("close")` 里 `upstream.destroy()`，直接结束 helper 的抓屏循环。
- `POST /input`（也支持 GET）：body 原样转发（`rawAgentRequest` 扩展出 `method`/`body` 参数），响应原样透出；`/input` 已加入 **Origin 白名单写路由表**（非白名单 403，拒绝的请求不会到 8790）。
- 未改 `/shot /meta /mouse /key /click /takeover /vdesk/*` 的既有语义。

### D) 现有路由
- `/health /apps /screenshot /mouse /key /clipboard` 行为只加不改。
- **`/key` 未知 action 从「回 ok:true 的静默失败」改成 400 `{"ok":false,"error":"bad action"}`**（`/apps`、`/clipboard` 本来就是这个行为，现在三者一致）。已确认既有自检没有任何断言依赖旧行为。

---

## 3. 关键决定 / 与冻结文本的差异（都请 Lead 过一眼）

1. **`down`/`up`/`click`/`scroll` 的 `x,y` 允许省略**（缺省=在当前指针位置动作）。T3 的拖拽契约是 `{move},{down},{move*},{up}`，`down/up` 不带坐标；若把它们当必填，T3 的拖拽会整单 400。这是**放宽**，不是改语义：给了坐标就照常先移动。
2. **monitor `/click` 接受归一化坐标**（`<=1` 归一化、`>1` 像素，按 helper `/health` 上报的桌面尺寸换算并钳位）。T3 的单击契约明确发 `x=px/rect.width`，而 T3 不能改 monitor，所以由 monitor 做换算。旧的像素调用（如 `x=10`）行为不变；既有自检无回归。
3. **`/input` 纳入接管锁**：`(route==="/mouse"||"/key"||"/click"||"/input") && !takeover` → `view-only`。T3 明确要求「不得绕过接管语义」，只读时不放行 /input。
4. **`--selftest` 在 `FreeConsole()` 之前**（否则 GUI 子系统进程没有 stdout），也在控制台守卫与 HttpListener 之前；只断言纯函数，不绑端口、不写 marker、不注入输入。输出 `ok=N fail=0`，退出码 0/1。
5. **`/stream` 的 `Content-Type` 随 format 走**：jpg→`image/jpeg`，png→`image/png`（冻结样例只给了 jpg 那一行）。
6. **JPEG 编码器查找改为进程级缓存**（`JpegCodec()`）：原 `Capture` 每帧遍历 `ImageCodecInfo.GetImageEncoders()` 并分配数组，30fps 下是纯垃圾；行为不变。`/screenshot` 与 `/stream` 共用。
7. **`make-helper.ps1` 原来是破坏性的**：它会把 `helper/dsh-vdesk-helper.cs` 从 `tools/isolated-desktop/guest/dsh-agent.cs`（13 KB 老 agent，**没有** /apps、token、控制台守卫、光标、P4 全部内容）重新派生 —— 也就是说 P0~P4 任何一次跑它都会把这些功能删掉。现在默认只编译现有 `.cs`；旧派生逻辑保留为 `-Regen`（显式、会打印 LOSSY 警告）。同时补上 .ps1 的 UTF-8 BOM。
8. **monitor 自带窗口页面仍用 `/shot` 轮询**（未改成 `<img src="/stream">`）。原因：那个页面的画质按钮/帧率计数都绑在逐帧 `probe.src` 上，换 MJPEG 会把这些交互做坏，而冻结交付 C 只要求新增路由、真机观感由 T3 的面板承担。若要一并升级独立窗口，是下一轮的小改动。

---

## 4. 验收命令与结果（全部实跑）

```
# 1) 编译（与 make-helper.ps1 内完全同一条 csc 命令）
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe ^
  /out:helper\dsh-vdesk-helper.exe /reference:System.dll /reference:System.Drawing.dll ^
  /reference:System.Windows.Forms.dll helper\dsh-vdesk-helper.cs
→ csc exit = 0（零错误零警告）；exe 60928 字节 @2026-10-02T13:30:49
  SHA256 A54BA5EC91342234323FCB1C13750D59C5831C15E601E4A5B895663D1AFF4FA2

→ 或用脚本（默认不重新派生 .cs，.cs 哈希前后一致 = True）：
powershell -NoProfile -ExecutionPolicy Bypass -File tools\vdesk-childsession\make-helper.ps1
→ source: ...\helper\dsh-vdesk-helper.cs (96303 bytes) / csc exit = 0 / exit code = 0

# 2) helper 纯函数自检（GUI 子系统进程，cmd 等待并捕获）
cmd /c "tools\vdesk-childsession\helper\dsh-vdesk-helper.exe --selftest"
→ exit 0，最后两行：--- / ok=43 fail=0

# 3) node --check
node --check make-vdesk-monitor.mjs            → exit 0
node --check vdesk-monitor.mjs                 → exit 0
node --check selftests/selftest-p4-stream.mjs  → exit 0
node --check selftests/selftest-p06-auth.mjs   → exit 0
node --check selftests/selftest-p09-monitor.mjs→ exit 0

# 4) 重新生成 monitor 并验证生成器幂等（连跑两次逐字节一致）
node make-vdesk-monitor.mjs   → "all replacements applied"（无 MISSES），exit 0
node make-vdesk-monitor.mjs   → run1 = run2 =
  FF73787BAE52969D432A06A0C2A1BAA7A101D1B7EA1B1937FC745597700A8C75  (byte-identical = True)

# 5) 我名下的自检（工作区副本）
node selftests/selftest-p4-stream.mjs    → exit 0   ok=40 fail=0
node selftests/selftest-p06-auth.mjs     → exit 0   ok=48 fail=0
node selftests/selftest-p09-monitor.mjs  → exit 0   ok=20 fail=0
```

`selftest-p4-stream.mjs` 覆盖：/stream 200 + multipart 头 + 查询串逐字 + token 头 + part 逐字节（`--dshframe`/`image/jpeg`/Content-Length/CRLF，载荷与 mock 发出的字节逐帧相同）、helper 401 透出、POST /input body 与 token 逐字转发、GET /input?events= 转发、非白名单 origin 403 且不触达 8790、view-only 时 /input 拒绝、**客户端断连后 mock 侧响应被关闭且不再产帧**、以及老路由零回归（/shot /meta /mouse /key /click /vdesk/status /vdesk/task /404、CORS 与 403 行为）。

### 4.1 非我范围内的回归：`selftest-p3c-monitor.mjs`（真实 temp 原件）在本沙箱里跑不起来 —— 环境原因，非 T1 改动

```
node "%TEMP%\dsh-childsession\selftest-p3c-monitor.mjs"
→ exit 1，崩在 113 行：TypeError: Cannot read properties of null (reading 'checkedAt')
  （line 112 的 conflict.found 也一并失败：GET /vdesk/status 的 conflict 为 null）
```
根因是**文件沙箱不给子进程开命名管道**：monitor 的 `conflictProbe()`（P3-C 第 21 节生成，T1 一个字没动）用 `spawn("powershell.exe", [..., "probe"], { windowsHide: true })`，即默认 `stdio:"pipe"`；在这个沙箱里该 spawn 直接抛 `Error: spawn EPERM`，probe 拿不到输出 → `conflictProbe()` resolve(null) → `/vdesk/conflict` 与 status.conflict 都变 null。

最小复证（同一沙箱内实跑）：
```
node -e 'spawn("powershell.exe",["-NoProfile","-Command","Write-Output hi"])'   # 默认 stdout=pipe
→ Error: spawn EPERM  (errno -4048, syscall spawn)
```
同一份 p06 里的 CLI 也是这个原因（原件 `runCli` 默认 piped stdio → EPERM），副本改成文件重定向后 48/48 全绿 —— 说明被拒的是 stdio 管道，不是被测代码。

结论：这条请 Lead 在**不受沙箱限制**的会话里复跑确认（它不在 T1 写范围，我没有改它）。T1 对 monitor 的改动集中在生成器新增第 22 节（`pipeAgentStream`/`agentInput`/`readRequestBody`/`resolveNorm`/`helperDesktopSize`、`/stream` 与 `/input` 路由、`/input` 进写路由表与接管锁、`/click` 归一化、`rawAgentRequest` 加 `method/body`），没有触碰 `/vdesk/conflict`、`conflictProbe`、`vdeskStatus`、窗口时钟等 P3 逻辑；p06/p09 副本都在真生成的 monitor 上全绿。


---

## 5. 未在真机验证的部分 + 需要 Lead 做的事

1. **helper 的 `/stream`/`/input` 运行时路径没有在真 helper 上跑过**（红线：宿主 session 起真 helper 会被控制台守卫拒绝退出 9，且 8790 是机器级端口已被 session 35 的旧构建占用）。已用两条腿兜住：`--selftest` 覆盖分帧字节/解析/归一化/非法拒绝；monitor 侧用**完全按冻结契约实现**的 mock helper 验证透传。真机整链需要 Lead 部署后验收。
2. **新 helper 没有进 session 35**：真实 `%TEMP%\dsh-childsession\helper\` 对沙箱只读（实测 `WRITE DENIED`），我无法暂存 exe，也没有杀/重启任何东西。请 Lead 用既有通道把新构建推进去，例如：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\vdesk-childsession\vdesk.ps1 helper
   ```
   （该 action 会把 `helper\*` 同步到执行区并只重启我们子会话里的 helper 进程。）
3. 部署后建议的顺带真机核对：`GET http://127.0.0.1:8790/stream?format=jpg&fps=10&maxSeconds=3` 应回 `multipart/x-mixed-replace; boundary=dshframe` 且 3 秒后有约 30 个 part；`POST /input` 发 `{"events":[{"type":"key","vk":17,"down":true},{"type":"key","vk":17,"down":false}]}` 应回 `{"ok":true,"count":2,...}`。
4. T3 面板的真机视觉验收需要刷新页面 —— 我没有 reload、没有重启 DSH。

## 6. 只读原件 → 工作区副本的说明

真实 `%TEMP%\dsh-childsession\` 下的 `selftest-p06-auth.mjs` / `selftest-p09-monitor.mjs` **只读**，改动落在工作区副本 `tools/vdesk-childsession/selftests/`：
- p06：工具清单断言 `17 → 18`（T2 新增 `vdesk_clipboard`；与 T2 在 `selftests/selftest-p0-tools.mjs` 的写法一致）。
- p06：`runCli()` 原来用 `spawn` 默认的 `stdio:"pipe"` 抓 CLI 输出，在本沙箱里被拒（`Error: spawn EPERM`，文件沙箱不给子进程开命名管道）。副本改成 stdout/stderr 重定向到文件再读回，进程/环境/断言完全不变。原件不动。
- p09：原样复制，未改任何断言。
- 其余既有回归文件（p0-tools / p05-type / p1-tasks / p2a-node / p2bc / p1-panel / p3c-* 等）**都没有改**。
