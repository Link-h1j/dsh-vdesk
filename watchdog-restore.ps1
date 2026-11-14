# watchdog-restore.ps1 -- self-healing supervisor for the child-session virtual desktop.
#
# Context: an investigation agent may be creating/destroying child sessions in bursts, and only
# one child session can exist at a time, so our keeper gets bumped out repeatedly. This
# supervisor keeps the user's desktop available as much as possible:
#   * every 15 s, check whether our vdesk is healthy (child session alive + helper answering)
#   * if it is down AND the experiment processes are quiet -> restore it
#   * if it is down but experiments are running -> wait (two keepers thrashing helps nobody)
#
# ASCII only.

param(
  [int]$MaxMinutes = 60,
  [string]$LogFile = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\watchdog.log'
)

function L($m) { Add-Content -Path $LogFile -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }
$vdesk   = 'C:\Users\Administrator\Documents\deepseek-harness\默认工作区\tools\vdesk-childsession\vdesk.ps1'
$visible = 'C:\Users\Administrator\Documents\deepseek-harness\默认工作区\tools\vdesk-childsession\vdesk-visible.ps1'
$statusFile = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\keeper.json'

function VdeskHealthy {
  try {
    $h = (Invoke-WebRequest -Uri 'http://127.0.0.1:8790/health' -UseBasicParsing -TimeoutSec 4).Content
    if ($h -notmatch '"ok":true') { return $false }
  } catch { return $false }
  foreach ($s in (qwinsta 2>&1)) { if ($s -match '#\d+') { return $true } }
  return $false
}

function ExperimentsActive {
  $ourPid = 0
  try {
    $j = Get-Content $statusFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($j -and $j.pid) { $ourPid = [int]$j.pid }
  } catch { }
  try {
    $c = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and
      ($_.CommandLine -like '*keeper.ps1*' -or $_.CommandLine -like '*probe-*' -or $_.CommandLine -like '*vdesk.ps1*') -and
      $_.ProcessId -ne $ourPid
    }).Count
  } catch { $c = 0 }
  return $c
}

# Someone else's child session: Doubao's virtual desktop uses the very same system slot. Never
# fight for it -- restoring ours would either fail or knock THEIRS out, and knocking theirs out is
# exactly how a session the user was actively using got killed once already (19:54:37).
function ForeignChildIds {
  $ours = @()
  try {
    $j = Get-Content $statusFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($j -and $j.candidates) {
      foreach ($c in ($j.candidates -split ',')) {
        $m = [regex]::Match($c, '^\s*(\d+)')
        if ($m.Success) { $ours += [int]$m.Groups[1].Value }
      }
    }
  } catch { }
  $all = @()
  foreach ($line in ((& qwinsta 2>&1) -split "`r?`n")) {
    if ($line -match '#') {
      $m = [regex]::Match($line, '#\S*\s+\S+\s+(\d+)')
      if ($m.Success) { $all += [int]$m.Groups[1].Value }
      else {
        $nums = [regex]::Matches($line, '\d+')
        if ($nums.Count -ge 1) { $all += [int]$nums[0].Value }
      }
    }
  }
  return @($all | Where-Object { $ours -notcontains $_ })
}

function Restore {
  L 'restoring the virtual desktop ...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $vdesk stop 2>&1 | Out-String | Out-Null
  Start-Sleep -Seconds 3
  $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $vdesk start -Minutes 240 2>&1 | Out-String
  Start-Sleep -Seconds 12
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*vdesk-monitor*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*--app=http://127.0.0.1:8791*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    & powershell -NoProfile -ExecutionPolicy Bypass -File $visible 2>&1 | Out-String | Out-Null
  } catch { L ('panel restart failed: ' + $_.Exception.Message) }
  if (VdeskHealthy) { L 'restore OK (healthy)' } else { L 'restore finished but NOT healthy yet' }
}

L ('--- supervisor start, max ' + $MaxMinutes + ' min ---')
$deadline = (Get-Date).AddMinutes($MaxMinutes)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 15
  if (VdeskHealthy) { continue }
  $exp = ExperimentsActive
  if ($exp -gt 0) {
    L ('vdesk down, but ' + $exp + ' experiment process(es) active -> waiting')
    continue
  }
  $foreign = ForeignChildIds
  if ($foreign.Count -gt 0) {
    L ('vdesk down, but the slot is held by someone else (id ' + ($foreign -join ',') + ') -> NOT restoring')
    continue
  }
  Restore
}
L '--- supervisor timed out ---'
