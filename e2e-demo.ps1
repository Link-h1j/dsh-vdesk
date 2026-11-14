# e2e-demo.ps1 (v2) -- full R3 demonstration, RUN ELEVATED.
#
#   v2 fixes learned from v1:
#     * child-session detection now uses WTSEnumerateSessions (the child session shows up
#       with a window-station name like "<guid>#0"); WTSGetChildSessionId returns a STALE id
#       after a previous child session was logged off, so it cannot be used alone.
#     * the helper needs an http.sys URL ACL when it runs as a normal user -> we add one
#       for 127.0.0.1:<port> while the demo runs and remove it afterwards.
#     * the helper is queued both in HKCU RunOnce and in the user's Startup folder.
#
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$HelperPort = 8790,
  [int]$WaitSessionSec = 25,
  [int]$WaitHelperSec  = 45,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('e2e2-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ("elevated = " + $admin)
if (-not $admin) { Say "ABORT: must run elevated"; return }

$helperExe = Join-Path $PSScriptRoot 'helper\dsh-vdesk-helper.exe'
Say ("helper exe exists = " + (Test-Path $helperExe))
if (-not (Test-Path $helperExe)) { Say "ABORT: helper not built"; return }

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class E2
{
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);

    [StructLayout(LayoutKind.Sequential)]
    public struct WTS_SESSION_INFO { public int SessionId; [MarshalAs(UnmanagedType.LPWStr)] public string pWinStationName; public int State; }
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int pCount);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);

    // returns "id|name" strings for sessions whose window station name contains '#'
    // (a loopback child session is named "<listener-guid>#0")
    public static string[] ChildSessions()
    {
        List<string> outp = new List<string>();
        IntPtr p; int count;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out count)) return outp.ToArray();
        try {
            int sz = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
            for (int i = 0; i < count; i++) {
                IntPtr q = new IntPtr(p.ToInt64() + i * sz);
                WTS_SESSION_INFO si = (WTS_SESSION_INFO)Marshal.PtrToStructure(q, typeof(WTS_SESSION_INFO));
                if (si.pWinStationName != null && si.pWinStationName.Contains("#"))
                    outp.Add(si.SessionId + "|" + si.pWinStationName + "|state=" + si.State);
            }
        } finally { WTSFreeMemory(p); }
        return outp.ToArray();
    }

    // every session, for diagnostics
    public static string[] AllSessions()
    {
        List<string> outp = new List<string>();
        IntPtr p; int count;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out count)) return outp.ToArray();
        try {
            int sz = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
            for (int i = 0; i < count; i++) {
                IntPtr q = new IntPtr(p.ToInt64() + i * sz);
                WTS_SESSION_INFO si = (WTS_SESSION_INFO)Marshal.PtrToStructure(q, typeof(WTS_SESSION_INFO));
                outp.Add(si.SessionId + "|" + si.pWinStationName + "|state=" + si.State);
            }
        } finally { WTSFreeMemory(p); }
        return outp.ToArray();
    }

    public static readonly Guid IID = new Guid("302D8188-0052-4807-806A-362B628F9AC5");
    [StructLayout(LayoutKind.Explicit, Size=24)] public struct VARIANT {
        [FieldOffset(0)] public ushort vt; [FieldOffset(2)] public ushort r1; [FieldOffset(4)] public ushort r2; [FieldOffset(6)] public ushort r3;
        [FieldOffset(8)] public short bVal; [FieldOffset(8)] public IntPtr ptr;
        public static VARIANT Bool(bool v){ VARIANT x=new VARIANT(); x.vt=11; x.bVal=(short)(v?-1:0); return x; } }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PropertyFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string name, ref VARIANT val);
    public static PropertyFn Fn(IntPtr p, int slot) { IntPtr v = Marshal.ReadIntPtr(p);
        return (PropertyFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(v, IntPtr.Size*slot), typeof(PropertyFn)); }
    public static IntPtr Qi(object o) { Guid iid = IID; IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        int hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk); return hr==0?p:IntPtr.Zero; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL { public uint Flags, Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t, uint ty, uint f, out IntPtr p);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
    public static string ReadPwd(string target) { IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p)) return null;
        try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
              if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
              return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2)); } finally { CredFree(p); } }
}
public class E2Ax : AxHost { public E2Ax() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [E2]::ReadPwd($CredTarget)
if (-not $pwd) { Say ("ABORT: no credential '" + $CredTarget + "'"); return }
Say ("credential loaded (" + $pwd.Length + " chars)")

Say ("child sessions BEFORE: [" + ([string]::Join("] [", [E2]::ChildSessions())) + "]")

# ---- 1) make the helper able to serve, and queue it for the child session's logon ----
$urlacl = 'http://127.0.0.1:' + $HelperPort + '/'
$null = & netsh http delete urlacl url=$urlacl 2>&1
$aclOut = & netsh http add urlacl url=$urlacl user=Everyone 2>&1 | Out-String
Say ("urlacl add: " + $aclOut.Trim())

$startup = [Environment]::GetFolderPath('Startup')
$startupCopy = Join-Path $startup 'dsh-vdesk-helper.exe'
Copy-Item $helperExe $startupCopy -Force
Say ("helper copied to Startup: " + $startupCopy)

$runOnceCmd = '"' + $helperExe + '" ' + $HelperPort
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'DshVdeskHelper' -Value $runOnceCmd -ErrorAction SilentlyContinue
Say ("RunOnce queued: " + $runOnceCmd)

# ---- 2) create the child session ----
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
$ax = New-Object E2Ax; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 700
$ocx = $ax.GetOcx()
if (-not $ocx) { Say "ABORT: no OCX"; $form.Close(); return }
try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
# NOTE: this exact spelling is what worked at 18:57 -- full name in UserName, no Domain,
# and no AuthenticationLevel override. Splitting user/domain or forcing authLevel=0 made
# the child session silently fail to appear.
try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1280)) | Out-Null
      $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(800)) | Out-Null } catch {}
