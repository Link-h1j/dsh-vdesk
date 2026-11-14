# tidy-session.ps1 -- run INSIDE the child session: get the startup-launched console windows out of
# the way. The user's own Startup folder items (DSH-SelfImprove.cmd, DSH-Feishu-Agent.vbs, ...) run
# at child-session logon and leave cmd/Windows Terminal windows on the desktop and in the taskbar.
# They are hidden rather than killed so the services behind them keep running.
#
# SAFETY: only ever hides console-class windows. It never kills processes and never touches the
# console session (session 1) -- the session guard below refuses to run there.
#
# ASCII only.

$log = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\tidy-session.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }

$me = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

$cs = @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Tidy {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool WTSQuerySessionInformation(IntPtr h, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);

  public static string WinStation() {
    IntPtr buf = IntPtr.Zero; int bytes = 0;
    if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 6, out buf, out bytes)) return "";
    try { return Marshal.PtrToStringUni(buf); } finally { WTSFreeMemory(buf); }
  }

  static readonly string[] CLASSES = new string[] {
    "ConsoleWindowClass",                 // classic conhost
    "CASCADIA_HOSTING_WINDOW_CLASS",      // Windows Terminal
    "PseudoConsoleWindow",
    "mintty"
  };

  public static string HideConsoles() {
    List<string> hidden = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      string c = cls.ToString();
      foreach (string want in CLASSES) {
        if (c == want) {
          StringBuilder title = new StringBuilder(256);
          GetWindowText(h, title, title.Capacity);
          ShowWindow(h, 0 /* SW_HIDE */);
          hidden.Add(c + " '" + title.ToString() + "'");
          break;
        }
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(" | ", hidden.ToArray());
  }
}
'@
$winsta = ''
try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; $winsta = [Tidy]::WinStation() } catch { $winsta = '(probe failed)' }

L ('--- tidy requested: session=' + $me + ' winsta=' + $winsta + ' ---')
if ($me -le 1 -or $winsta -eq 'Console') {
  L 'REFUSED: console/interactive session'
  Write-Output "refused: session $me winsta='$winsta'"
  exit 9
}

for ($i = 1; $i -le 6; $i++) {
  $hid = ''
  try { $hid = [Tidy]::HideConsoles() } catch { $hid = 'err ' + $_.Exception.Message }
  L ('pass ' + $i + ' hidden: ' + $hid)
  # startup items can launch their consoles a little later; keep sweeping for a while
  if ($i -lt 6) { Start-Sleep -Seconds 3 }
}
L '--- done ---'
