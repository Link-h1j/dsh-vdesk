# probe-pump.ps1 -- the fix for the real defect found at 20:0x:
#   every run after 18:46 forgot to PUMP WINDOWS MESSAGES while waiting. The RDP ActiveX is a
#   windowed control whose connection state machine needs its message loop; with a bare
#   Start-Sleep loop it never even opened a TCP socket (netstat showed nothing, the server
#   logged nothing). The one run that did reach the server (18:46) had Application.DoEvents().
#
# So: full configuration + Application.DoEvents() in the wait loop.
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [bool]$UseChildFlag = $true,
  [int]$AuthLevel = 0,
  [bool]$SetAuth = $true,
  [int]$WaitSec = 25,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('pump-' + (Get-Date -Format 'HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class PP
{
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);
    [StructLayout(LayoutKind.Sequential)] public struct WTS_SESSION_INFO { public int SessionId; [MarshalAs(UnmanagedType.LPWStr)] public string pWinStationName; public int State; }
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSEnumerateSessions(IntPtr h, int r, int v, out IntPtr pp, out int cnt);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
    public static string[] All() { List<string> o = new List<string>(); IntPtr p; int c;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out c)) return o.ToArray();
        try { int sz = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
              for (int i=0;i<c;i++){ IntPtr q=new IntPtr(p.ToInt64()+i*sz);
                WTS_SESSION_INFO si=(WTS_SESSION_INFO)Marshal.PtrToStructure(q, typeof(WTS_SESSION_INFO));
                o.Add(si.SessionId + "|" + si.pWinStationName + "|s" + si.State); } }
        finally { WTSFreeMemory(p); } return o.ToArray(); }
    public static int ChildCount() { int n = 0; foreach (string s in All()) if (s.Contains("#")) n++; return n; }
    public static string StateOf(int id) { foreach (string s in All()) { string[] a = s.Split('|'); if (a.Length > 2 && a[0] == id.ToString()) return a[2]; } return "?"; }

    public static readonly Guid IID_Ext = new Guid("302d8188-0052-4807-806a-362b628f9ac5");
    public static readonly Guid IID_Adv = new Guid("3c65b4ab-12b3-465b-acd4-b8dad3bff9e2");
    public static readonly Guid IID_NS5 = new Guid("4f6996d5-d7b1-412c-b0ff-063718566907");

    [StructLayout(LayoutKind.Explicit, Size=24)] public struct VARIANT {
        [FieldOffset(0)] public ushort vt; [FieldOffset(2)] public ushort r1; [FieldOffset(4)] public ushort r2; [FieldOffset(6)] public ushort r3;
        [FieldOffset(8)] public short bVal; [FieldOffset(8)] public IntPtr ptr;
        public static VARIANT Bool(bool v){ VARIANT x=new VARIANT(); x.vt=11; x.bVal=(short)(v?-1:0); return x; } }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PropertyFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string name, ref VARIANT val);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutBstrFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutBoolFn(IntPtr pThis, [MarshalAs(UnmanagedType.VariantBool)] bool value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutUlongFn(IntPtr pThis, uint value);

    public static IntPtr Qi(object o, Guid iid, out int hr) { IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk); return hr == 0 ? p : IntPtr.Zero; }
    public static IntPtr Slot(IntPtr p, int s) { IntPtr vt = Marshal.ReadIntPtr(p); return Marshal.ReadIntPtr(vt, IntPtr.Size * s); }
    public static PutBstrFn FnBstr(IntPtr p, int s) { return (PutBstrFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBstrFn)); }
    public static PutBoolFn FnBool(IntPtr p, int s) { return (PutBoolFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBoolFn)); }
    public static PutUlongFn FnUlong(IntPtr p, int s) { return (PutUlongFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutUlongFn)); }
    public static PropertyFn FnProp(IntPtr p, int s) { return (PropertyFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PropertyFn)); }

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
public class PPAx : AxHost { public PPAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [PP]::ReadPwd($CredTarget)
if (-not $pwd) { Say "no credential"; return }
Say ("credential ok; consoleState=" + [PP]::StateOf(1) + " childCount=" + [PP]::ChildCount())
Say ("config: UseChildFlag=" + $UseChildFlag + " SetAuth=" + $SetAuth + " AuthLevel=" + $AuthLevel)

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 110, 85; $form.Opacity = 0.01
$ax = New-Object PPAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 800
$ocx = $ax.GetOcx()
if (-not $ocx) { Say "no OCX"; return }

try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1280)) | Out-Null
      $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(800)) | Out-Null } catch {}
