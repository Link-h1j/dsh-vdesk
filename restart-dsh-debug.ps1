$log = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\dsh-restart.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }
L '=== scheduled restart: waiting 25s so the current turn can finish ==='
Start-Sleep -Seconds 25
$ps = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
L ('closing ' + $ps.Count + ' process(es) gracefully')
foreach ($p in $ps) { try { [void]$p.CloseMainWindow() } catch { } }
Start-Sleep -Seconds 5
$left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($left.Count) { L ('still alive: ' + $left.Count + ' -> force kill'); $left | Stop-Process -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 4
try {
  Start-Process -FilePath 'B:\DSHdesktop\DeepSeek Harness.exe' -ArgumentList '--remote-debugging-port=9222'
  L 'relaunched with --remote-debugging-port=9222'
} catch { L ('relaunch FAILED: ' + $_.Exception.Message) }
Start-Sleep -Seconds 15
try {
  $v = Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 6
  L ('CDP reachable: ' + $v.Content)
} catch { L ('CDP not reachable: ' + $_.Exception.Message) }