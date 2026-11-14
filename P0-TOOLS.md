# P0-D：CLI 工具面已注册为 DSH 原生工具（配方 A）

改动文件：`tools\vdesk-childsession\plugin\dsh-vdesk\index.js`（保活逻辑原样保留，仅追加工具注册；`package.json` 未动）。**必须完整重启 DSH 才生效**（host 半区，热刷无效）。

## 注册的 12 个工具
| 工具 | 参数 | 语义 |
|---|---|---|
| `vdesk_status` | 无 | 转发 8791 `/vdesk/status`（running/sessionId/uptime/windowed/helper） |
| `vdesk_start` / `vdesk_stop` / `vdesk_restart` | `minutes?` | POST `/vdesk/{action}`；`minutes` 仅透传（monitor 目前忽略） |
| `vdesk_screenshot` | `format?`(png/jpg) `scale?` `quality?` `rect?` | 存盘，返回 `{ok,path,kb,bytes,ms,width,height}` |
| `vdesk_click` / `vdesk_move` / `vdesk_drag` / `vdesk_scroll` | 坐标 `x,y`（drag 为 `x1,y1,x2,y2`；scroll 有 `delta?`）+ `after?` | 默认动作后再截一图（`after:false` 关闭，`count:2` = 双击） |
| `vdesk_key` | `combo`（如 `ctrl+s`） | 内部 VK 映射（照抄 vdesk-cli.mjs）→ `/key?action=combo&vks=` |
| `vdesk_type` | `text` `via?` | 默认 `auto` = 剪贴板+Ctrl+V（失败自动回退 SendInput）；`via:clipboard\|sendinput` 强制单一路径 |
| `vdesk_wait` | `ms` | 只 sleep（≤600000），不碰 guest |

- **坐标规则**：`≤1` = 归一化(0..1 × 当前桌面)，`>1` = 像素；尺寸取自 helper `/health`，不可用时回退 1280×800。
- **截图存放**：`C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\shots\shot-<时间戳>-<序号>.<ext>`；P0 返回路径给模型 `read_image`（内联 base64 留 P1）。宽高直接解析 PNG IHDR / JPEG SOF。
- **失败不抛异常**：一律返回 `{ok:false,error}`；`exec.signal` 已接入（HTTP 与 wait 可取消）。每个 description 都写明「占用整机唯一子会话名额；豆包虚拟桌面在跑时 start 被安全阀拒绝 / machine-wide single child-session slot」。
- schema 只用 DSH 允许子集（type/oneOf/properties/required/additionalProperties/items/enum/const + description/title/default/examples），未用 min/max。

## 自检（mock，无需真实会话）
脚本 `%TEMP%\dsh-childsession\selftest-p0-tools.mjs`（不在工作区）：mock `ctx.tools.register` + 假 18790/18791 服务，`VDESK_NO_KEEPALIVE=1` 防止误拉面板。
`node --check` 通过；**ok=115 fail=0**：12 个工具的 name/description/parameters/output 形状与 schema 合法性、render 文本块、status/start(minutes)/stop/restart、截图落盘与 PNG 尺寸、归一化与像素坐标、`after:false`、VK 映射与未知键、ASCII 与中文两条 type 路径、wait、服务全挂时全部 `{ok:false,error}`。

## 遗留
- 未在真实 DSH 宿主验证（重启后新会话才可见）；未启动虚拟桌面、未碰 Windows 会话。
- 中文 type 依赖 task-1 的 helper `/clipboard`；缺失时 `auto` 会回退 SendInput 并在返回里写明（显式 `via:clipboard` 则报 `ok:false`）。

