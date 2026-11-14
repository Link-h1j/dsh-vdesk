# P4-TOOLS — 工具面补欠账（task-2 / T2：B3 剪贴板 · B4 按下抬起 · B5 等画面稳定）

作 者：tools-dev（并行开发）
范 围：`tools/vdesk-childsession/plugin/dsh-vdesk/index.js`、`tools/vdesk-childsession/vdesk-cli.mjs`、工作区 `tools/vdesk-childsession/selftests/**`
红线遵守：**没有** stop/start/restart 虚拟桌面、**没有**杀 helper、**没有**碰 Windows 会话、**没有**向真机注入键鼠。全部验证走 mock（Node 假 helper + 真子进程跑 CLI）。

---

## 1. 交付内容

### 交付 1 · `vdesk_clipboard`（工具）+ `clipboard`（CLI）
- 工具：`vdesk_clipboard {action:"get"|"set", text?}` → helper `/clipboard?action=get|set&text=`。
  - `get` 回 `{ok,text,chars,truncated}`：`text` 按 **4000 字符**截断，`chars` 是剪贴板原有字符数，`truncated` 标明是否被截。
  - `set` 回 `{ok,chars}`；`text` 用 `encodeURIComponent`（UTF-8 百分号转义），与 `vdesk_type` 走剪贴板那段实现一致，中文/空格逐字节可还原。
  - 401 → `{ok:false,error:<UNAUTHORIZED_TEXT>,unauthorized:true}`。
- CLI：`node vdesk-cli.mjs clipboard get` / `clipboard set <text>`，与工具同形状（同样 4000 截断）。
- 工具追加在清单末尾 → 工具总数 **17 → 18**（`...,vdesk_apps,vdesk_resolution,vdesk_clipboard`）。

### 交付 2 · `vdesk_key` 按下/抬起（走 T1 冻结的 `POST /input`）
- 新增可选 `action:"combo"(默认)|"down"|"up"`，`combo` 语义与请求路径**完全不变**（仍 `GET /key?action=combo&vks=...`）。
- `down`/`up`：单键事件 `{"type":"key","vk":n,"down":true|false}`，`POST /input` body `{"events":[...]}`；
  - 多键组合（如 `ctrl+shift`）用于 down/up → `{ok:false,error:"action:down needs exactly one key (got 2)"}`，**不发任何请求**。
  - helper 回 `{ok:false,index,error}` → 原样透出（含 `index`）。
  - **旧 helper（无 /input）必须先诚实失败**：POST 得到 404/405 时按冻结契约改用 `GET /input?events=<urlencoded json>` 再试一次；两条都 404/405 → `{ok:false,error:"helper has no /input route (pre-P4 build): ...",preInput:true}`，绝不假装成功。若 GET 形式可用（只路由了 GET 的 helper）则正常成功。
- CLI：`node vdesk-cli.mjs key <combo> [--action down|up] [--no-after]`。
- 宿主半区 HTTP 层新增可选 body/content-type 能力（`rawHelperRequest/helperRequest/request`），8790 走原有 pinned-HTTPS + `X-VDesk-Token` 传输，未改传输策略。

### 交付 3 · `vdesk_wait` 等画面稳定
- `{ms}` 语义保留（默认行为、上限 600000 不变）。
- 新增 `{stable:true, timeoutMs?=30000, intervalMs?=400, samples?=3, maxDiffBytes?=0}`：宿主轮询
  `GET /screenshot?format=jpg&quality=40&scale=0.35&cursor=0`，**连续 `samples` 帧**每对相邻帧
  差异字节数 ≤ `maxDiffBytes`（默认 0 = 逐字节相同）即稳定。
- 返回 `{ok,stable,attempts,elapsedMs,bytes,lastHash,timedOut}`（+ `lastDiffBytes` 便于调阈值）。
  - 稳定：`{ok:true,stable:true,timedOut:false}`；3 帧静态画面 → `attempts=3`。
  - 超时：`{ok:false,stable:false,timedOut:true,error:"screen did not stabilize ..."}`（诚实，不伪造稳定）。
  - helper 不可达：`{ok:false,error}`。
- CLI：`node vdesk-cli.mjs wait --stable [--timeout ms] [--interval ms] [--samples n] [--max-diff bytes]`；`wait <ms>` 不变。

### 附带（需要 Lead 知情的最小改动）
- `index.js` 的宿主日志路径新增测试钩子 `VDESK_PLUGIN_LOG`（默认值不变，仍写真实 temp 的 `plugin-host.log`）。
  原因：沙箱下真实 `%TEMP%\dsh-childsession` 只读，p2bc 副本里「错误指纹要在宿主日志里出现」这条断言无法落地；
  该钩子与文件里既有的 `VDESK_NO_KEEPALIVE` / `VDESK_HELPER_PORT` 等测试钩子同风格，生产环境不设该变量 → 行为零变化。
- schema 只用了 DSH 允许子集（`type/oneOf/properties/required/additionalProperties/items/enum/const` + `description/title/default/examples`），
  没用 `min/max`；所有工具 description 均保留 SAFETY + SAFETY_ZH（由 p0 回归逐工具校验）。
- 失败一律 `{ok:false,error}`，工具 execute 不抛异常（`recordIfAction` 只兜底记录，不吞错误）。

---

## 2. 验收命令与结果（全部在本工作区实跑）

