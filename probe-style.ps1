$cs = @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static string[] Find() {
    List<string> o = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      StringBuilder c = new StringBuilder(256);
      GetClassName(h, c, c.Capacity);
      string cls = c.ToString();
      if (cls.StartsWith("WindowsForms10.Window", StringComparison.Ordinal) && IsWindowVisible(h)) {
        StringBuilder t = new StringBuilder(512);
        GetWindowText(h, t, t.Capacity);
        int style = GetWindowLong(h, -16);
        int ex = GetWindowLong(h, -20);
        o.Add("cls=" + cls + " titleLen=" + t.Length
          + " style=0x" + style.ToString("X8") + " exstyle=0x" + ex.ToString("X8")
          + " | THICKFRAME=" + ((style & 0x00040000) != 0)
          + " SYSMENU=" + ((style & 0x00080000) != 0)
          + " CAPTION=" + ((style & 0x00C00000) == 0x00C00000)
          + " MINBOX=" + ((style & 0x00020000) != 0)
          + " MAXBOX=" + ((style & 0x00010000) != 0)
          + " | LAYERED=" + ((ex & 0x00080000) != 0)
          + " TOOLWINDOW=" + ((ex & 0x00000080) != 0)
          + " APPWINDOW=" + ((ex & 0x00040000) != 0));
      }
      return true;
    }, IntPtr.Zero);
    return o.ToArray();
  }
}
"@
Add-Type -TypeDefinition $cs -Language CSharp
$r = [W2]::Find()
if ($r.Count -eq 0) { Write-Output "(no WindowsForms10 window in this session/desktop)" } else { $r | ForEach-Object { Write-Output $_ } }