## P0.5-A 更新（type 默认改走剪贴板）
- 起因：P0-C 冒烟发现「运行框」里逐字 SendInput 会把 `notepad` 打成 `mlg-kcw`（AutoComplete 控件丢/错序字符），同一条命令在记事本里却正常；剪贴板+Ctrl+V 两者都正确。
- 改动：`vdesk-cli.mjs` 的 `type` 与插件的 `vdesk_type` 默认都改为**剪贴板 + Ctrl+V**（任意文本）；CLI 新增 `--via auto|clipboard|sendinput`，工具新增可选 `via`（enum，默认 auto）。`auto` 在 helper 无 `/clipboard` 或 set 失败时自动回退 SendInput，返回里的 `via` 会写成 `sendinput(fallback)` + `fallback:true`，不会冒充默认路径；其余 11 个工具的名称与参数形状未动。
- 自检（`%TEMP%\dsh-childsession\selftest-p05-type.mjs`，mock helper + 真实子进程跑 CLI）：`node --check` 两个文件通过，**ok=50 fail=0**——覆盖 CLI 默认/`--via sendinput`/缺 `/clipboard` 回退/显式 clipboard 严格失败/未知 `--via`/中文编码/`after` 截图仍工作，以及插件 12 工具顺序不变、仅 `vdesk_type` 增加 `via`、auto/clipboard/sendinput/回退/helper 全挂不抛异常。旧回归 `selftest-p0-tools.mjs` 同步更新后 **ok=116 fail=0**。
- 生效条件不变：`index.js` 改动需**完整重启 DSH**（Lead 统一安排，未重启）。

## P0.6-B 更新（host 侧带 token + monitor 收紧来源校验；协议与 task-10 逐字一致）
- **8790 helper 要鉴权**：除 `GET /health` 外所有路由都要 `X-VDesk-Token: <32 hex>`。`vdesk-cli.mjs` 与插件 `index.js` 都在**每次请求前重读** token 文件（默认 `%TEMP%\dsh-childsession\out\token`，可用 `VDESK_TOKEN_FILE` 覆盖）→ 便于轮换；文件缺失/不匹配就**不发头**，helper 回 401。401 一律翻译成顶层 `{ok:false, error:"unauthorized"}`（插件里是可读长文案），CLI 还会在 **stderr** 提示「token 缺失或不匹配 + 检查 helper 是否已重启到新版」；`shot` 遇到 401 不会再写出一个假的 jpg。
- **8791 monitor 仍是浏览器入口，所以不校验 token**（页面读不到本地文件）：改成**来源白名单** `dsh-app://app`、`http://127.0.0.1:19387`、`http://localhost:19387`、`null`、以及 monitor 自身同源页面；只有白名单 origin 才回 `Access-Control-Allow-Origin`（并 `Vary: Origin`）。**写路由**（`/vdesk/start|stop|restart|window`、`/mouse`、`/key`、`/click`）对「带了 Origin 但不在白名单」的请求直接 **403**（拒绝的请求不会到达 8790）；只读路由（`/shot`、`/meta`、`/vdesk/status`、`/vdesk/task`）保持可用。**无 Origin 的本地进程**（DSH 宿主半区、`vdesk-cli`）视为可信——这是防 CSRF 的轻量校验，真正的控制面凭证是 8790 的 token。
- **UI 为什么不受影响**：面板页面在 `http://127.0.0.1:19387`（桌面版 `dsh-app://app`），在白名单里；它只调 `/vdesk/status` `/vdesk/task`（只读）和 4 个 `/vdesk/*` 写路由，全部放行；monitor 自带页面点「接管」后的 `/mouse` `/key` `/click` 是同源，也放行。monitor 自己作为 8790 客户端会带 token 转发（`/shot` 等）；helper 回 401 时 `/shot` 原样回 401 `unauthorized`，不再假装是图片。
- 生成器新增一个测试钩子 `VDESK_HELPER_PORT`（默认仍是 8790），让离线 mock 能顶替会话内 helper；生产不会设置它。
- 自检（`%TEMP%\dsh-childsession\selftest-p06-auth.mjs`，mock helper 按协议强制校验 + 真子进程跑 CLI + 起两个生成的 monitor）：`node --check` 4 个文件通过、生成器重生成逐字节一致，**ok=48 fail=0** —— CLI/插件每条 8790 请求都带头、8791 不带 token（不泄漏）、错 token 与缺 token 文件的降级与 stderr 提示、`shot` 401 不落假文件、monitor 对非白名单 origin 的写路由 403 且不触达 8790、白名单 origin/同源/无 Origin 放行、只读路由对外来源仍可用、转发带 token、helper 401 原样透出。回归：p0-tools **137/0**、p05-type **53/0**、p1-tasks **53/0**、p1-panel **25/0**。
- 生效条件：`index.js` 是宿主半区，**需完整重启 DSH**；monitor 也要重启后才提供新的白名单逻辑（`vdesk-monitor.mjs` 由生成器产出，已同步）。

