# DSH 虚拟桌面 · 对标豆包的设计草案（v0.1）

> **2026-10-21 更新：UI 入口改为右侧栏。** 「虚拟桌面」不再挂在左侧面板列表，而是作为
> 右侧栏页类型 `vdesk` 注册（guide 卡片 + tab body/title），点击右侧栏「开始」里的
> 「虚拟桌面」卡片即可打开控制页。下文 §3/§4 里「侧栏折叠菜单」的位置描述是当时的
> 设计记录，功能清单仍然有效。

> 目标：把现在这套"能跑的原型"升级成豆包那样的**任务式虚拟桌面**——用户给一个任务，agent 在独立桌面里一步步执行，步骤可见、失败可查、结束自动销毁；对模型暴露的是一套**归一化坐标 + 截图 + 剪贴板**的统一接口（对标豆包的 GAC）。
>
> 现状：**原型已可用**（见 §1）；本草案只设计**增量**，不动已验证的部分。

---

## 1. 已经在跑的（本轮实测过，作为地基）

| 部件 | 状态 | 关键事实 |
|---|---|---|
| keeper（会话保活） | ✅ | RDP ActiveX + **标准 WinForms 消息循环**（`Application.Run` + Timer）；`MaximumSeconds` 上限；支持**接管遗留子会话**（`GetChildRow` 兜底） |
| helper（会话内 HTTP :8790） | ✅ | ThreadPool；`/health /screenshot?format=jpg\|png&quality=&scale= /mouse /key` |
| monitor/面板（:8791） | ✅ | CORS；`/shot /mouse /key /click /takeover` + `/vdesk/status|start|stop|restart|window`；**VBS 隐藏窗口启动**（无任务栏终端） |
| 控制面 | ✅ | `vdesk.ps1 start\|stop\|restart\|window\|status`；`start` 遇**外来子会话**直接拒绝（安全阀） |
| 客户端 UI | ✅ | 侧栏「虚拟桌面」**就地折叠**（开启/关闭/重启/独立窗口）+ 原生 RDP 独立窗口 |
| 延迟 | ✅ | 端到端 点击→可见 **≈220ms**；15fps（JPEG 0.75/scale） |
| 调试/重载 | ✅ | CDP（`--remote-debugging-port=9222`）+ `cdp.mjs` / `reload-dsh.mjs` |

**与豆包最大的结构性差异（必读）**：整套东西靠 **Windows Child Session**，而**一台机器同时只能有一个 Active 子会话**。豆包也是同类机制，所以：
- 我们和豆包**不能同时开**（我方 `start` 检测到外来子会话就拒绝；占用期间豆包会 16s 超时失败 reason=516）；
- **不存在"多桌面并行"**——任何设计都不要假设能开第二个。

---

## 2. 目标能力（对齐豆包）

> 状态列 = **P4 收口后（2026-10-02）** 的真实进度，证据见 `P4-SUMMARY.md`（真机整链 18/18、全量回归 18 套 fail=0）。

