# vdesk.ps1 -- manager for the child-session virtual desktop (the "Doubao virtual desktop"
# mechanism, rebuilt with the system's own RDP ActiveX).
#
#   .\vdesk.ps1 start [-Minutes N] [-Width W] [-Height H] [-Force]
#                                    create + hold a child session (keeper, default 30 min).
#                                    W/H default to out\desired-resolution.json, else 1280x800.
#                                    RDP fixes the desktop size at CONNECT time, so changing it means
#                                    restarting the session (vdesk_resolution / vdesk-cli resolution).
#                                    P3-C: start REFUSES (exit 4) while a machine-wide singleton
#                                    program from out\singleton-watchlist.txt is running; -Force
#                                    overrides with a loud warning (see KNOWN-LIMITS.md).
#   .\vdesk.ps1 probe                read-only: print the singleton-conflict JSON and exit (never
#                                    starts/stops anything; used by the monitor/plugin/CLI)
#   .\vdesk.ps1 status               state of ours vs anyone else's child session
#   .\vdesk.ps1 shot out.png         screenshot (through the in-session helper)
#   .\vdesk.ps1 click 640 400        click inside it
#   .\vdesk.ps1 key 13               key by vk code (13 = Enter)
#   .\vdesk.ps1 stop                 destroy OUR child session and stop OUR helper
#   .\vdesk.ps1 helper               P4: redeploy ONLY the in-session helper into the child session we
#                                    already own -- no teardown, no logoff, no fight over the slot.
#                                    Used to accept a new helper build while the session stays up.
#   .\vdesk.ps1 window on|off        show/hide the keeper's native RDP window on THIS desktop
#                                    (default OFF; auto-hides after VDESK_WINDOW_IDLE_MIN minutes
#                                    without interaction, see keeper.ps1)
#   P3-B: start also renames the user's Startup folder to "Startup.vdesk-held" for the lifetime of the
#   session (stop restores it; start/stop/status self-heal a leftover hold) so the child session NEVER
#   launches the user's personal startup items -- the Tencent desktop-organizer singleton used to fight
#   the user's own copy there. Only the folder NAME is touched. See STARTUP-ISOLATION.md.
#
# OWNERSHIP SAFETY (added 2026-10-01 after a real incident):
#   A Windows box has exactly ONE active child session at a time, and it is visible to everyone
#   as "<listener-guid>#0" in qwinsta. Doubao's virtual desktop uses the same slot. An earlier
#   version of this script picked "the first # line in qwinsta" as its own session and could
#   therefore log off DOUBAO'S session (that actually happened at 19:54:37 and killed a session
#   the user was using). So now:
#     * our own id comes ONLY from the id our own keeper recorded in keeper.json
#     * start REFUSES to run while somebody else's child session exists (no retry storm)
#     * stop only ever logs off OUR id, and re-checks that it is really ours
#
# Depends on: the SYSTEM elevation bridge (~/.dsh/isolated-desktop/hv.ps1, starts at boot).
#
# This file must stay UTF-8 **with BOM** (Windows PowerShell 5.1 reads BOM-less .ps1 as GBK).

param(
  [Parameter(Position = 0)][string]$Action = 'status',
  [Parameter(Position = 1)][string]$Arg1 = '',
  [Parameter(Position = 2)][string]$Arg2 = '',
  [Parameter(Position = 3)][string]$Arg3 = '',
  [int]$Minutes = 30,
  # 0 = "not given" (see the start branch: desired-resolution.json fills these in)
  [int]$Width = 0,
  [int]$Height = 0,
  # P3-C: start refuses while a machine-wide singleton program is running unless this is set
  [switch]$Force
)

