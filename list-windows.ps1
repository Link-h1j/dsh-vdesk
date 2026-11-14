# list-windows.ps1 -- list every visible top-level window in THIS session (run inside the child).
$out = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\session-windows.txt'
$cs = @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LW {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] All() {
    List<string> o = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, c.Capacity);
      StringBuilder t = new StringBuilder(256); GetWindowText(h, t, t.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      o.Add(c.ToString() + " | pid=" + pid + " | " + t.ToString());
      return true;
    }, IntPtr.Zero);
    return o.ToArray();
  }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp
$lines = @('=== session ' + [System.Diagnostics.Process]::GetCurrentProcess().SessionId + ' visible windows ===')
try { foreach ($w in [LW]::All()) { $lines += ('  ' + $w) } } catch { $lines += ('  err: ' + $_.Exception.Message) }
[IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding($false)))
$lines | ForEach-Object { Write-Output $_ }