| # | 能力 | 豆包 | 状态（P4 后） |
|---|---|---|---|
| G1 | 给模型的**统一操作接口** | GAC：Python API，17 条命令，归一化坐标 | ✅ **比豆包更直接**：18 个 DSH 原生工具 + `vdesk-cli.mjs`（agent 直接调用，不必手写 HTTP） |
| G2 | **归一化坐标** | `normalized desktop coordinates` | ✅ 所有输入接口接受 0..1 或像素两种写法（helper `ResolveCoord`、monitor `/click`、工具层三处一致） |
| G3 | **剪贴板通道** | Get/SetClipboard、CopySelection | ✅ `vdesk_clipboard {get\|set}`（4000 截断）+ CLI，真机 set→get 往返已验；⚠️ 仍无 `CopySelection`（选区复制） |
| G4 | **任务化 + 步骤清单** | 左侧步骤列表 + 状态 + 失败记录 | ✅ `vdesk_task` / `out\tasks\<id>.jsonl` / 侧栏步骤面板（P1 交付） |
| G5 | **自动销毁** | `auto_destroy_shadow_session_when_exit=true` | ✅ 任务结束默认注销 + 空闲 10 分钟回收 + `vdesk_keepalive` 覆盖（P1 交付） |
| G6 | 虚拟光标 | 画进帧里 | ✅ 截图/流均可带光标（`cursor=0\|1`）+ 点击琥珀环 |
| G7 | 技能 / 定时 | 技能、插件、定时任务 | ✅ 复用 DSH 的 **skills** + **自动化任务**（`schedule_create`，本机已有每日自检任务） |
| G8 | 应用枚举/启动 | ListApps / LaunchApp | ✅ `vdesk_apps list\|launch`（真机 200 项）+ doubao/豆包 黑名单策略 |
| G9 | **实时画面** | 低开销 IPC（per-frame PNG） | ✅ **P4 补齐**：helper `GET /stream`（MJPEG 逐字节分帧，真机 7.7fps@8fps 请求）+ monitor 8791 透传 + DSH 侧栏内嵌面板 |
| G10 | **低延迟输入通道** | 单条管道持续注入 | ✅ **P4 补齐**：`POST /input` 单请求批量（真实拖拽整段一次发）+ 原子 `drag`，不再是"每个事件一次 HTTP 往返" |
| G11 | **等画面到位** | 等图标出现 | ✅ **P4 补齐**：`vdesk_wait {stable:true}`（连续 N 帧字节相同即稳定，超时诚实失败） |

---

## 3. 架构（增量部分用 **★** 标出）

```
                       ┌─────────────────────────── DSH 宿主（session 1, 用户态）
                       │
  agent(模型) ──工具调用──▶ ★vdesk-tool（插件 host 半区）
                       │     ├─ 参数校验/归一化坐标换算
                       │     ├─ ★任务运行器(task runner)：步骤、前后截图、结果、重试
                       │     └─ ★生命周期：任务完 → 空闲计时 → stop
                       │
                       │   HTTP 127.0.0.1:8791 (monitor) ── 8780/8790(会话内 helper)
                       │                                    │
                       │        ┌───────────────────────────┘
                       │        ▼
                       │   子会话（RDP shadow）
                       │     ├─ helper：截图 / 注入键鼠 / ★剪贴板 / ★ListApps+LaunchApp
                       │     └─ 桌面应用…
                       │
  UI 侧栏「虚拟桌面」◀── 折叠菜单 + ★步骤面板（当前任务/最近任务）
```

### 3.1 ★GAC 式工具面（对标豆包 16 条命令）

工具的**输入输出**必须稳定、可组合，坐标一律"归一化优先"：

| 工具 | 参数 | 返回 |
|---|---|---|
| `vdesk_status` | — | `{running, sessionId, size, uptime, windowed}` |
| `vdesk_start` / `vdesk_stop` / `vdesk_restart` | `minutes?` | 同上 |
| `vdesk_screenshot` | `x?,y?,w?,h?, format=png\|jpg, scale?, quality?, cursor?` | 图片（jpeg/png）+ 尺寸元数据 |
| `vdesk_click` | `x,y`（0..1 或 px）、`button?, count?, hold?` | 操作后截图（可关） |
| `vdesk_move` / `vdesk_drag` / `vdesk_scroll` | 归一化坐标 | 同上 |
| `vdesk_type` | `text`（支持中文，走剪贴板+粘贴） | 同上 |
| `vdesk_key` | `keys`（如 `ctrl+s`、`alt+tab`）、`down/up` | 同上 |
| `vdesk_clipboard` | `action=get\|set`, `text?` | 文本 |
| `vdesk_apps` | `action=list\|launch`, `name?` | 应用列表 / 启动结果 |
| `vdesk_wait` | `ms` 或 `until`（画面变化阈值） | 是否满足 |
| `vdesk_window` | `on\|off` | 原生 RDP 窗口开/关 |
| `vdesk_task` | `goal, steps?` | 任务 id（步骤由 runner 记账） |