$ErrorActionPreference = 'Continue'
$Temp   = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession'
$Hv     = 'C:\Users\Administrator\.dsh\isolated-desktop\hv.ps1'
$Port   = 8790
$Status = Join-Path $Temp 'out\keeper.json'
$Stop   = Join-Path $Temp 'out\keeper.stop'
$WinFlag  = Join-Path $Temp 'out\keeper.window'
$WinTouch = Join-Path $Temp 'out\keeper.touch'
$DesiredRes = Join-Path $Temp 'out\desired-resolution.json'
# P3-B startup isolation (see HoldStartup / STARTUP-ISOLATION.md)
$ProfileRoot   = 'C:\Users\Administrator\AppData\Roaming'
if (-not (Test-Path $ProfileRoot)) { $ProfileRoot = $env:APPDATA }
$StartupDir    = Join-Path $ProfileRoot 'Microsoft\Windows\Start Menu\Programs\Startup'
$StartupHeld   = Join-Path $ProfileRoot 'Microsoft\Windows\Start Menu\Programs\Startup.vdesk-held'
$StartupMarker = Join-Path $Temp 'out\startup-held.json'
$GuardFile     = Join-Path $Temp 'out\startup-guard.json'
# Machine-wide singleton suites that must NOT get a second copy inside the child session. The
# Tencent desktop-organizer family is the known offender: the child copy fought the real one and the
# USER's own desktop crashed last time.
$SingletonNames = @('DesktopMgr64', 'QQPCExternal', 'QQPCTray', 'DesktopAITaskCenter', 'QQPCSoftCmd')
# P3-C conflict detect-and-yield (see KNOWN-LIMITS.md). Read-only: we never touch the other programs.
$WatchlistFile = Join-Path $Temp 'out\singleton-watchlist.txt'
$ConflictFile  = Join-Path $Temp 'out\conflict.json'

# Watchlist resolution: no file -> the built-in default; a file -> exactly what it lists (so an
# empty/comment-only file is an explicit "watch nothing" opt-out, which we say out loud).
function GetSingletonWatchlist {
  if (Test-Path $WatchlistFile) {
    $names = @()
    foreach ($line in (Get-Content $WatchlistFile -ErrorAction SilentlyContinue)) {
      $s = ([string]$line).Trim()
      if ($s -eq '' -or $s.StartsWith('#')) { continue }
      $names += [IO.Path]::GetFileNameWithoutExtension($s)
    }
    return $names
  }
  return $SingletonNames
}

# Machine-wide singleton programs currently running ANYWHERE (their copy in the user's console
# session is what the child session's copy would fight with). Read-only.
function GetSingletonConflicts {
  $names = GetSingletonWatchlist
  $hits = @()
  if ($names.Count -eq 0) { return $hits }
  try {
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
      $base = [IO.Path]::GetFileNameWithoutExtension([string]$p.Name)
      if ($names -contains $base) {
        $hits += @{ name = [string]$p.Name; pid = [int]$p.ProcessId; session = [int]$p.SessionId }
      }
    }
  } catch { }
  return $hits
}

function NewConflictObject {
  param([array]$Found, [bool]$Forced = $false, [bool]$Refused = $false)
  return @{
    ok        = -not $Refused
    checkedAt = (Get-Date).ToString('s')
    found     = @($Found)
    forced    = $Forced
    refused   = $Refused
    watchlist = @(GetSingletonWatchlist)
  }
}

