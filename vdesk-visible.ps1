# vdesk-visible.ps1 —— 确保「DSH 虚拟桌面」（子会话）对用户可见：监控服务在跑 + 可视化窗口已打开
#
# 和 tools/vm-visible.ps1 同一个道理：只把画面投进对话，用户看不见过程、无法验收。
# 本脚本保证 127.0.0.1:8791 上的实时窗口（可直接在里面操作子会话）处于打开状态。
#
# 幂等：服务已在跑就不重启；窗口已存在就不重复开。
# -NoWindow：只保证本地面板服务在跑，不开浏览器窗口。DSH 插件的 Host 半区用这个开关调用，
#            这样激活插件不会平白弹出一个窗口；要看画面从卡片上点「面板」。
# 本文件必须存成 UTF-8 带 BOM（Windows PowerShell 5.1 会按 GBK 读无 BOM 的 .ps1）。

param([switch]$NoWindow)

$ErrorActionPreference = 'Stop'
$Port    = 8791
$Monitor = 'C:\Users\Administrator\Documents\deepseek-harness\默认工作区\tools\vdesk-childsession\vdesk-monitor.mjs'
$Node    = 'C:\Users\Administrator\AppData\Local\Programs\node\node.exe'
$Vbs     = 'C:\Users\Administrator\.dsh\open-vdesk.vbs'

# 1. 监控服务
$listening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
if (-not $listening) {
  Write-Output "监控服务未在 $Port，正在启动 ..."
  # 用 VBS + 窗口样式 0 启动：node 的控制台窗口被隐藏，任务栏里不会出现"终端"。
  # （WMI Create 直接起 node.exe 会给它一个可见控制台；Win11 默认把控制台挂在 Windows Terminal 里，
  #   于是任务栏多出一个终端窗口。wscript 是 GUI 进程，不会自带控制台。）
  # 路径里有中文（工作区名），而 VBS 用 ASCII 写会把中文变成 ?，所以先把服务脚本复制到纯英文暂存
  # 目录，再用 UTF-16 写 VBS（WScript 认 UTF-16 BOM），窗口样式 0 = 隐藏控制台。
  $tmpDir = Join-Path $env:LOCALAPPDATA 'Temp\dsh-childsession'
  if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
  $monitorAscii = Join-Path $tmpDir 'vdesk-monitor.mjs'
  Copy-Item $Monitor $monitorAscii -Force
  $vbs = Join-Path $tmpDir 'start-monitor-hidden.vbs'
  $vbsBody = 'Set s = CreateObject("WScript.Shell")' + "`r`n" + 's.Run """' + $Node + '"" ""' + $monitorAscii + '""", 0, False' + "`r`n"
  [IO.File]::WriteAllText($vbs, $vbsBody, (New-Object System.Text.UnicodeEncoding($false, $true)))
  $cmd = 'wscript.exe "' + $vbs + '"'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  if ($r.ReturnValue -ne 0) { throw "启动监控服务失败 (ReturnValue=$($r.ReturnValue))" }
  Start-Sleep -Seconds 3
  Write-Output "  已启动 pid $($r.ProcessId)"
} else {
  Write-Output "监控服务已在 $Port 运行"
}

# 2. 可视化窗口（去重：已有指向 8791 的 chrome app 就跳过）；-NoWindow 时整段跳过
if ($NoWindow) {
  Write-Output "(-NoWindow) 只保证服务，不开窗口"
} else {
  $existing = $null
  try {
    $existing = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*--app=http://127.0.0.1:$Port*" }
  } catch { }
  if ($existing) {
    Write-Output ("可视化窗口已存在 (chrome pid " + (($existing | ForEach-Object { $_.ProcessId }) -join ',') + ")")
  } else {
    Write-Output "打开可视化窗口 ..."
    Start-Process explorer.exe "`"$Vbs`""
  }
}

# 3. 画面自检
try {
  $meta = (Invoke-WebRequest "http://127.0.0.1:$Port/meta" -UseBasicParsing -TimeoutSec 15).Content
  Write-Output "画面源: $meta"
} catch {
  Write-Output "  警告: 画面源暂不可用: $($_.Exception.Message)"
}
Write-Output "虚拟桌面窗口: http://127.0.0.1:$Port/"
