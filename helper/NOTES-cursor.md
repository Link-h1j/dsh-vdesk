# helper 虚拟光标 + rect（P0.5-C）

- **为什么要有它**：屏幕抓取（BitBlt/CopyFromScreen）**不含指针**，所以截图里看不出"现在指哪儿、刚点了哪儿"。豆包的做法（其日志 `has_virtual_cursor_path=true`）就是**把指针自己画进帧里**；本 helper 照做，且注入只发生在子会话内，真机指针不受影响（隔离证据见末节）。
- **改动（`helper\dsh-vdesk-helper.cs`）**
  - 记录最近一次 `/mouse` 注入坐标（`RecordPointer`；`drag` 记终点 `x2,y2`）；`/screenshot` 按 `cursor=0|1`（**默认 1**）把箭头画进帧，画法沿用本项目既有实现（`dsh-screen-capture-desktop/lib/recorder.py` 的 `CURSOR_SHAPE`：12×19 黑箭头 + 2px 白描边）。`cursor=0` = **完全无叠加**（箭头与点击圈都不画），便于 A/B 对比排障。
  - click/dblclick 另记时间戳（`RecordClick`），之后 `ring` 毫秒内（**默认 900**，`ring=0` 关闭）画**琥珀/橙红双圈**（外圈 `#FF7A1A` 44px、内圈 `#FFB020` 30px），标示"刚点了哪里"。
  - `/health` 增 `"pointer":{"x":N,"y":N}`（未注入过为 `null`）。
  - **修 bug**：`/screenshot` 原来**忽略 `rect`**（task-7 实测 `shot --rect` 无效）。现在 `rect=x,y,w,h` 先按桌面像素裁剪（自动夹进虚拟屏幕）再按 `scale` 缩放；叠加层坐标同步换算（`px - src.X`）。叠加层在缩放**之前**画，随帧同比缩小。
- **验证（真机子会话 26，1280×800，exe 由 `vdesk.ps1 start` 从仓库同步进暂存目录后部署；脚本 `%TEMP%\dsh-vdesk-p05c\final-test.ps1` 走 8790 HTTP 面）——13/13 PASS**：
  - `/health`：注入前 `pointer:null` → `/mouse?action=move&x=400&y=300` 后 `pointer:{"x":400,"y":300}` ✅
  - 全屏 `cursor=1` vs `cursor=0`：PNG 426911 vs 426908 字节、SHA256 不同 ✅（确实画了）
  - `rect=280,180,240,240`：两图均 240×240；同刻 `cursor=1`−`cursor=0` 逐像素 = `diff=179 box=[119,118..133,139] 15×22`（白 126px / 黑 53px）——正是箭头且锚点落在预期 (120,120) ✅
  - `rect=100,100,200,150` → 200×150；同 rect + `scale=0.5` → 100×75 ✅（rect 生效、先裁后缩）
  - 点击圈：点空白任务栏 (640,794)，**抓帧在点击后 41ms**；同刻 `cursor=1`−`cursor=0` = `diff=397 box=[47,71..93,99] 47×29`，左弧最暖像素 `RGB=255,122,26`（外圈橙红）✅；**1.4s 后**同对照只剩 `8×8` 箭头尖 ✅（按默认 900ms 窗口消失）
- **自测中发现自己的一处 bug 并已修**：初版把点击圈画在 `if (drawCursor)` 之外，导致 `cursor=0` 也带圈、A/B 对照互相抵消（当时"圈不见了"）。已改成 `cursor=0` 直接 return。另：测点击圈**不要点桌面图标**（选中高亮 ~47×47 会与圈混淆），用任务栏空白区最稳。
- **输入隔离证据（必须项，已实测）**：在宿主 **session 1** 用 `GetCursorPos` 做"读宿主 → 向子会话注入 → 立刻再读"的紧密因果对照：move(300,270)/(400,290)/(500,310) + click(640,200) + 再 2 次 move，宿主指针**始终为 `22,1177` 不变（6/6）**。原理：helper 运行在子会话自身的输入桌面，`SendInput` 只作用于该会话；宿主的指针只受宿主自己的输入影响。
- **收尾**：验证用的子会话已 `vdesk.ps1 stop` 注销，`qwinsta` 无 `#` 行残留、无 helper 进程、8790 空闲；暂存目录与仓库 exe 一致（SHA256 `24718E6A…484A`，2026-10-02 10:35:31）。
- **说明**：`/mouse` 记录的是**请求坐标**（`MoveTo` 用 ABSOLUTE 归一化，四舍五入 ≤1px 偏差）；`cursor=0` 现在等价于"干净帧"，适合做差分基线。