**关键设计点**
1. **默认返回"操作后截图"**（可关）：模型每步都能看到结果，少一轮猜测——这是豆包"步骤可见"的底层价值。
2. **归一化坐标**：`x,y ∈ [0,1]` 直接乘当前分辨率；同时兼容像素写法（>1 视为像素）。
3. **中文输入**：helper 的 `/key` 走 Win32 `SendInput` 逐字，中文会掉字；改为 **剪贴板 + Ctrl+V**，输入完成后**恢复宿主剪贴板**。
4. **等待策略**：`vdesk_wait` 支持"画面稳定"（连续两帧差异 < 阈值）而不只是固定 ms——豆包的"等图标出现"就是这类。

### 3.2 ★剪贴板通道（宿主 ↔ 子会话）

- 会话内：helper 增加 `/clipboard?action=get|set&text=`（`OpenClipboard/Get-Clipboard/Set-ClipboardData`）。
- 宿主：工具 `vdesk_clipboard` 直连 helper；`vdesk_type` 内部用它做中文。
- 注意：**子会话与宿主是不同会话，但同一个用户**，剪贴板是**按会话隔离的**（这正是需要通道的原因）。

### 3.3 ★任务运行器（对标"任务模式 + 步骤清单"）

```
vdesk_task(goal) → task_id
   ├─ 步骤 = 一次工具调用 + 前/后截图 + 结果（ok/timeout/err）
   ├─ 每步落盘：out\tasks\<task_id>.jsonl（+ 首末截图；中间图按需保留，默认只留失败那步）
   ├─ UI：侧栏折叠菜单里显示"当前任务 · 第 n/m 步 · 状态"，点开是步骤列表
   └─ 结束：写 summary（成功/失败/耗时/截图索引）
```

**为什么要有它**：用户真正要的不是"一个能点鼠标的桌面"，而是**"我看得见它在干什么、失败了能追"**。豆包的产品化差异就在这层。

### 3.4 ★生命周期

| 事件 | 动作 |
|---|---|
| `vdesk_task` 结束 | 默认 **stop**（自动销毁，对齐豆包） |
| 无任务且空闲 > N 分钟（默认 10） | stop |
| 用户手动"保活"（面板开关） | 抑制上面两条 |
| `start` 时检测到**外来子会话** | **拒绝**（现有安全阀，保留） |
| 长任务 | `minutes` 上限（现在 240）只作为兜底 |

---

## 4. 与 DSH 的整合方式

- **工具注册**：插件 host 半区注册工具（参考 `@deepseek-ai/dsh-tool-subagent` 的做法；**待核实**具体 API，见 §7）。
- **UI**：沿用现有 `sidebar.panellist` 折叠菜单；步骤面板放进折叠区的展开内容（不再新增单例插槽——`sidebar.workspaces`/`settings` 是 single，注册会顶掉原插件，这是踩过的坑）。
- **技能/定时**：能力封装成 skill（`skills/`），周期任务用 `schedule_create`。
- **权限**：沿用当前"完全权限"策略；工具描述里写清"会占用唯一子会话名额"。

---

## 5. 分期（可独立验收）

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **P0** | 工具面 + 归一化坐标 + 剪贴板 + 中文输入 + PNG 选项 | 半天 | 写一段"打开记事本、输入中文、截图回传"，一次通过 |
| **P1** | 任务运行器 + 步骤面板 + 自动销毁/空闲回收 | 1 天 | 面板能看到步骤与失败原因；任务结束会话自动消失 |
| **P2** | ListApps/LaunchApp + 等待画面稳定 + 失败重试 + 截图索引 | 1 天 | 豆包那个"双击加速器、等装好"的场景可复现 |
| **P3** | 打包成正式 skill + 定时自检 + 文档 | 半天 | 一句自然语言触发整套流程 |