$adv = $null
try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
if ($adv) {
  try { $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null; Say "  CredSSP=on" } catch {}
  $hr = 0; $pAdv = [PP]::Qi($adv, [PP]::IID_Adv, [ref]$hr)
  if ($pAdv -ne [IntPtr]::Zero) {
    $r = [PP]::FnBstr($pAdv, 112).Invoke($pAdv, $pwd); Say ("  vtable ClearTextPassword hr=0x" + $r.ToString('X8'))
    if ($SetAuth) { $r2 = [PP]::FnUlong($pAdv, 147).Invoke($pAdv, [uint32]$AuthLevel); Say ("  vtable AuthenticationLevel=" + $AuthLevel + " hr=0x" + $r2.ToString('X8')) }
    [void][Runtime.InteropServices.Marshal]::Release($pAdv)
  }
}
$hrN = 0; $pNs = [PP]::Qi($ocx, [PP]::IID_NS5, [ref]$hrN)
if ($pNs -ne [IntPtr]::Zero) { try { $rb = [PP]::FnBool($pNs, 63).Invoke($pNs, $false); Say ("  vtable AllowPromptingForCredentials(false) hr=0x" + $rb.ToString('X8')) } catch {}; [void][Runtime.InteropServices.Marshal]::Release($pNs) }
if ($UseChildFlag) {
  $hrE = 0; $pE = [PP]::Qi($ocx, [PP]::IID_Ext, [ref]$hrE)
  if ($pE -ne [IntPtr]::Zero) { $v = [PP+VARIANT]::Bool($true); $re = [PP]::FnProp($pE, 3).Invoke($pE, 'ConnectToChildSession', [ref]$v); Say ("  ConnectToChildSession hr=0x" + $re.ToString('X8')); [void][Runtime.InteropServices.Marshal]::Release($pE) }
} else { Say "  ConnectToChildSession NOT set" }

Say "calling Connect() ..."
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }

$initialIds = @()
foreach ($s0 in [PP]::All()) { $initialIds += [int]($s0.Split("|")[0]) }
Say ("initial session ids: " + ($initialIds -join ","))
$found = $false
for ($i = 1; $i -le $WaitSec; $i++) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 1000
  [System.Windows.Forms.Application]::DoEvents()
  $conn = ""
  try { $conn = $ocx.GetType().InvokeMember("Connected",[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  $err = ""
  try { $err = $ocx.GetType().InvokeMember("GetErrorDescription",[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
  $cs1 = [PP]::StateOf(1)
  $all = [PP]::All()
  $newIds = @()
  foreach ($s1 in $all) { $sid = [int]($s1.Split("|")[0]); if ($initialIds -notcontains $sid) { $newIds += $sid } }
  Say ("  t=+" + $i + "s conn=" + $conn + " console=" + $cs1 + " newIds=" + ($newIds -join ",") + " err=" + $err)
  if ($cs1 -ne "s0") { Say "  !! console not Active"; & cmd /c "tscon 1 /dest:console" 2>&1 | Out-Null; Start-Sleep -Seconds 2; Say ("  restored=" + [PP]::StateOf(1)); break }
  if ($newIds.Count -gt 0) { $found = $true; Say ("  *** NEW SESSION: " + ($newIds -join ",")); Say ("  sessions: [" + ([string]::Join("] [", $all)) + "]"); break }
}
Say ("sessions: [" + ([string]::Join("] [", [PP]::All())) + "]")
try {
  $since = (Get-Date).AddMinutes(-3)
  $ev = Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 60 -ErrorAction SilentlyContinue | Where-Object { $_.TimeCreated -gt $since -and $_.Id -eq 21 }
  if ($ev) { foreach ($e in $ev) { Say ("  [EVENT logon] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " " + (($e.Message -replace "`r`n",' | ').Substring(0,[Math]::Min(70,($e.Message -replace "`r`n",' | ').Length)))) } }
  else { Say "  [EVENT] 最近 3 分钟没有 logon 事件" }
} catch {}
if ($found) { Say "  (keeping it ALIVE for inspection - no Disconnect)" }
else { try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {} }
Write-Output ("pump probe done; found=" + $found + " report=" + $report)