function WriteConflictRecord {
  param([array]$Found, [bool]$Forced = $false, [bool]$Refused = $false)
  try {
    $obj = NewConflictObject -Found $Found -Forced $Forced -Refused $Refused
    [IO.File]::WriteAllText($ConflictFile, ($obj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function GetConflictRecord {
  try {
    if (Test-Path $ConflictFile) { return (Get-Content $ConflictFile -Raw -ErrorAction Stop | ConvertFrom-Json) }
  } catch { }
  return $null
}

# ---- P3-B: startup-folder isolation -----------------------------------------------------------
# The child session is a shadow of the SAME user, so it also runs that user's personal startup items;
# a dedicated account (Doubao's approach) is structurally impossible here -- the session is bound to
# the console user's identity. So for the lifetime of our session the whole Startup folder is renamed
# away. Only the folder NAME changes: no Run keys, no services, no accounts, no user processes.
function GetStartupState {
  return @{ dirOk = (Test-Path $StartupDir); heldOk = (Test-Path $StartupHeld); marker = (Test-Path $StartupMarker) }
}

# Self-heal: a held folder with no session of ours means a previous run died -> give it back now.
function HealStartup([string]$why) {
  $s = GetStartupState
  if ($s.heldOk -and -not $s.dirOk) {
    if ((OurChildIds).Count -eq 0) {
      try {
        Move-Item -LiteralPath $StartupHeld -Destination $StartupDir -ErrorAction Stop
        Remove-Item $StartupMarker -ErrorAction SilentlyContinue
        Write-Host ("启动项自愈：Startup.vdesk-held -> Startup（" + $why + "：没有我们的会话在跑）")
      } catch {
        Write-Host ("启动项自愈失败（" + $why + "）：" + $_.Exception.Message + " —— 请手工把 Startup.vdesk-held 改回 Startup")
      }
    }
  }
  if ($s.marker -and -not (Test-Path $StartupHeld)) { Remove-Item $StartupMarker -ErrorAction SilentlyContinue }
}

function HoldStartup {
  HealStartup 'hold'
  if (-not (Test-Path $StartupDir)) {
    Write-Host "启动项隔离：找不到 Startup 目录，跳过（若已存在 Startup.vdesk-held 见上面的自愈输出）"
    return
  }
  if (Test-Path $StartupHeld) { Write-Host "启动项隔离：Startup.vdesk-held 已存在，保持现状"; return }
  try {
    Move-Item -LiteralPath $StartupDir -Destination $StartupHeld -ErrorAction Stop
    $obj = @{ heldAt = (Get-Date).ToString('s'); pid = $PID; original = $StartupDir; held = $StartupHeld }
    try { [IO.File]::WriteAllText($StartupMarker, ($obj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch { }
    Write-Host "启动项隔离：已把 Startup 改名为 Startup.vdesk-held（子会话不会启动用户个人启动项）"
  } catch {
    Write-Host ("启动项隔离失败：" + $_.Exception.Message + " —— 子会话可能仍会启动用户启动项")
  }
}

function RestoreStartup([string]$why) {
  if (Test-Path $StartupHeld) {
    if (Test-Path $StartupDir) {
      Write-Host "启动项恢复：Startup 与 Startup.vdesk-held 同时存在，保留 Startup（不覆盖）"
    } else {
      try {
        Move-Item -LiteralPath $StartupHeld -Destination $StartupDir -ErrorAction Stop
        Write-Host ("启动项已恢复：Startup.vdesk-held -> Startup（" + $why + "）")
      } catch {
        Write-Host ("启动项恢复失败（" + $why + "）：" + $_.Exception.Message + " —— 请手工把 Startup.vdesk-held 改回 Startup")
      }
    }
  }
  Remove-Item $StartupMarker -ErrorAction SilentlyContinue
  # keep the guard record honest: the hold is over, so /vdesk/status must not still claim held:true
  try {
    if (Test-Path $GuardFile) {
      $g = Get-Content $GuardFile -Raw -ErrorAction Stop | ConvertFrom-Json
      $g.held = $false
      # NOTE: assigning a NEW property on a PSCustomObject throws -- Add-Member -Force is required
      $g | Add-Member -NotePropertyName releasedAt -NotePropertyValue (Get-Date).ToString('s') -Force
      [IO.File]::WriteAllText($GuardFile, ($g | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    }
  } catch { }
}

# Which singleton processes are running INSIDE the child session (WMI sees every session)?
function GetGuestSingletonHits([int]$cid) {
  $hits = @()
  try {
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
      if ([int]$p.SessionId -ne $cid) { continue }
      $base = [IO.Path]::GetFileNameWithoutExtension([string]$p.Name)
      if ($SingletonNames -contains $base) { $hits += ([string]$p.Name + "(pid " + $p.ProcessId + ")") }
    }
  } catch { }
  return $hits
}

# Post-start proof + alarm. Writes out\startup-guard.json (served by /vdesk/status as `guest`).
function WriteStartupGuard([int]$cid) {
  $hits = GetGuestSingletonHits $cid
  $hermetic = ($hits.Count -eq 0)
  $obj = @{
    checkedAt = (Get-Date).ToString('s')
    childId   = $cid
    hermetic  = $hermetic
    found     = @($hits)
    names     = $SingletonNames
    held      = (Test-Path $StartupHeld)
  }
  try { [IO.File]::WriteAllText($GuardFile, ($obj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch { }
  if ($hermetic) {
    Write-Host ("启动项隔离有效：子会话 " + $cid + " 里没有单例型进程（" + ($SingletonNames -join ',') + "）")
  } else {
    Write-Host "!!! 启动项隔离未生效：子会话里仍发现单例型进程 —— 可能有 Run 键/服务级自启（未杀任何进程，只记录）"
    foreach ($h in $hits) { Write-Host ("      - " + $h) }
  }
  return $hermetic
}

# RDP fixes the remote desktop size when the connection is made, so a different resolution needs a
# rebuilt session. vdesk_resolution (host tool) / `vdesk-cli.mjs resolution w h` remember the target
# here and then restart; this file is only the DEFAULT for start -- explicit -Width/-Height win.
function GetDesiredResolution {
  $r = @{ width = 1280; height = 800; found = $false }
  try {
    if (Test-Path $DesiredRes) {
      $j = Get-Content $DesiredRes -Raw -ErrorAction Stop | ConvertFrom-Json
      $w = [int]$j.width; $h = [int]$j.height
      if ($w -ge 320 -and $w -le 4096 -and $h -ge 240 -and $h -le 4096) {
        $r.width = $w; $r.height = $h; $r.found = $true
      }
    }
  } catch { }
  return $r
}

# Native-window policy B (2026-10-02 incident): the on/off switch is a FILE, so it used to survive a
# keeper restart -- a leftover keeper.window made a "子会话窗口" pop up on the user's own desktop and
# stay there. So every start/restart/stop now begins or ends with the flag GONE, and only an
# explicit `window on` (or POST /vdesk/window?on=1) creates it. Nothing can resurrect it by accident.
function ClearWindowFlag([string]$why) {
  $had = (Test-Path $WinFlag) -or (Test-Path $WinTouch)
  Remove-Item $WinFlag  -ErrorAction SilentlyContinue
  Remove-Item $WinTouch -ErrorAction SilentlyContinue
  if ($had) { Write-Host ("已清除原生窗口标志与交互时间戳（" + $why + "）：默认关闭，避免残留标志让窗口意外复活") }
}

function Bridge([string]$script) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Hv -Script $script -TimeoutSec 120 2>&1 | Out-String
}

# Every child session on the box, whoever owns it.
function AllChildIds {
  $ids = @()
  foreach ($line in ((& qwinsta 2>&1) -split "`r?`n")) {
    if ($line -match '#') {
      $m = [regex]::Match($line, '#\S*\s+\S+\s+(\d+)')
      if ($m.Success) { $ids += [int]$m.Groups[1].Value }
      else {
        $nums = [regex]::Matches($line, '\d+')
        if ($nums.Count -ge 1) { $ids += [int]$nums[0].Value }
      }
    }
  }
  return $ids
}

# Our ids = what OUR keeper recorded in keeper.json (candidates = "id:state,id:state").
function OurChildIds {
  $ids = @()
  try {
    $j = Get-Content $Status -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($j -and $j.candidates) {
      foreach ($c in ($j.candidates -split ',')) {
        $m = [regex]::Match($c, '^\s*(\d+)')
        if ($m.Success) { $ids += [int]$m.Groups[1].Value }
      }
    }
  } catch { }
  return $ids
}

function ForeignChildIds {
  $ours = OurChildIds
  return @(AllChildIds | Where-Object { $ours -notcontains $_ })
}

function HelperOk {
  try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 4; return $r.Content } catch { return $null }
}

function Stage {
  param([switch]$SkipHelper)
  # everything the launcher executes must live under an ASCII path: processes inside the child
  # session resolve paths as ANSI, and the workspace folder name (默认工作区) breaks them.
  $src = Split-Path -Parent $PSCommandPath
  foreach ($n in 'launch-in-session.ps1','helper-runner.ps1','keeper.ps1','fix-desktop.ps1') {
    $s = Join-Path $src $n
    if (Test-Path $s) { Copy-Item $s (Join-Path $Temp $n) -Force }
  }
  $hs = Join-Path $src 'helper'
  # -SkipHelper: the helper dir (its .exe is locked while a helper is running) is copied by the
  # caller with an explicit retry loop instead -- see the 'helper' action.
  if ((Test-Path $hs) -and (-not $SkipHelper)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Temp 'helper') | Out-Null
    Copy-Item (Join-Path $hs '*') (Join-Path $Temp 'helper') -Force
  }
}

switch ($Action.ToLower()) {
  'probe' {
    # P3-C read-only conflict probe. Prints ONE line of JSON (nothing else) and always exits 0 --
    # callers (the monitor, the plugin, the CLI) parse it; it can never start or stop anything.
    $hits = GetSingletonConflicts
    $obj = NewConflictObject -Found $hits
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
  }
  'start' {
    # P3-C: detect machine-wide singleton programs BEFORE doing anything at all (read-only). Their
    # copy in the user's console session is what the child session's copy fights with; that fight
    # crashed the user's own desktop twice (see KNOWN-LIMITS.md). Default = refuse and tell them.
    $conflicts = GetSingletonConflicts
    if ($conflicts.Count -gt 0 -and -not $Force) {
      WriteConflictRecord -Found $conflicts -Forced $false -Refused $true
      Write-Host "拒绝启动：检测到机器级单例程序正在运行 —— 子会话登录时会再起一份并与它们抢单例，已两次导致用户桌面双崩。"
      foreach ($c in $conflicts) { Write-Host ("    - " + $c.name + " pid=" + $c.pid + " session=" + $c.session) }
      Write-Host "  建议：先退出它们再启动；确认接受风险可加 -Force（接口 force=true / 工具 vdesk_start{force:true}）。"
      Write-Host ("CONFLICT " + ((NewConflictObject -Found $conflicts -Refused $true) | ConvertTo-Json -Compress -Depth 5))
      exit 4
    }
    if ($conflicts.Count -gt 0) {
      WriteConflictRecord -Found $conflicts -Forced $true -Refused $false
      $warn = "!!! FORCE：无视单例冲突继续启动（" + $conflicts.Count + " 个白名单程序在跑）—— 可能再次导致用户桌面双崩！"
      Write-Host $warn
      Write-Host ("    " + (($conflicts | ForEach-Object { $_.name + "(pid " + $_.pid + ", sess " + $_.session + ")" }) -join ', '))
      [Console]::Error.WriteLine($warn)
    } else {
      WriteConflictRecord -Found @() -Forced $false -Refused $false
    }
    Stage
    Write-Host "已同步脚本到暂存目录 $Temp"

    $ours = OurChildIds
    if ($ours.Count -gt 0) {
      Write-Host ("我们已经在运行（子会话 " + ($ours -join ',') + "）。要重建请先 stop。")
      exit 0
    }
    $foreign = ForeignChildIds
    if ($foreign.Count -gt 0) {
      Write-Host ("拒绝启动：系统此刻已有别人在使用子会话（id " + ($foreign -join ',') + "，多半是豆包的虚拟桌面）。")
      Write-Host "Windows 同一时刻只允许一个 Active 子会话 —— 我们不该抢占，也不该把它注销。"
      Write-Host "请等对方用完（或在设置里关掉它的虚拟桌面）后再 start。"
      exit 3
    }

    Remove-Item $Stop -ErrorAction SilentlyContinue
    Remove-Item $Status -ErrorAction SilentlyContinue
    # before the keeper exists: a flag from a previous run must never bring the window back
    ClearWindowFlag 'start 前重置'
    # P3-B: hold the user's Startup folder BEFORE the session logs on (we reach this line only when
    # no session of ours is running), so the child session never launches the personal startup items
    HoldStartup
    # resolution: explicit -Width/-Height win, else the remembered target, else 1280x800
    $explicitRes = ($Width -gt 0) -or ($Height -gt 0)
    $dr = GetDesiredResolution
    if ($Width  -le 0) { $Width  = $dr.width }
    if ($Height -le 0) { $Height = $dr.height }
    Write-Host ("分辨率 " + $Width + "x" + $Height + $(if ($explicitRes) { "（命令行指定）" } elseif ($dr.found) { "（来自 desired-resolution.json）" } else { "（默认）" }))
    $ws = @"
& 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\keeper.ps1' -MaxSeconds $($Minutes * 60) -Width $Width -Height $Height
"@
    [IO.File]::WriteAllText((Join-Path $Temp 'w-keeper.ps1'), $ws, (New-Object Text.UTF8Encoding($false)))
    Write-Host "启动 keeper（$Minutes 分钟保活）..."
    $r = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId 1 -Target '" + $Temp + "\w-keeper.ps1' -WorkDir '" + $Temp + "'")
    Write-Host $r.Trim()

    $cid = 0
    for ($i = 0; $i -lt 24; $i++) {
      Start-Sleep -Seconds 5
      $ours = OurChildIds
      if ($ours.Count -gt 0) { $cid = $ours[0]; break }
    }
    if ($cid -eq 0) { Write-Host "失败：120 秒内没看到属于我们的子会话（keeper.json 里没有记录）"; exit 1 }
    Write-Host ("子会话已建立: id=" + $cid + "  -> 送 helper 进去")
    $r2 = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId " + $cid + " -Target '" + $Temp + "\helper-runner.ps1' -WorkDir '" + $Temp + "'")
    Write-Host $r2.Trim()
    for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 2; if (HelperOk) { break } }
    $h = HelperOk
    if ($h) { Write-Host ("helper 就绪: " + $h) } else { Write-Host "helper 还没响应（子会话可能是 Disc 状态）" }
    Write-Host "修一次桌面（子会话里第一个 explorer 起太早，桌面图标不会填充）..."
    $null = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId " + $cid + " -Target '" + $Temp + "\fix-desktop.ps1' -WorkDir '" + $Temp + "'")
    Start-Sleep -Seconds 12
    Write-Host "清一下子会话里启动项弹出的终端窗口（隐藏，不杀进程）..."
    $null = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId " + $cid + " -Target '" + $Temp + "\tidy-session.ps1' -WorkDir '" + $Temp + "'")
    Start-Sleep -Seconds 18
    # P3-B proof: no singleton suite may have started inside the child session
    $null = WriteStartupGuard $cid
    Write-Host ("state : " + ((& qwinsta 2>&1 | Select-String '#') -join ' | '))
  }
  'helper' {
    # P4: refresh ONLY the helper that runs INSIDE the child session we already own. No session
    # teardown, no keeper restart, no re-creation of the child session -- so this never touches the
    # machine-wide single child-session slot and never disturbs Doubao. Used to accept a new build.
    # The kill step runs INSIDE the child session and filters by that session's own id, so it can
    # only ever stop a helper belonging to OUR session.
    $ours = OurChildIds
    if ($ours.Count -eq 0) {
      Write-Host "没有属于我们的子会话（keeper.json 里没有记录）→ 先用 vdesk.ps1 start 建一个"
      exit 1
    }
    $cid = $ours[0]
    Write-Host ("目标子会话: id=" + $cid + "  -> 先停掉会话内的旧 helper（它锁着执行区里的 exe，必须先停再同步）")
    $kill = @'
$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$n = 0
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='dsh-vdesk-helper.exe'" -ErrorAction SilentlyContinue)) {
  if ([int]$p.SessionId -eq $sid) { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue; $n++ }
}
$deadline = (Get-Date).AddSeconds(15)
$left = @()
while ((Get-Date) -lt $deadline) {
  $left = @(Get-CimInstance Win32_Process -Filter "Name='dsh-vdesk-helper.exe'" -ErrorAction SilentlyContinue | Where-Object { [int]$_.SessionId -eq $sid })
  if ($left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
}
Write-Output ("killed=" + $n + " left=" + $left.Count + " session=" + $sid)
'@
    [IO.File]::WriteAllText((Join-Path $Temp 'w-helper-kill.ps1'), $kill, (New-Object Text.UTF8Encoding($false)))
    $rk = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId " + $cid + " -Target '" + $Temp + "\w-helper-kill.ps1' -WorkDir '" + $Temp + "'")
    Write-Host $rk.Trim()
    # Bridge 是异步返回的：kill 脚本还在子会话里跑，执行区里的 exe 可能仍被旧 helper 锁着。
    # 所以这里对「复制 helper（含 exe）」显式重试，直到真正成功为止（而不是撞一次就放过）。
    Write-Host "同步脚本到执行区..."
    Stage -SkipHelper
    $hs = Join-Path (Split-Path -Parent $PSCommandPath) 'helper'
    $hd = Join-Path $Temp 'helper'
    $copied = $false
    $tries = 0
    for ($i = 0; $i -lt 60; $i++) {
      $tries = $i + 1
      try { Copy-Item (Join-Path $hs '*') $hd -Force -ErrorAction Stop; $copied = $true; break } catch { Start-Sleep -Milliseconds 500 }
    }
    if ($copied) {
      Write-Host ("helper 同步: 成功（第 " + $tries + " 次尝试）")
    } else {
      Write-Host "helper 同步: 失败（执行区 exe 一直被占用）—— 本次会用旧构建启动"
    }
    # 证明新构建真的落地：暂存 exe 必须与工作区 exe 一致
    $wsExe = Join-Path (Split-Path -Parent $PSCommandPath) 'helper\dsh-vdesk-helper.exe'
    $stExe = Join-Path $Temp 'helper\dsh-vdesk-helper.exe'
    if ((Test-Path $wsExe) -and (Test-Path $stExe)) {
      $a = Get-Item $wsExe
      $b = Get-Item $stExe
      Write-Host ("workspace exe : " + $a.Length + "B " + $a.LastWriteTime.ToString('s'))
      Write-Host ("staged    exe : " + $b.Length + "B " + $b.LastWriteTime.ToString('s'))
      if (($a.Length -ne $b.Length) -or ($a.LastWriteTime.ToString('s') -ne $b.LastWriteTime.ToString('s'))) {
        Write-Host "警告：暂存 exe 与工作区 exe 不一致 —— 新构建没落到执行区"
      }
    }
    Write-Host "启动新 helper..."
    $r2 = Bridge ("& '" + $Temp + "\launch-in-session.ps1' -SessionId " + $cid + " -Target '" + $Temp + "\helper-runner.ps1' -WorkDir '" + $Temp + "'")
    Write-Host $r2.Trim()
    for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 2; if (HelperOk) { break } }
    $h = HelperOk
    if ($h) {
      Write-Host ("helper 就绪: " + $h)
      Write-Host ("state : " + ((& qwinsta 2>&1 | Select-String '#') -join ' | '))
    } else {
      Write-Host "helper 没起来（8790 无响应）—— 看 $Temp\out\helper-runner.log"
      exit 1
    }
  }
  'window' {
    # Toggle the keeper's REAL RDP window (native, not the browser panel): the form that hosts the
    # RDP ActiveX control moves on screen and becomes opaque, so the child session shows up as an
    # ordinary window rendered by the RDP protocol itself -- and it accepts the user's own input.
    if ($Arg1 -eq 'off') {
      ClearWindowFlag 'window off'
      Write-Host "已请求关闭原生窗口"
    } else {
      New-Item -ItemType File -Force -Path $WinFlag | Out-Null
      # seed the interaction clock so the idle timer starts from "just opened"
      try { [IO.File]::WriteAllText($WinTouch, (Get-Date).ToString('s')) } catch { }
      $idleMin = if ($env:VDESK_WINDOW_IDLE_MIN) { $env:VDESK_WINDOW_IDLE_MIN } else { 10 }
      Write-Host ("已请求打开原生窗口（真实 RDP 窗口，不是网页）；" + $idleMin + " 分钟无交互会自动关闭")
    }
  }
  'restart' {
    Write-Host "重启：先停再起 ..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath stop 2>&1 | Out-String | Write-Host
    Start-Sleep -Seconds 3
    if ($Force) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath start -Minutes $Minutes -Force 2>&1 | Out-String | Write-Host
    } else {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath start -Minutes $Minutes 2>&1 | Out-String | Write-Host
    }
  }
  'status' {
    HealStartup 'status'
    $ours = OurChildIds; $foreign = ForeignChildIds
    Write-Host ("ours    : " + $(if ($ours.Count) { $ours -join ',' } else { '(none)' }))
    Write-Host ("others  : " + $(if ($foreign.Count) { ($foreign -join ',') + '  <- 别人在用同一个名额' } else { '(none)' }))
    Write-Host ("keeper  : " + (Get-Content $Status -Raw -ErrorAction SilentlyContinue))
    Write-Host ("helper  : " + $(if (HelperOk) { HelperOk } else { 'no response' }))
    $live = GetSingletonConflicts
    $rec = GetConflictRecord
    $wl = GetSingletonWatchlist
    Write-Host ("watch   : " + $(if ($wl.Count) { $wl -join ',' } else { '(空：已关闭冲突探测)' }) + "  [文件 " + $WatchlistFile + "]")
    Write-Host ("conflict: " + $(if ($live.Count) { '命中 ' + $live.Count + ' 个：' + (($live | ForEach-Object { $_.name + '(pid ' + $_.pid + ', sess ' + $_.session + ')' }) -join ', ') } else { '无' }) + $(if ($rec) { '   [上次启动 forced=' + $rec.forced + ' refused=' + $rec.refused + ' @' + $rec.checkedAt + ']' } else { '' }))
    $stDir = Test-Path $StartupDir; $stHeld = Test-Path $StartupHeld
    Write-Host ("startup : " + $(if ($stHeld -and -not $stDir) { '持有中（Startup.vdesk-held）' } elseif ($stDir -and -not $stHeld) { '正常（Startup）' } else { '异常：Startup 与 Startup.vdesk-held 状态同时成立或都不存在！' }))
    Write-Host ("guard   : " + $(if (Test-Path $GuardFile) { (Get-Content $GuardFile -Raw -ErrorAction SilentlyContinue) } else { '(还没有启动后自检记录)' }))
    Write-Host ((& qwinsta 2>&1 | Out-String).Trim())
  }
  'shot' {
    $out = if ($Arg1) { $Arg1 } else { Join-Path $Temp 'out\vdesk-shot.png' }
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/screenshot" -OutFile $out -TimeoutSec 20
    Write-Host ("saved " + $out + " (" + (Get-Item $out).Length + "B)")
  }
  'click' {
    $u = "http://127.0.0.1:$Port/mouse?action=click&x=$Arg1&y=$Arg2" + $(if ($Arg3) { "&button=$Arg3" })
    (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20).Content
  }
  'move' {
    (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/mouse?action=move&x=$Arg1&y=$Arg2" -UseBasicParsing -TimeoutSec 20).Content
  }
  'key' {
    (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/key?action=tap&vk=$Arg1" -UseBasicParsing -TimeoutSec 20).Content
  }
  'stop' {
    # close the native window first: the keeper hides it as soon as the flag disappears
    ClearWindowFlag 'stop'
    # P3-B: give the user's Startup folder back before anything else can fail
    RestoreStartup 'stop'
    $ours = OurChildIds
    if ($ours.Count -eq 0) {
      Write-Host "我们没有在跑的子会话（不会去动别人的）。"
    } else {
      Write-Host "写停止文件，让 keeper 自己退出 ..."
      New-Item -ItemType File -Force -Path $Stop | Out-Null
      foreach ($cid in $ours) {
        # re-verify right before the destructive step: it must still be a child session
        if ((AllChildIds) -contains $cid) {
          Write-Host ("注销我们的子会话 " + $cid + " 并停掉我们的 helper ...")
          Bridge ("Stop-Process -Name 'dsh-vdesk-helper' -Force -ErrorAction SilentlyContinue; & logoff " + $cid + " 2>&1 | Out-Null; Start-Sleep -Seconds 2; 'ok'") | Out-Null
        }
      }
      Start-Sleep -Seconds 3
      Remove-Item $Stop -ErrorAction SilentlyContinue
    }
    Write-Host ((& qwinsta 2>&1 | Out-String).Trim())
  }
  default { Write-Host "用法: vdesk.ps1 start [-Minutes N] [-Force] | probe | status | shot | click | move | key | stop" }
}