| # | 命令 | 结果 |
|---|------|------|
| 1 | `node --check tools\vdesk-childsession\plugin\dsh-vdesk\index.js` | exit 0 |
| 2 | `node --check tools\vdesk-childsession\vdesk-cli.mjs` | exit 0 |
| 3 | `node tools\vdesk-childsession\selftests\selftest-p4-tools.mjs` | **ok=58 fail=0**（exit 0） |
| 4 | `node tools\vdesk-childsession\selftests\selftest-p0-tools.mjs` | **ok=158 fail=0** |
| 5 | `node tools\vdesk-childsession\selftests\selftest-p05-type.mjs` | **ok=55 fail=0** |
| 6 | `node tools\vdesk-childsession\selftests\selftest-p1-tasks.mjs` | **ok=53 fail=0** |
| 7 | `node tools\vdesk-childsession\selftests\selftest-p2a-node.mjs` | **ok=22 fail=0** |
| 8 | `node tools\vdesk-childsession\selftests\selftest-p2bc.mjs` | **ok=46 fail=0** |

新回归 `selftest-p4-tools.mjs`（mock helper 实现 T1 冻结契约 + 真子进程跑 CLI）覆盖：
- 插件侧：clipboard get 短/超长(5000→4000+truncated)/CJK set 线上编码、key combo 向后兼容、down/up 的 POST body 逐字节形状、
  多键拒绝且零请求、helper `{ok:false,index,error}` 透出、旧 helper 的 POST→GET 双尝试与诚实报错、
  wait `{ms}` 不变、stable 成功(attempts=3/lastHash/冻结 URL)、changing 帧超时诚实、helper 掉线 `{ok:false,error}`。
- CLI 侧：`key ctrl+s`、`key shift --action down|up`、多键/非法 --action 拒绝、旧 helper 诚实报错、
  `clipboard get` 形状与 4000 截断、`clipboard set 中文 文本`、`wait --stable` 成功/超时、`wait <ms>`。

### 真 temp 原件与工作区副本的关系（环境限制，务必知情）
沙箱（DSH file policy = workspace-write）下 **`C:\Users\Administrator\AppData\Local\Temp\dsh-childsession` 只读**（读 OK，写被拒），
且 `$env:TEMP` 是私有目录、不等于项目真实临时目录。因此：
- 原件 `%TEMP%\dsh-childsession\{selftest-p0-tools,selftest-p05-type,selftest-p1-tasks,selftest-p2a-node,selftest-p2bc}.mjs`
  **未改（也改不动）**；我复制到工作区 `tools/vdesk-childsession/selftests/` 下同名文件，在副本上改断言并跑副本。
- 新自检按 Lead 指示放工作区：`tools/vdesk-childsession/selftests/selftest-p4-tools.mjs`。

**副本相对原件的差异（逐条）**：
1. 5 份副本的**工具清单断言**：17→18，并在列表末尾加入 `vdesk_clipboard`（p0-tools 加计数 18；p05-type 加列表并豁免
   `vdesk_clipboard` 的 `text` 属性检查；p1-tasks 的 EXPECTED 追加；p2a-node 计数 18 且「最新工具」改为
   `...,vdesk_resolution,vdesk_clipboard`）。
2. 需要真子进程捕获输出的 3 份（p05-type / p2a-node / p2bc）**只把 stdio 从 pipe 换成真实文件 fd**：
   沙箱禁止进程间命名管道（`spawn ... EPERM`），换成 `stdio:["ignore", fd, fd]` 后 `node` 子进程与真实 CLI 原样运行，断言逻辑不变。
3. p2bc 副本：证书读取路径改用**真实 temp 字面路径**（只读），可写产物（token/输出/`p2bc-run.mjs` 的日志）落在
   `selftests/.scratch/`；`RUNNER` 指向真实 temp 里的 `p2bc-run.mjs`（只读、可执行）；新增 `VDESK_PLUGIN_LOG` 指向工作区 scratch。
4. p05/p2a/p2bc 副本另建了 `selftests/.scratch/**` 作为可写临时目录（原本写 `os.tmpdir()`，沙箱下也是私有目录，但为一致性统一到工作区）；三份副本在跑完后会自清理该目录。

---

## 3. 跨范围问题（不是我的文件，未改，转 Lead / T1）

**`selftest-p06-auth.mjs:170`**（T1 名下）硬编码了工具数：

```js
check(regs.length === 17, "plugin still registers 17 tools", regs.length);
```

本任务把工具从 17 加到 18（`vdesk_clipboard`），该断言现在必然 FAIL。
证据：同一套注册路径在 `selftest-p0-tools.mjs` 里断言 `regs.length === 18` 且 `ok=158 fail=0`（运行时确实注册 18 个）。
需要 T1/Lead 把它改成 18（并且该文件同样位于只读真 temp → 需要工作区副本流程）。
其余旧测试我逐个 grep 过，除我已修的那 5 份外，没有别的硬编码 17 工具断言。

---

## 4. 真机注意事项
- `index.js` 是**宿主半区**：改完**没有重启 DSH**（Lead 统一安排）。届时需要完整重启 DSH 才生效。
- 真机上跑着旧构建 helper（8790 无 `/input`）：因此真机上 `vdesk_key action:down|up` 现在会**诚实报错**
  `helper has no /input route (pre-P4 build)`，等 T1 的新 helper 落地后才会真正按住/松开。
  `vdesk_clipboard` 与 `vdesk_wait stable` 不依赖 `/input`，重启 DSH 后即可用。