try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
      $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null
      $adv.ClearTextPassword = $pwd } catch { Say ("adv fail: " + $_.Exception.InnerException.Message) }
$p = [E2]::Qi($ocx)
if ($p -eq [IntPtr]::Zero) { Say "ABORT: no IMsRdpExtendedSettings"; $form.Close(); return }
$put = [E2]::Fn($p, 3); $v = [E2+VARIANT]::Bool($true)
Say ("ConnectToChildSession hr=0x" + $put.Invoke($p, 'ConnectToChildSession', [ref]$v).ToString('X8'))
[void][Runtime.InteropServices.Marshal]::Release($p)
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("Connect threw: " + $_.Exception.InnerException.Message) }

# ---- 3) wait for a REAL child session (enumerated, not the stale API id) ----
$childId = 0
$childName = ''
for ($i = 1; $i -le $WaitSessionSec; $i++) {
  Start-Sleep -Seconds 1
  $kids = [E2]::ChildSessions()
  if ($kids.Count -gt 0) {
    Say ("t=+" + $i + "s child sessions: [" + ([string]::Join("] [", $kids)) + "]")
    $childId = [int]($kids[0].Split('|')[0])
    $childName = $kids[0].Split('|')[1]
    break
  }
}
Say ("child session id=" + $childId + " name=" + $childName)
if ($childId -eq 0) {
  Say ("ALL sessions: [" + ([string]::Join("] [", [E2]::AllSessions())) + "]")
  Say "ABORT: no child session appeared"
  try { $form.Close() } catch {}
  return
}

# ---- 4) wait for the helper, then use it ----
$base = 'http://127.0.0.1:' + $HelperPort
function Get-Url($u) { try { return (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15) } catch { return $null } }
$up = $false
for ($i = 1; $i -le $WaitHelperSec; $i++) {
  Start-Sleep -Seconds 1
  $r = Get-Url ($base + '/health')
  if ($r -and $r.StatusCode -eq 200) { Say ("helper UP after " + $i + "s: " + $r.Content); $up = $true; break }
}
$marker = 'C:\Users\Administrator\AppData\Local\Temp\dsh-vdesk-helper.json'
if (Test-Path $marker) { Say ("helper marker: " + ([IO.File]::ReadAllText($marker))) } else { Say "helper marker: (none)" }
if (-not $up) { Say "helper did NOT come up" }

if ($up) {
  $r = Get-Url ($base + '/screenshot')
  if ($r) { $f1 = Join-Path $OutDir 'child-desktop-before.png'; [IO.File]::WriteAllBytes($f1, $r.Content); Say ("shot1 -> " + $f1 + " (" + $r.Content.Length + "B)") }
  [void](Get-Url ($base + '/key?action=combo&vks=91,82'))
  Start-Sleep -Milliseconds 900
  [void](Get-Url ($base + '/key?action=text&text=notepad'))
  Start-Sleep -Milliseconds 400
  [void](Get-Url ($base + '/key?action=vk&vk=13'))
  Start-Sleep -Seconds 3
  $r = Get-Url ($base + '/screenshot')
  if ($r) { $f2 = Join-Path $OutDir 'child-desktop-after.png'; [IO.File]::WriteAllBytes($f2, $r.Content); Say ("shot2 -> " + $f2 + " (" + $r.Content.Length + "B)") }
}

# ---- 5) cleanup ----
try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null; Say "Disconnect ok" } catch {}
if ($childId -ne 0) { Say ("WTSLogoffSession(" + $childId + ") = " + [E2]::WTSLogoffSession([IntPtr]::Zero, $childId, $false)) }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'DshVdeskHelper' -ErrorAction SilentlyContinue
Remove-Item $startupCopy -Force -ErrorAction SilentlyContinue
Say ("Startup copy removed: " + (-not (Test-Path $startupCopy)))
$null = & netsh http delete urlacl url=$urlacl 2>&1
Say "urlacl removed"
Start-Sleep -Seconds 2
Say ("child sessions AFTER: [" + ([string]::Join("] [", [E2]::ChildSessions())) + "]")
try { $form.Close(); $form.Dispose() } catch {}
$pwd = $null
Say ("report: " + $report)
