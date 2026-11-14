# P3-B 启动项隔离 —— 实现 + 真机验收（2026-10-02 12:04，会话 34）

## 做了什么
`vdesk.ps1 start` 在**启动 keeper 之前**把 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
整体改名为 `Startup.vdesk-held`，`stop` 恢复；`start/stop/status` 三处自愈（有 held 但无我们的会话 → 立刻恢复），
marker `out\startup-held.json`（original/held/pid/heldAt）；会话建立后按会话号实测五个单例型进程名并写
`out\startup-guard.json`（`/vdesk/status` 的 `guest` 字段）+ 响铃告警。**只改文件夹名字**：没动 Run 键/服务/账户，没杀任何进程。

## 真机原始输出（关键行）
```
[pre]  Startup=True  Startup.vdesk-held=False  child rows(#)=0
[t+12s] Startup=False Startup.vdesk-held=True
        marker {"original":"...\\Programs\\Startup","pid":43184,"held":"...\\Programs\\Startup.vdesk-held","heldAt":"2026-10-02T12:04:22"}
[start] 启动项隔离：已把 Startup 改名为 Startup.vdesk-held（子会话不会启动用户个人启动项）
        子会话已建立: id=34
[guard] !!! 启动项隔离未生效：子会话里仍发现单例型进程 —— 可能有 Run 键/服务级自启（未杀任何进程，只记录）
          - DesktopMgr64.exe(pid 40952) / DesktopAITaskCenter.exe(pid 40136) / QQPCExternal.exe(pid 14360/37816/40112/29140)
        status.guest = {"hermetic":false,"held":true,"childId":34,"found":[上面 6 条]}
[stop]  启动项已恢复：Startup.vdesk-held -> Startup（stop）   stop-exit=0
[post]  Startup=True  Startup.vdesk-held=False  marker=False  child rows(#)=0  Startup 内 3 个条目完好
```

## 结论（重要，不是"通过"）
1. **文件夹隔离机制本身正确**：start 前就持有（t+12s 已 held）、stop 后恢复、自愈与 marker 都对；`selftest-p3b-startup.ps1` 44/0 覆盖 hold/restore/幂等/自愈/双存在不覆盖/stale marker/告警 JSON。
2. **但对腾讯套件无效**：子会话 34 里照样起了 6 个进程 ⇒ 启动器不是启动文件夹。只读取证：`HKCU\...\Run`（ctfmon / LGHUB / Tabbit updater）、`HKLM\...\Run`（SecurityHealth / RtkAudUService）、**计划任务 `DeskGo`（MSFT_TaskLogonTrigger → `D:\Program Files (x86)\Tencent\DeskGo\...\DesktopMgr64.exe /StartFrom=AutoRun`）**、`\ASUS\ledcontrolservice3_sdk`。这解释了子会话里同时出现的 lghub_*/ledcontrolservice3/CrossDeviceService —— **凡是"每个登录会话都起一份"的 Run 键与 Logon 计划任务，启动文件夹改名都拦不住**。
3. **真机侧确实被牵动**：会话 1 的腾讯进程 PID 全部换了一轮（前 `DesktopMgr64=22516 / DesktopAITaskCenter=38416 / QQPCExternal=6812,15120,25208,50388` → 后 `29108 / 35844 / 20584,44156,46668,47312`，数量 2+4 不变）。即"双崩→自修复"的老现象在本次依然发生，只是套件自愈回原样。
4. **红线遵守**：发现后**先记录再停**，没杀任何腾讯进程，没改 Run 键/任务/服务/账户；收尾 `stop` + `Test-Path` 回读证明启动文件夹已还原（见上）。
5. **下一步（超出本任务红线，交 Lead 决策）**：要真正隔离，需在会话生命周期内临时禁用/定向屏蔽 `DeskGo` 这类 **Logon 触发的计划任务** 与 **HKCU/HKLM Run 键**（或改成只在会话 1 启动），而不是只动启动文件夹；本任务刻意未做。
