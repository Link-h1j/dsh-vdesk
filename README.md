# dsh-vdesk — DSH 的子会话虚拟桌面

把「只能靠 GUI 操作」的程序（比如豆包桌面端）关进一个**独立的 Windows 子会话**里，让 Agent 用截图 / 鼠标 / 键盘 / 剪贴板去操作它，而**不碰你自己的桌面**。

> 导出自本地工作区（2026-11-14）。未包含 `out/` 下的实验产物（截图、录屏帧、会话日志）和编译好的 `helper/dsh-vdesk-helper.exe`；helper 用 `make-helper.ps1` 重新编译。

---

## 它解决什么问题

- 普通自动化（UI Automation / SendInput）操作的是**你自己的会话**：抢焦点、抢鼠标、随时可能干扰你在做的事。
- 这里另开一个子会话（RDP 影子会话），程序在那边跑、画面从那边截，输入注入到那边。你的前台窗口不动。
- 代价是「彻底隔离」做不到（子会话仍属于当前用户，机器级单例程序会在两遍各起一份），见 [KNOWN-LIMITS.md](KNOWN-LIMITS.md)。

## 架构

```
vdesk.ps1  ──启动/管理──▶  keeper.ps1（持有子会话，默认 30 分钟）─┐
   │                                                             │
   └─ probe/status/shot/click/key/helper/window                  │
                                                                 ▼
                     helper/dsh-vdesk-helper.exe  （子会话内，C#，127.0.0.1:8790）
                        GET /health /screenshot /apps /clipboard
                        GET /stream   （MJPEG 实时流）
                        POST /input   （move/down/up/click/drag/scroll/key/combo/text）
                        每个路由都要 X-VDesk-Token（token 文件在子会话 out\token）
                                                                 │
                     vdesk-monitor.mjs（宿主侧，127.0.0.1:8791）    │
                        /stream 钉扎+透传、/input 加 Origin 白名单与接管锁
                                                                 │
                     vdesk-cli.mjs  /  plugin/dsh-vdesk（DSH 右侧栏面板 + vdesk_* 工具）
```

## 目录

| 路径 | 是什么 |
| --- | --- |
| `vdesk.ps1` | 生命周期管理：`start / probe / status / shot / click / key / stop / helper / window / resolution` |
| `keeper.ps1` | 子会话保活进程（持有 RDP 会话、守护 helper） |
| `helper/dsh-vdesk-helper.cs` | 子会话内的 HTTP helper（截图 / 输入 / 剪贴板 / MJPEG 流），含 `--selftest` |
| `vdesk-monitor.mjs` | 宿主侧监视器：`/stream` 透传、`/input` Origin 白名单 + 接管锁，生成器 `make-vdesk-monitor.mjs` 是唯一真源 |
| `vdesk-cli.mjs` | 命令行客户端（截图 / 输入 / 剪贴板 / 等稳定 / 分辨率） |
| `plugin/dsh-vdesk/` | DSH 插件：右侧栏直播面板 + `vdesk_*` 工具（`index.js` 宿主半区、`client.js` 浏览器半区） |
| `selftests/` | 18 套自检（mock / 纯函数） |
| `accept-p4.mjs` | 真机整链验收台（18 项） |

## 快速开始

```powershell
# 只读：看看现在有没有冲突的单例程序（不会启动任何东西）
.\vdesk.ps1 probe

# 启动子会话（30 分钟），有单例冲突时默认拒绝；-Force 强制并打印警告
.\vdesk.ps1 start -Minutes 30

.\vdesk.ps1 status
.\vdesk.ps1 shot out.png
.\vdesk.ps1 click 640 400
.\vdesk.ps1 stop
```

helper 需要先编译：`.\make-helper.ps1`（产物 `helper/dsh-vdesk-helper.exe`，本仓库未收录）。

## 安全模型

- **token**：helper 除 `GET /health` 外所有路由都要求 `X-VDesk-Token`，token 只写在子会话内部路径。
- **Origin 白名单**：monitor 的写路由（`/input`）对非白名单 Origin 返回 403，并受接管锁约束。
- **不杀你的进程、不改系统**：不碰任务计划 / Run 键 / 服务 / 账户；冲突时默认拒绝启动，把决定权交给人（见 KNOWN-LIMITS）。
- **单例冲突探测**：`out/singleton-watchlist.txt` 每行一个进程名；文件存在但为空 = 显式关闭探测。

## 文档

- [KNOWN-LIMITS.md](KNOWN-LIMITS.md) — 为什么「彻底隔离」做不到，以及三种选择
- [STARTUP-ISOLATION.md](STARTUP-ISOLATION.md) — 自启项隔离的实测过程（P3-B）
- [ISOLATION-TESTS.md](ISOLATION-TESTS.md) — 隔离性测试
- [DIAG-native-window-input.md](DIAG-native-window-input.md) — 原生窗口输入诊断
- [DESIGN-doubao-style-vdesk.md](DESIGN-doubao-style-vdesk.md) — 设计（对标豆包虚拟桌面）
- [P0-TOOLS.md](P0-TOOLS.md) / [P4-TOOLS.md](P4-TOOLS.md) — 工具面
- [P4-SUMMARY.md](P4-SUMMARY.md) — 实时流 / 内嵌面板 / 剪贴板 / down-up / 等稳定的验收记录
- [RESULTS.md](RESULTS.md) — 阶段性结果汇总