## P0.9 更新（原生窗口策略 B：不许意外复活 + 空闲自动关闭）
- **事故与根治**：开关是文件 `out\keeper.window`，会跨 keeper 重启残留 → 10:47 用户桌面突然出现「子会话窗口」。现在 `vdesk.ps1 start` 在启动 keeper **之前**、`stop`、`restart`（=stop→start）都会先 `ClearWindowFlag`（连 `keeper.touch` 一起删）；**keeper 自己启动时也会删掉遗留标志**并记日志——只有显式 `window on`/`POST /vdesk/window?on=1` 会创建它，双保险，无法再意外复活。
- **空闲自动关闭放在 keeper（选它的理由）**：窗口是 keeper 在 session 1 上持有的，标志也是它的输入；keeper 一旦退出窗口即消失，且**只有 keeper 能看见"用户直接操作那个 RDP 窗口"**（鼠标/键盘直接进 RDP 控件，monitor 和 helper 都看不到）。反过来若放在 monitor 侧定时器，既依赖 monitor 存活，又会漏掉用户的真实操作（工具调用的 8790 注入根本不经过 monitor）。交互时间刷新源三合一：① 光标停在窗口矩形内（每 200ms tick 检查，覆盖"人在用"）② 窗口 `Activated`（键盘/切焦点场景）③ `out\keeper.touch`（monitor 转发面板注入时写）——阈值默认 **10 分钟**，`VDESK_WINDOW_IDLE_MIN` 覆盖（≤0 回退默认）。超时即删标志 + 隐藏表单（移出屏外）+ 日志「原生窗口空闲自动关闭（N 分钟无交互）」。
- **可观测**：keeper.json 新增 `windowSince / windowIdleSec / windowIdleMin`；`/vdesk/status` 顶层新增 `windowSince / lastWindowTouch / windowIdleSec / windowIdleMin`（keeper 在跑时用它的时钟，keeper 不在时回退到 `keeper.window` 与 `keeper.touch` 的 mtime）。monitor 的 `/vdesk/window` on/off 现在同步**重置/删除** `keeper.touch`；生成器新增测试钩子 `VDESK_KEEPER_JSON`（默认仍是真实路径）。
- 自检（`%TEMP%\dsh-childsession\`，未启动会话、未开窗口）：`selftest-p09-keeper.ps1` **ok=49 fail=0**（BOM/编码守卫、AST 断言 start 清标志且**在 keeper 启动之前**、stop 清标志、window on 建标志、**直接抽出真实函数体跑** `ClearWindowFlag`/`CloseIdleWindow`/启动守卫/env 覆盖、keeper C# 块 csc 编译通过、5.1 实跑 `status`/`window off` exit 0 且中文解码正确）；`selftest-p09-monitor.mjs` **ok=20 fail=0**（起生成的 monitor：status 窗口字段与 keeper/env 优先级、无 keeper 时按文件 mtime 算 idle、window on/off 建删标志+touch、转发注入刷新 touch、非白名单写仍 403）。回归：p06-auth **48/0**、p0-tools **137/0**、p05-type **53/0**、p1-tasks **53/0**、p1-panel **25/0**。
- **编码红线（本次踩过）**：`vdesk.ps1`/`keeper.ps1` 必须 **UTF-8 with BOM**。用编辑器/工具重写后会**丢 BOM**，Windows PowerShell 5.1 会按 GBK 读，直接解析失败（`start`/`stop` 全废、乱码如 `鎷掔粷`）。每次保存后必须验证：`[IO.File]::ReadAllBytes($p)[0..2] -join ','` == `239,187,191`，并用 `powershell -NoProfile -File vdesk.ps1 status` 实跑一次确认 exit 0。

## P2-A 更新（分辨率可配，对齐豆包 1920×1080）
- **用法**：`vdesk_resolution {width, height}`（或 CLI `node vdesk-cli.mjs resolution 1920 1080`）。RDP 的桌面尺寸在**连接时**确定，所以改分辨率 = 把目标写进 `out\desired-resolution.json` 然后 **`POST /vdesk/restart`**（重建会话，约 1 分钟）；返回 `{ok,width,height,restarted,desired,restart}`，重复调用同一尺寸也会重建。合法范围 320..4096 × 240..4096，越界直接 `ok:false` 且不写文件、不重启。
- **`vdesk.ps1 start`** 新增 `-Width/-Height`（显式优先）→ 透传 `keeper.ps1 -Width -Height`（keeper 本来就在 RDP 连接里设 DesktopWidth/Height，**本任务无需改 keeper.ps1**）；未显式给参数时读 `desired-resolution.json`，再退回 1280×800。`vdesk.ps1 status` 会打印本行「分辨率 WxH（命令行指定 / 来自 desired-resolution.json / 默认）」。`/vdesk/status` 顶层新增 `resolution:{width,height,source}`，优先级 helper 实测值 > keeper 请求值 > desired 文件 > 默认（`source` 就是来源）。测试钩子 `VDESK_DESIRED_RES`（默认真实路径）。
- **代价（用户要的 1920×1080）**：1920×1080 是 1280×800 的 **2.03 倍像素**；实测 1280×800 的 png(scale 1.0) 已 1.38MB，按比例 1920×1080 约 **2.8MB/帧**。所以高分辨率务必配 `format:jpg`（或 `scale ≤0.75`），否则每帧 ~3MB 会明显拖慢取帧与传输。
- 自检（`%TEMP%\dsh-childsession\`，未启动会话、未开窗口）：`selftest-p2a-node.mjs` **ok=22 fail=0**（16 工具清单/参数、写 desired 文件并触发 restart、越界拒绝且不写不重启、CLI 同样两条、status `resolution` 四种 source 优先级、window 字段未回归）；`selftest-p2a-resolution.ps1` **ok=21 fail=0**（BOM 守卫、`-Width/-Height` 参数与 keeper 透传行、**抽出真实 `GetDesiredResolution` 跑**默认/1920×1080/越界/垃圾文件四种情形、keeper 的 DesktopWidth/Height、5.1 status exit 0）。回归：p06-auth **48/0**、p0-tools **144/0**、p05-type **54/0**、p1-tasks **53/0**、p1-panel **25/0**、p09-keeper **49/0**、p09-monitor **20/0**。
- 生效条件：`index.js`（新工具）需**完整重启 DSH**；monitor 需重启才提供新的 `resolution` 字段；`vdesk.ps1` 改动下次 `start` 即生效。

## P2-B/C 更新（`vdesk_apps` 应用枚举/启动 + 8790 HTTPS 证书钉扎）
- **`vdesk_apps {action:"list"|"launch", name?, limit?}`**（CLI：`node vdesk-cli.mjs apps list | apps launch <名字>`）→ 带 token 转发 helper `/apps`，**返回原样 JSON**：`list` 给 `{ok,count,apps:[{name,target,source}]}`（helper 上限 200；Win11 的「记事本」只在 `appx` 源里，别只按名字截断），`limit` 只在 host 侧裁剪数组、`count` 仍是 helper 的总数；`launch` 原样透传 `{ok,matched,pid,source}` / `{ok:false,error:"no-match",candidates}` / **`{ok:false,error:"blocked-by-policy"}`**——`doubao`/`豆包` 的黑名单策略在 host 侧**绝不重试、绝不改写**（自检里断言返回体与 helper 逐字节一致，且该次调用只发出 1 个请求）。
- **8790 改成 HTTPS + 证书钉扎（三处客户端：CLI、插件工具层、monitor 转发/健康探测）**：helper 是自签证书，所以**信任锚是 `out\helper-cert.sha256` 里的 SHA-256**（`rejectUnauthorized:false` + `checkServerIdentity` 放行主机名，真正校验是 socket `secureConnect` 时比对 `getPeerCertificate().fingerprint256`；**不匹配就在发出任何请求字节之前 destroy 连接**——实测 helper 端收不到该请求）。三处都在每次请求前重读 token/pin 文件，传输决策缓存 5s。
- **四种回退都实测过**，且每条都在 stderr/日志写明原因：① `VDESK_HTTP_ONLY=1` → http；② 没有 `helper-cert.sha256`（task-15 未落地）→ http；③ 证书存在但 helper 自己是 http（**本机现状**：`netsh http add sslcert` 还没做，helper 探针失败后自退 http）→ host 先试 https 失败即回落 http；④ 指纹不匹配 → 拒绝（不会静默降级到 http 去绕过校验，因为那会连错端口/错协议，工具直接报错）。修好 netsh（管理员跑一次 `out\helper-cert.setup.cmd`）后最多 5s 自动切回 https。
- 测试钩子：`VDESK_CERT_PIN`（默认 `out\helper-cert.sha256`）、`VDESK_HTTP_ONLY`（与 helper 同语义）。`status.helper`/健康探测与其它 8790 调用**走同一条通道**。
- 自检（`%TEMP%\dsh-childsession\`，未启动会话、未开窗口；HTTPS mock 直接用 **task-15 的真实 pfx+pwd** 起，并交叉验证 pin 文件与证书指纹一致）：`selftest-p2bc.mjs` **ok=41 fail=0** —— 工具/CLI/monitor 三条 http 与 https 路径、错指纹被拒且 helper 收不到请求、四种回退与 stderr 原因、apps list/limit/launch/no-match/blocked-by-policy 透传与"不重试"。回归：p2a-node **22/0**、p2a-resolution **21/0**、p06-auth **48/0**、p0-tools **151/0**、p05-type **55/0**、p1-tasks **53/0**、p1-panel **25/0**、p09-keeper **49/0**、p09-monitor **20/0**（工具数 16→17 已同步）。
- 生效条件：`index.js`（第 17 个工具 + 传输层）需**完整重启 DSH**；monitor 需重启；CLI 立即可用。注意**运行中的 8790 helper 是旧构建（无 `/apps`）**，下次 `vdesk.ps1 start` 换新后 `apps` 才可用。

## P3-B 更新（启动项隔离：子会话不启动用户个人启动项）
- **设计理由**：子会话是**同一用户**的影子会话（专用账户已被证伪），所以它会照跑该用户的个人启动项；机器级单例套件（腾讯桌面整理）在子会话里起第二份会与真机那份抢单例 → 双崩。**为什么整目录而不是白名单**：白名单要长期维护、还可能被软件自我修复重建；整目录一刀切，且子会话本来就不需要用户的任何个人启动项。
- **实现**：`vdesk.ps1 start` 在启动 keeper **之前**把 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 改名 `Startup.vdesk-held`，`stop` 恢复；`start/stop/status` 三处**自愈**（发现 held 但没有我们的会话 → 立刻恢复；marker `out\startup-held.json` 记录 original/held/pid/heldAt，崩溃后下次运行也能自愈）。**只改文件夹名字**：不改 Run 键、不动服务、不杀用户进程、不改账户。`status` 新增 `startup: 正常（Startup）/ 持有中（Startup.vdesk-held）` 一行。
- **事后验证与告警（必须）**：`start` 建好会话后按会话号实测单例型进程（`DesktopMgr64|QQPCExternal|QQPCTray|DesktopAITaskCenter|QQPCSoftCmd`），写 `out\startup-guard.json` 并由 `/vdesk/status` 暴露为 **`guest:{checkedAt,childId,hermetic,found[],names,held,releasedAt}`**：`hermetic:true` → 日志「启动项隔离有效」；否则**响亮告警**（日志 + status + 进程名清单），提示"可能有 Run 键/服务级自启"；`stop` 会把 `held` 置 false 并加 `releasedAt`（不留过期的"持有中"假象）。
- **副作用（话术）**：持有期间若用户的 explorer 重启，其启动项不会自动起来（腾讯套件由其守护/自修复拉回）；恢复方式 = 跑一次 `vdesk.ps1 stop`，或手工把 `Startup.vdesk-held` 改回 `Startup`（`status` 会提示当前状态）。
- **真机验收结果（12:04 会话 34，详见 `STARTUP-ISOLATION.md`）**：持有/恢复/自愈全部正确（start 前即 held、stop 后 `Startup` 回读为 True 且 `#`=0），**但隔离对腾讯套件无效**——子会话里仍起 6 个进程，告警如实响。只读取证到真正启动器：**计划任务 `DeskGo`（MSFT_TaskLogonTrigger → `DesktopMgr64.exe /StartFrom=AutoRun`）** 与 `HKCU\...\Run`（ctfmon/LGHUB/Tabbit）；会话 1 的腾讯 PID 也换了一轮（双崩→自修复）。**结论：只改启动文件夹拦不住 Run 键/登录计划任务，需 Lead 决策是否在会话期屏蔽 `DeskGo` 等（超出本任务红线，未做）**。
- 自检：`selftest-p3b-startup.ps1` **ok=44 fail=0**（BOM/解析守卫、AST 断言 start 先 HoldStartup 再启 keeper / stop 恢复 / status 自愈 / 有启动后守卫、**取出真实函数体**在临时目录跑 hold/restore/幂等/自愈(有会话时不抢)/双存在不覆盖/stale marker/guard JSON 与告警文案/`releasedAt`，并断言**真实 Startup 目录未被测试触碰**）。

