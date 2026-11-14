# probe-final.ps1 -- last sweep of the untested variables, in ONE elevated run:
#   V1  no put_Server at all            (docs say the connection is redirected to localhost anyway)
#   V2  Server=localhost + TransportType=1 (TCP only -- the client keeps logging a multi-transport
#                                            connect/disconnect cycle)
#   V3  Server=127.0.0.1 + NetworkConnectionType=5 (LAN)
#   V4  Server=<machinename>            (never tried with the vtable password path)
# Each variant: fresh control, vtable ClearTextPassword + AllowPromptingForCredentials(false)
# + ConnectToChildSession, 12 s window, judged by the session list and the logon event.
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$PerVariantSec = 12,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('final-' + (Get-Date -Format 'HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class PF
{
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
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
    public static IntPtr Slot(IntPtr p, int slot) { IntPtr vt = Marshal.ReadIntPtr(p); return Marshal.ReadIntPtr(vt, IntPtr.Size * slot); }
    // PowerShell 5.1 cannot call generic methods, so expose typed accessors:
    public static PutBstrFn FnBstr(IntPtr p, int s) { return (PutBstrFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBstrFn)); }
    public static PutUlongFn FnUlong(IntPtr p, int s) { return (PutUlongFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutUlongFn)); }
    public static PutBoolFn FnBool(IntPtr p, int s) { return (PutBoolFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBoolFn)); }
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
public class PFAx : AxHost { public PFAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [PF]::ReadPwd($CredTarget)
if (-not $pwd) { Say "no credential"; return }
Say ("credential loaded (" + $pwd.Length + " chars); child sessions before = " + [PF]::ChildCount())

function Run-Variant($label, $server, $transport, $netType) {
  Say ""
  Say ("===== " + $label + "  (server='" + $server + "' transport=" + $transport + " netType=" + $netType + ") =====")
  $form = New-Object System.Windows.Forms.Form
  $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 100, 80; $form.Opacity = 0.01
  $ax = New-Object PFAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
  Start-Sleep -Milliseconds 600
  $ocx = $ax.GetOcx()
  if (-not $ocx) { Say "  no OCX"; $form.Close(); $form.Dispose(); return $false }
  if ($server) { try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($server)) | Out-Null; Say ("  put_Server = " + $server) } catch { Say ("  put_Server failed: " + $_.Exception.InnerException.Message) } }
  try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1280)) | Out-Null
        $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(800)) | Out-Null } catch {}
  $adv = $null
  try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
        $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null } catch {}
  if ($adv) {
    $hrA = 0; $pAdv = [PF]::Qi($adv, [PF]::IID_Adv, [ref]$hrA)
    if ($pAdv -ne [IntPtr]::Zero) {
      try { $put = [PF]::FnBstr($pAdv, 112); $r = $put.Invoke($pAdv, $pwd); Say ("  vtable ClearTextPassword hr=0x" + $r.ToString('X8')) } catch { Say ("  ClearTextPassword threw: " + $_.Exception.Message) }
      if ($transport -ge 0) { try { $pt = [PF]::FnUlong($pAdv, 27); $rt = $pt.Invoke($pAdv, [uint32]$transport); Say ("  vtable TransportType=" + $transport + " hr=0x" + $rt.ToString('X8')) } catch { Say ("  TransportType threw: " + $_.Exception.Message) } }
      if ($netType -ge 0) { try { $pn = [PF]::FnUlong($pAdv, 192); $rn = $pn.Invoke($pAdv, [uint32]$netType); Say ("  vtable NetworkConnectionType=" + $netType + " hr=0x" + $rn.ToString('X8')) } catch { Say ("  NetworkConnectionType threw: " + $_.Exception.Message) } }
      [void][Runtime.InteropServices.Marshal]::Release($pAdv)
    }
  }
  $hrN = 0; $pNs = [PF]::Qi($ocx, [PF]::IID_NS5, [ref]$hrN)
  if ($pNs -ne [IntPtr]::Zero) { try { $pb = [PF]::FnBool($pNs, 63); [void]$pb.Invoke($pNs, $false) } catch {}; [void][Runtime.InteropServices.Marshal]::Release($pNs) }
  $hrE = 0; $pE = [PF]::Qi($ocx, [PF]::IID_Ext, [ref]$hrE)
  if ($pE -ne [IntPtr]::Zero) { $pp = [PF]::FnProp($pE, 3); $v = [PF+VARIANT]::Bool($true); $re = $pp.Invoke($pE, 'ConnectToChildSession', [ref]$v); Say ("  ConnectToChildSession hr=0x" + $re.ToString('X8')); [void][Runtime.InteropServices.Marshal]::Release($pE) }
  try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }
  $found = $false
  for ($i = 1; $i -le $PerVariantSec; $i++) {
    Start-Sleep -Seconds 1
    $n = [PF]::ChildCount()
    if ($n -gt 0) { Say ("  *** t=+" + $i + "s CHILD SESSION APPEARED (" + $n + ") ***"); $found = $true; break }
  }
  $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  Say ("  result: conn=" + $conn + " childCount=" + [PF]::ChildCount())
  try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
  try { $form.Close(); $form.Dispose() } catch {}
  Start-Sleep -Seconds 2
  return $found
}

$machine = $env:COMPUTERNAME
$ok = $false
if (-not $ok) { $ok = Run-Variant 'V1 no Server'            ''            -1 -1 }
if (-not $ok) { $ok = Run-Variant 'V2 localhost + TCP only' 'localhost'    1 -1 }
if (-not $ok) { $ok = Run-Variant 'V3 127.0.0.1 + LAN'      '127.0.0.1'   -1  5 }
if (-not $ok) { $ok = Run-Variant 'V4 machine name'         $machine      -1 -1 }

Say ""
Say ("=== FINAL SWEEP: " + $(if ($ok) { 'A CHILD SESSION APPEARED' } else { 'none of the variants produced a child session' }) + " ===")
try {
  $since = (Get-Date).AddMinutes(-8)
  $ev = Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 100 -ErrorAction SilentlyContinue |
        Where-Object { $_.TimeCreated -gt $since -and $_.Id -eq 21 }
  if ($ev) { foreach ($e in ($ev | Sort-Object TimeCreated)) { Say ("  [EVENT logon] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " " + (($e.Message -replace "`r`n",' | ').Substring(0,[Math]::Min(70,($e.Message -replace "`r`n",' | ').Length)))) } }
  else { Say "  [EVENT] 最近 8 分钟没有任何 logon 事件" }
} catch {}
$pwd = $null
Say ("report: " + $report)
