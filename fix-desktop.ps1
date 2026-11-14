# fix-desktop.ps1 -- run INSIDE a child session: make the desktop actually show its icons.
#
# Why: the first explorer that starts in a freshly created child session comes up before the
# user's shell folders / redirected Desktop (here F:\OneDrive\Desktop) are ready, so the desktop
# icon list view stays empty even though the folder has 105 items. Restarting explorer fixes it.
#
# SAFETY (added after a real incident): this script kills explorer. It must NEVER run in the
# user's own console session. Two independent guards:
#   1. refuse session id <= 1
#   2. refuse when the process window station is "Console" (that is the interactive logon session;
#      a child session's window station is named "<listener-guid>#0")
#
# ASCII only.

$log = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\fix-desktop.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }

$me = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

$cs = @'
using System;
using System.Runtime.InteropServices;
public static class VGuard {
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WTSQuerySessionInformation(IntPtr h, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytes);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
    public static string WinStation() {
        IntPtr buf = IntPtr.Zero; int bytes = 0;
        // WTS_CURRENT_SESSION = -1 ; WTSWinStationName = 6
        if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 6, out buf, out bytes)) { return ""; }
        try { return Marshal.PtrToStringUni(buf); } finally { WTSFreeMemory(buf); }
    }
}
'@
$winsta = ''
try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; $winsta = [VGuard]::WinStation() } catch { $winsta = '(probe failed)' }

L ('--- fix-desktop requested: session=' + $me + ' winsta=' + $winsta + ' ---')
if ($me -le 1 -or $winsta -eq 'Console') {
  L 'REFUSED: this is the console/interactive session -- refusing to restart the user''s explorer'
  Write-Output "refused: session $me winsta='$winsta' is not a child session"
  exit 9
}

$before = @(Get-Process -Name explorer -ErrorAction SilentlyContinue)
L ('explorer before: ' + (($before | ForEach-Object { $_.Id }) -join ','))
$dp = [Environment]::GetFolderPath('Desktop')
L ('desktop folder: ' + $dp + ' items=' + @(Get-ChildItem $dp -Force -ErrorAction SilentlyContinue).Count)

$before | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
  L 'explorer did not auto-restart -> starting it'
  Start-Process 'C:\Windows\explorer.exe'
}
Start-Sleep -Seconds 6
L ('explorer after: ' + ((Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','))

# wait for the desktop list view to exist and be populated (up to ~20s)
$cs2 = @'
using System; using System.Runtime.InteropServices;
public static class DV {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  public static int Count() {
    IntPtr pm = FindWindow("Progman", null);
    IntPtr dv = IntPtr.Zero;
    if (pm != IntPtr.Zero) dv = FindWindowEx(pm, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (dv == IntPtr.Zero) {
      IntPtr w = FindWindow("WorkerW", null);
      int guard = 0;
      while (w != IntPtr.Zero && guard++ < 20 && dv == IntPtr.Zero) {
        dv = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (dv != IntPtr.Zero) break;
        w = FindWindowEx(IntPtr.Zero, w, "WorkerW", null);
      }
    }
    if (dv == IntPtr.Zero) return -1;
    IntPtr lv = FindWindowEx(dv, IntPtr.Zero, "SysListView32", null);
    if (lv == IntPtr.Zero) return -2;
    return (int)SendMessage(lv, 0x1004, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
try {
  Add-Type -TypeDefinition $cs2 -Language CSharp -ErrorAction Stop
  for ($i = 1; $i -le 10; $i++) {
    $n = [DV]::Count()
    L ('desktop items visible in listview: ' + $n)
    if ($n -gt 0) { break }
    Start-Sleep -Seconds 2
  }
} catch { L ('probe failed: ' + $_.Exception.Message) }
L '--- done ---'
