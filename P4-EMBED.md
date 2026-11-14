# P4-EMBED · DSH 侧栏内嵌直播面板（task-3 / B2）

> 负责人：panel-dev（并行开发者）。写范围：`plugin/dsh-vdesk/client.js`、`plugin/dsh-vdesk/locale/*.json`、本文件、`selftests/**`。
> 目标：把「看同一块屏 + 能直接接管」搬进 DSH 自己的侧栏折叠菜单，对标豆包把 shadow session 嵌进主窗口。

## 1. 交付内容

在既有侧栏「虚拟桌面」折叠菜单里**增量**加了一块直播区（原有 开启/关闭/重启/独立窗口 + 任务步骤面板保持不变）：

1. **帧源（MJPEG）**
   `<img src="http://127.0.0.1:8791/stream?format=jpg&quality=72&scale=0.75&fps=10&cursor=1&maxSeconds=300&t=<Date.now()>">`
   —— 与 T1 冻结的 monitor `/stream` 查询串逐字一致；`t` 只用做缓存击穿。
2. **挂载条件**：仅当「菜单展开 **且** keeper 正在 holding（status.running）**且** helper.ok」。
   收起菜单 / 会话停止 / helper 不健康 / 服务不可达 → 立即卸载 `<img>`，**不留后台拉流**。
3. **错误占位**：`onError` → 卸载 `<img>`，显示虚线占位 + 「重试」按钮（手动重试，**没有自动重试循环**，坏掉的 monitor 不会被刷屏）。重试会把 stream nonce +1，靠 `key` 强制重新挂载。
4. **单击** → `POST http://127.0.0.1:8791/click?x=<归一化>&y=<归一化>&button=left`（右键 → `button=right`，并阻止原生右键菜单）。坐标换算 `x=(clientX-rect.left)/rect.width`、`y=(clientY-rect.top)/rect.height`，钳制到 0..1，保留 4 位小数。
5. **拖拽** → **单次** `POST http://127.0.0.1:8791/input`，body `{"events":[...]}`，事件序列严格按 T1 冻结契约：
   `move(按下点)` → `down(按下点,button,count:1)` → `move*(路径采样点，去重、上限 40 点)` → `up(抬起点,button,count:1)`。
   位移阈值 0.004（≈画面的 0.4%）：小于阈值算单击，不会误判成拖拽。
6. **接管语义不绕过**：所有输入都走 8791 同一入口；只读时 monitor 回 `{"ok":false,"error":"view-only"}`，面板**如实显示**「只读模式：尚未接管，未发送输入」，绝不另开通道。失败批次按 T1 契约显示 `error` + 1-based `index`（`{"ok":false,"index":2,...}` → 「第 3 个事件」）。monitor 不可达 → 「服务未响应，输入未发送」。
7. **未新增任何插槽注册**：仍然只有 `sidebar.panellist`（+ 既有 `main` 兜底）。**没有**碰 `sidebar.workspaces` / `sidebar.settings`（single 槽位，碰了两起真实事故）。
8. **状态轮询沿用既有 2.5s `/vdesk/status`**，render 里只做 Date.now() 级别的轻量计算。

## 2. 文案（locale）

`locale/zh.json` / `locale/en.json` 各新增 `panel` 段（键名与包内副本逐字一致）：

| key | zh | en |
|---|---|---|
| liveTitle | 实时画面 | Live view |
| liveHint | 点击 / 拖拽直接操作 | Click / drag to control |
| liveFailed | 画面加载失败（服务未就绪或流已结束） | The live view failed to load (service not ready, or the stream ended). |
| liveRetry | 重试 | Retry |
| viewOnly | 只读模式：尚未接管，未发送输入 | View-only: takeover is off, input not sent |
| inputFailed | 输入失败 | Input failed |
| inputUnreachable | 服务未响应，输入未发送 | Service did not respond, input not sent |

`client.js` 里 `ZH`/`EN` 是同源副本（回退）。**为什么需要回退**：浏览器半区的 `inject` 被 P1 回归锁死为 `["slots"]`（`selftest-p1-panel.mjs` 断言 `JSON.stringify(plugin.inject) === ["slots"]`），而 locale 服务要出现在 inject 里才保证可用；改 inject 就要改 P1 的既有断言（"只加不改"不允许）。
因此 `apply(ctx)` 里对 `ctx.locale` 做了**防御式**注册：主机暴露了 `ctx.locale.register/bind` 时就走字典（`effect` 存在则挂 effect 清理），否则用包内副本——两条路渲染结果相同。P4 自检第 11 组用 stub locale 服务验证了这条路径（`register` 收到 `zh+en`、`bind` 用命名空间 `dsh-vdesk`、渲染文案确实来自服务）。
> 若 Lead 认为应该正式走 locale 服务，需要改 `package.json` 的 `dsh.client.inject`（不在 task-3 写范围），我不越界。