## P3-C 更新（冲突探测-退让：不改系统，探测 + 告知 + 你拍板）
- **启动前只读探测**（`GetSingletonConflicts`，WMI 按进程名，列 `{name,pid,session}`）：白名单默认 `DesktopMgr64/DesktopAITaskCenter/QQPCExternal/QQPCTray/QQPCSoftCmd`，可用 `out\singleton-watchlist.txt` 覆盖（每行一个名，可带 `.exe`，`#` 注释）；**文件不存在 = 内置默认；文件存在但只有注释/空行 = 显式关闭探测**（`status` 会显示"空：已关闭冲突探测"）。**判定发生在做任何事之前**：`vdesk.ps1 start` 在任何 `Stage`/keeper 启动之前就探测，命中即 `exit 4` 并打印 `CONFLICT {json}`，不创建任何会话。
- **默认拒绝**：`{ok:false,error:"singleton-conflict",found:[...],advice:"…请先退出它们再启动；或确认接受风险后用 force=true 继续。"}`；三层一致：`vdesk.ps1`（exit 4）、`POST /vdesk/start`（新只读路由 `GET /vdesk/conflict` 供上层预检）、工具 `vdesk_start{force:true}`、CLI `start --force`。
- **显式放行 `force`**：`vdesk.ps1 start -Force` / `POST /vdesk/start?force=1` / 工具 `vdesk_start{force:true}` / 面板「强制启动」。放行时：① 日志 + **stderr** 醒目警告（列出命中的 pid/session）；② `/vdesk/status` 的 `conflict.forced=true`（并写入 `out\conflict.json`）；③ 有任务时 journal 追加 `{type:"note",kind:"forced-start",found}`；④ 启动后照旧实测子会话白名单进程（`guest:{hermetic,found[]}`）。
- **状态与 UI**：`/vdesk/status` 顶层新增 `conflict:{checkedAt, found:[{name,pid,session}], forced, refused}`（先给缓存 + 后台每 ≤60s 刷新一次，**轮询 status 不会每次都 spawn 探测**）；客户端折叠菜单在 `found` 非空时显示**琥珀色**「⚠ 检测到 … 在运行，启动可能双崩」+「强制启动」按钮（`/vdesk/start?force=1`，主题继承）。
- **为什么只做探测不改系统**：见 `KNOWN-LIMITS.md`（子会话与控制台用户身份绑定 ⇒ 换账户不可行；自启来自 `DeskGo` 登录计划任务 + Run 键 ⇒ 改启动文件夹无效；且已两次把用户真机搞崩）。
- **真机只读验收（12:12，未 force、未起会话）**：`vdesk.ps1 probe` → `probe-exit=0` 且 `found` 列出真实 6 个进程（`DesktopMgr64 pid=29108 sess=1`、`DesktopAITaskCenter 35844`、`QQPCExternal 20584/44156/46668/47312`）；`vdesk.ps1 start`（无 force）→ **exit 4** + 逐条列出命中 + `CONFLICT {...refused:true...}`，事后 `#`=0、`keeper.json` 未变（**未创建会话**）。禁止用 force 真起会话，未做。
- 自检：`selftest-p3c-conflict.ps1` **ok=28 fail=0**（BOM/解析、AST 断言 `-Force` 参数/探测在 `Stage` 与 keeper 启动之前/`exit 4`/restart 透传/-status 冲突行、**真实函数体**跑白名单默认·覆盖·注释·`.exe` 去尾·空文件关闭、命中形状 `{name,pid,session}`、record 往返、且断言未写真实 `conflict.json`）；`selftest-p3c-monitor.mjs` **ok=20 fail=0**（mock `vdesk.ps1`：`GET /vdesk/conflict` 只调 `probe`、status 的 `conflict` 形状与缓存(轮询不重复探测)、`force=1` 真的把 `-Force` 传给 `vdesk.ps1` 而普通 start 不带、record 的 forced 反映到 status、插件无 force → `singleton-conflict` 且**不发起 start**、force → 放行 + 结果标记 + journal `forced-start` note）。