**P0 之前的必做（30 分钟）**：把 `tools/vdesk-childsession` 里散落的临时产物清理干净，`vdesk.ps1 start` 增加 `-AutoDestroy` 与 `-IdleMinutes` 参数（为 P1 铺路）。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 与豆包抢**唯一子会话** | 双方都失败，甚至注销对方会话（**已真实发生过一次**） | 强互斥：`start` 检测外来会话即拒绝；交付文档写明"用豆包前先 `vdesk.ps1 stop`" |
| 本地 HTTP **无鉴权** | 同机任意进程可操作桌面 | 加一次性 token（helper/monitor 启动时生成，写 `out\token`），工具与之共享 |
| 中文/SendInput 掉字 | 输入不可靠 | 剪贴板+粘贴（P0） |
| 截图通道吃 CPU | 影响延迟 | 默认 JPEG+scale；PNG 只在"需要保真看文字"时用 |
| 密码明文落盘 | 安全事故 | 现状走 DPAPI/凭据管理器；工具面**永不回传**密码 |
| 单会话上限 | 不能并行多任务 | 产品层排队（一个任务队列），并明确告知用户 |

---

## 7. 待核实（动手前必须先确认）

1. **DSH 插件注册工具的 API**：读 `@deepseek-ai/dsh-tool-subagent` 的 host 半区，确认 `ctx.tools.register(...)` 的确切签名与 schema 格式。
2. 工具返回值里**图片**怎么表达（`type: image` 的 content block？路径？），这决定截图怎么回给模型。
3. helper 的 `/screenshot` 在 1920×1080、PNG、scale=1 下单帧耗时/体积（决定"每步都带截图"是否可行）。
4. 会话**注销 vs 断开**的取舍：断开可被下一步接管（我们已用到），注销释放更干净；自动销毁场景下用注销还是断开，实测选择。

---

## 8. 一句话总结

**不要重写，只补三件**：① 把现有 HTTP 通道封装成**带归一化坐标 + 剪贴板 + 每步截图**的 DSH 工具面（=我们的 GAC）；② 加**任务运行器与步骤面板**（=豆包的产品化外壳）；③ 加**生命周期**（任务完自动销毁、空闲回收、与豆包强互斥）。这三件做完，体验就与豆包同一层次，而底层延迟与可编程性仍是我们的优势。

---

## 9. P4 收口（2026-10-02）

三件（G1–G8）在 P0~P3 已落地；本轮补掉最后三条观感/工程欠账：

| 欠账 | 交付 | 真机证据 |
|---|---|---|
| **G9 实时画面** | helper `GET /stream`（MJPEG，`boundary=dshframe`，逐字节分帧、fps 节流、断连即释放）+ monitor 8791 原样透传（token+证书钉扎）+ DSH 侧栏内嵌面板 | 25 帧 / 3.25 s ≈ **7.7 fps**（请求 8），平均 65.9 KB/帧，25/25 帧 JPEG+Content-Length 自洽；面板逐字 URL 1.6 s 收 16 帧 |
| **G10 低延迟输入** | helper `POST/GET /input`（9 类事件、单请求按序执行）+ monitor 转发（Origin 白名单 + 接管锁） | 4 事件批量 `count=4`；面板拖拽载荷 `count=4`；非白名单 Origin **403** |
| **G11 等画面到位** | `vdesk_wait {stable:true,…}`（连续 N 帧字节相同即稳定） | 真机 `stable:true attempts=4 lastDiffBytes=0` |
| 附带 | `vdesk_clipboard`（第 18 个工具）、`vdesk_key action:down\|up`、`vdesk.ps1 helper`（只热替换会话内 helper，不拆会话不抢名额） | 剪贴板 set→get 往返一致；shift down/up `count=1`；ctrl+shift down 诚实拒绝 |

**验收总账**：真机整链 `accept-p4.mjs` **18/18**；mock/纯函数 **18 套全 fail=0**（含 helper `--selftest` ok=43）；生成器逐字节可复现；`p3c-monitor` 原件在不受限会话复跑 ok=20。
细节与遗留见 `P4-SUMMARY.md`（生效需：刷新页面 → 面板；完整重启 DSH → 三个新工具进工具表）。