## 3. 验收（命令 + 结果）

均在 `C:\Users\Administrator\Documents\deepseek-harness\默认工作区` 下跑：

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node --check tools\vdesk-childsession\plugin\dsh-vdesk\client.js` | exit 0 |
| 2 | `node -e "JSON.parse(...locale/zh.json + en.json)"` | 两份 JSON 合法，`meta + panel`，7 个 panel 键 |
| 3 | `node --check tools\vdesk-childsession\selftests\selftest-p4-panel.mjs` | exit 0 |
| 4 | `node tools\vdesk-childsession\selftests\selftest-p4-panel.mjs` | **ok=72 fail=0**，exit 0 |
| 5 | `node "C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\selftest-p1-panel.mjs"`（原件，只读） | **ok=25 fail=0**，exit 0（零回归） |
| 6 | `node tools\vdesk-childsession\selftests\selftest-p1-panel.mjs`（工作区副本，仅追加断言） | **ok=30 fail=0**，exit 0 |

P4 自检覆盖（`selftests/selftest-p4-panel.mjs`，stub React + 记录型 setState + stub fetch）：

- 只注册 `sidebar.panellist`（+ `main` 兜底），**无 single 槽位**；`inject` 仍为 `["slots"]`
- stream URL 形状逐项（origin/path/format/quality/scale/fps/cursor/maxSeconds/t）
- 挂载/卸载：展开+运行+helper 就绪才挂；收起/停止/helper 不健康/服务不可达一律不挂
- `onError` → 卸载 `<img>` + 占位 + 重试（重试清错并 bump nonce）
- 单击坐标换算 0.25/0.25、越界钳制到 1/1、右键 → `button=right`
- 拖拽 = 单次 `/input`，JSON body，`events` 恰为 `move,down,move,up` 四条且字段逐字匹配；拖拽**不会**退化成 `/click`
- `view-only` 如实上报（且不被当成成功）；失败批次的 1-based index；monitor 不可达提示
- 源码级：存在唯一 `liveStreamUrl`、无 single 槽位注册
- locale：zh/en 键集一致、7 个键、包内副本与 JSON 逐字一致；locale 服务路径可用

## 4. 与 T1 的依赖（真机现状）

只读探测（未注入任何输入、未改状态）：

```
GET http://127.0.0.1:8791/vdesk/status  -> 200 | keeper.phase=holding | helper.ok=true | window=false
GET http://127.0.0.1:8791/stream?...    -> 404 text/plain   (正在跑的 monitor 是旧构建)
```

即：**session 35 活着、helper 就绪**，但当前进程里的 monitor 还没有 T1 的 `/stream` 与 `/input`。
所以在 T1 的 monitor 重新生成并由 Lead 重启之前，侧栏直播区会按设计显示「画面加载失败…+ 重试」占位——这是**诚实**行为，不是 bug。T1 落地后无需再改 client.js（契约已按冻结串实现）。

## 5. 已知限制 / 留给 Lead

1. **真机视觉验收由 Lead 统一做**（需要刷新页面）。本 task 全程未 reload 页面、未重启 DSH、未 stop/start/restart 虚拟桌面、未注入键鼠。
2. `maxSeconds=300` 是 T1 冻结值：流到 5 分钟后可能停在最后一帧（不报错）。恢复方式：收起再展开菜单（重新挂载，`t` 变化）。若想要自动续流，需要和 T1 商量把上限放宽或加续流语义；本 task 不擅自改冻结 URL。
3. 面板宽度沿用既有 190–260px（未改放置逻辑）；真机放大窗口时若显得小，可让 Lead 决定是否放宽上限。
4. `selftests/` 放在工作区是**因为沙箱里真实 `%TEMP%\dsh-childsession\` 只读**；原件 `selftest-p1-panel.mjs` 未改动，改动落在工作区副本（文件头已注明）。
5. 非本范围的回归（index.js / helper / monitor）我没有触碰，也没有替别人改。
