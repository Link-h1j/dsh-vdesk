# P1：任务运行器 + 步骤面板 + 生命周期（对标豆包「任务模式」）

改动：`plugin\dsh-vdesk\index.js`（任务运行器/生命周期）、`plugin\dsh-vdesk\client.js`（步骤面板）、`make-vdesk-monitor.mjs` → 重新生成 `vdesk-monitor.mjs`（新增 `GET /vdesk/task`，生成器仍是唯一真源）。**未动** `helper\`、`vdesk-cli.mjs`、`vdesk.ps1`。宿主半区改动**需完整重启 DSH 才生效**。

## 三个新工具（工具面 12 → 15；原 12 个的名称/参数形状未变）
- `vdesk_task {goal, steps?}` → `{ok, taskId, startedAt, goal, planned, journal}`。开一个任务；**同一时刻只有一个**（再开新的会把上一个按 `ok:false / note:"superseded by a newer task"` 收尾）。
- `vdesk_task_end {taskId?, ok?, note?}` → `{ok, taskId, ok, total, failed, durationMs, journal, destroyed, stop}`。写 summary；`taskId` 给了就必须匹配；默认判定 `ok = 没有失败步骤`。
- `vdesk_keepalive {on}` → `{ok, keepalive, note}`。`on:true` 同时抑制「任务结束自动销毁」和「空闲回收」。

## 记账格式 `out\tasks\<taskId>.jsonl`（每行一个 JSON）
- 首行 `{type:"task", taskId, goal, planned[], startedAt, ts}`
- 每步 `{type:"step", n, tool, args, ok, ms, ts, screenshot?, error?}`（`screenshot` = 动作后截图/`vdesk_screenshot` 落盘路径；`args` 里字符串截断到 160 字符）
- 末行 `{type:"summary", taskId, ok, total, failed, startedAt, endedAt, durationMs, note?}`
- 只记「动作类」工具；`vdesk_status`/`vdesk_task`/`vdesk_task_end`/`vdesk_keepalive` 记账时跳过。

## 步骤面板（侧栏「虚拟桌面」折叠菜单，沿用现有 panellist 行，未新增单例插槽）
每 2.5s 与 status 同频多拉一次 `GET /vdesk/task`（8791，只读最新 jsonl）：菜单底部显示「当前任务 · 第 n 步 · 最近：<工具> ok/失败」，已结束则显示「任务已结束 · 成功/失败 · 共 n 步 · 失败 k · Xs」；展开列出**最近 10 步**（`#n 工具 ok/失败 · Nms`），失败步骤用主题红加粗。

## 生命周期
- **任务结束 = 注销**（用户 2026-10-02 拍板）：`vdesk_task_end` 成功后 POST `/vdesk/stop` → `vdesk.ps1 stop`（内部 `logoff` 子会话 + 收 helper），返回 `destroyed:true`；`vdesk.ps1` 本身无需改动。
- **空闲回收**：宿主半区每 60s 检查，无进行中任务且最后一次动作超过 10 分钟 → 先 `GET /vdesk/status` 确认 `keeper.phase==="holding"` 再 stop，日志写「空闲回收 idle reclaim」。
- **keepalive** 打开时，上面两条都不触发（手动保活）。

## 自检（mock，未启动虚拟桌面）
`node --check` 三个文件 + 生成器重生成后 `node --check` 全部通过（并已验证生成器能逐字节复现改动前的 monitor，diff 只有新增）。
- `%TEMP%\dsh-childsession\selftest-p1-tasks.mjs`（mock helper/monitor + 真子进程起生成的 monitor 打 `/vdesk/task`）：**ok=53 fail=0** —— 15 工具清单、jsonl 三行形状与 `screenshot`/`error` 字段、summary 计数与耗时、`task_end` 确实 POST `/vdesk/stop`、taskId 校验、supersede 收尾、keepalive 抑制销毁与空闲回收、空闲回收阈值后确实 stop、以及 `/vdesk/task` 的 `steps/summary/active/planned` 结构。
- `%TEMP%\dsh-childsession\selftest-p1-panel.mjs`（stub React 渲染折叠菜单）：**ok=25 fail=0** —— 只注册 `sidebar.panellist`+`main`（无单例插槽）、任务行文案、失败步骤 `.bad`、10 步上限、关闭时无菜单。
- 回归：`selftest-p0-tools.mjs` **ok=137 fail=0**、`selftest-p05-type.mjs` **ok=53 fail=0**（工具数已更新为 15）。

## 遗留
- 面板的视觉/交互需真实 DSH 重启后人工看一眼（client 半区热刷依赖 dev:web）；monitor 的 `/vdesk/task` 也需重启后由 8791 提供。
- 空闲回收按宿主半区计时器实现（描述里的备选），未改 `vdesk.ps1`。
