# probe-vtable.ps1 -- the decisive attempt: deliver the password through the NON-SCRIPTABLE
# vtable instead of the scriptable property.
#
# Slot numbers come from the type library embedded in mstscax.dll (dump-tlb.ps1):
#   IMsRdpClientAdvancedSettings        3c65b4ab-12b3-465b-acd4-b8dad3bff9e2   put_ClearTextPassword        slot 112
#   IMsRdpClientNonScriptable5          4f6996d5-d7b1-412c-b0ff-063718566907   put_AllowPromptingForCredentials slot 63
#   IMsRdpExtendedSettings              302d8188-0052-4807-806a-362b628f9ac5   put_Property                 slot 3
#
# Verdict: TerminalServices logon event (id=21) + WTSEnumerateSessions. NOT WTSGetChildSessionId.
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$WaitSec = 20,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('vtable-' + (Get-Date -Format 'HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

Say ("elevated = " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class PV
{
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);
    [StructLayout(LayoutKind.Sequential)] public struct WTS_SESSION_INFO { public int SessionId; [MarshalAs(UnmanagedType.LPWStr)] public string pWinStationName; public int State; }
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSEnumerateSessions(IntPtr h, int r, int v, out IntPtr pp, out int cnt);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
    public static string[] All() {
        List<string> o = new List<string>(); IntPtr p; int c;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out c)) return o.ToArray();
        try { int sz = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
              for (int i=0;i<c;i++){ IntPtr q=new IntPtr(p.ToInt64()+i*sz);
                WTS_SESSION_INFO si=(WTS_SESSION_INFO)Marshal.PtrToStructure(q, typeof(WTS_SESSION_INFO));
                o.Add(si.SessionId + "|" + si.pWinStationName + "|state=" + si.State); } }
        finally { WTSFreeMemory(p); }
        return o.ToArray(); }

    public static readonly Guid IID_Ext = new Guid("302d8188-0052-4807-806a-362b628f9ac5");
    public static readonly Guid IID_Adv = new Guid("3c65b4ab-12b3-465b-acd4-b8dad3bff9e2");
    public static readonly Guid IID_NS5 = new Guid("4f6996d5-d7b1-412c-b0ff-063718566907");

    [StructLayout(LayoutKind.Explicit, Size=24)] public struct VARIANT {
        [FieldOffset(0)] public ushort vt; [FieldOffset(2)] public ushort r1; [FieldOffset(4)] public ushort r2; [FieldOffset(6)] public ushort r3;
        [FieldOffset(8)] public short bVal; [FieldOffset(8)] public IntPtr ptr;
        public static VARIANT Bool(bool v){ VARIANT x=new VARIANT(); x.vt=11; x.bVal=(short)(v?-1:0); return x; } }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PropertyFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string name, ref VARIANT val);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PutBstrFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PutBoolFn(IntPtr pThis, [MarshalAs(UnmanagedType.VariantBool)] bool value);

    public static IntPtr Qi(object o, Guid iid, out int hr) {
        IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk);
        return hr == 0 ? p : IntPtr.Zero; }
    public static IntPtr Slot(IntPtr p, int slot) { IntPtr vt = Marshal.ReadIntPtr(p); return Marshal.ReadIntPtr(vt, IntPtr.Size * slot); }

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
public class PVAx : AxHost { public PVAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [PV]::ReadPwd($CredTarget)
if (-not $pwd) { Say "no credential"; return }
Say ("credential loaded (" + $pwd.Length + " chars)")
Say ("sessions BEFORE: [" + ([string]::Join("] [", [PV]::All())) + "]")

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
$ax = New-Object PVAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 700
$ocx = $ax.GetOcx()
if (-not $ocx) { Say "no OCX"; return }

# ---- 1) scriptable basics ----
try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1280)) | Out-Null
      $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(800)) | Out-Null } catch {}
$adv = $null
try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
      $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null
      Say "  scriptable: CredSSP=on" } catch { Say ("  adv fail: " + $_.Exception.InnerException.Message) }

# ---- 2) NON-SCRIPTABLE password (slot 112 of IMsRdpClientAdvancedSettings) ----
if ($adv) {
  $hr = 0
  $pAdv = [PV]::Qi($adv, [PV]::IID_Adv, [ref]$hr)
  Say ("  QI IMsRdpClientAdvancedSettings on the AdvancedSettings7 object: hr=0x" + $hr.ToString('X8'))
  if ($pAdv -ne [IntPtr]::Zero) {
    $fn = [PV]::Slot($pAdv, 112)
    $put = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($fn, [Type][PV+PutBstrFn])
    $r = $put.Invoke($pAdv, $pwd)
    Say ("  vtable slot112 put_ClearTextPassword -> hr=0x" + $r.ToString('X8') + $(if ($r -ge 0) { "  (S_OK)" } else { "" }))
    [void][Runtime.InteropServices.Marshal]::Release($pAdv)
  }
}

# ---- 3) NON-SCRIPTABLE AllowPromptingForCredentials (slot 63 of IMsRdpClientNonScriptable5) ----
$hr2 = 0
$pNs5 = [PV]::Qi($ocx, [PV]::IID_NS5, [ref]$hr2)
Say ("  QI IMsRdpClientNonScriptable5 on the control: hr=0x" + $hr2.ToString('X8'))
if ($pNs5 -ne [IntPtr]::Zero) {
  $fn2 = [PV]::Slot($pNs5, 63)
  $put2 = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($fn2, [Type][PV+PutBoolFn])
  $r2 = $put2.Invoke($pNs5, $false)
  $fn2b = [PV]::Slot($pNs5, 64)
  $get2 = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($fn2b, [Type][PV+PutBoolFn])
  $rback = $get2.Invoke($pNs5, $false)
  Say ("  vtable slot63 put_AllowPromptingForCredentials(false) -> hr=0x" + $r2.ToString('X8') + "  (slot64 get -> hr=0x" + $rback.ToString('X8') + ")")
  [void][Runtime.InteropServices.Marshal]::Release($pNs5)
}

# ---- 4) ConnectToChildSession ----
$hr3 = 0
$pExt = [PV]::Qi($ocx, [PV]::IID_Ext, [ref]$hr3)
if ($pExt -ne [IntPtr]::Zero) {
  $fn3 = [PV]::Slot($pExt, 3)
  $put3 = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($fn3, [Type][PV+PropertyFn])
  $v = [PV+VARIANT]::Bool($true)
  $r3 = $put3.Invoke($pExt, 'ConnectToChildSession', [ref]$v)
  Say ("  put_Property('ConnectToChildSession') -> hr=0x" + $r3.ToString('X8'))
  [void][Runtime.InteropServices.Marshal]::Release($pExt)
}

Say "calling Connect() ..."
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }

for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
  Say ("  t=+" + $i + "s conn=" + $conn + " sessions=[" + ([string]::Join("] [", [PV]::All())) + "] err=" + $err)
}
Say ("sessions AFTER: [" + ([string]::Join("] [", [PV]::All())) + "]")

# ---- verdict from the event log ----
try {
  $since = (Get-Date).AddMinutes(-3)
  $ev = Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 80 -ErrorAction SilentlyContinue |
        Where-Object { $_.TimeCreated -gt $since -and ($_.Id -eq 21 -or $_.Id -eq 41 -or $_.Id -eq 22) }
  if ($ev) { foreach ($e in ($ev | Sort-Object TimeCreated)) { Say ("  [EVENT] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " id=" + $e.Id + " " + (($e.Message -replace "`r`n",' | ').Substring(0,[Math]::Min(80,($e.Message -replace "`r`n",' | ').Length)))) } }
  else { Say "  [EVENT] 最近 3 分钟没有 logon(21)/arbitration(41) 事件 -> 仍未完成登录" }
} catch { }

try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
$cid = [uint32]0
if ([PV]::WTSGetChildSessionId([ref]$cid) -and $cid -ne 4294967295) { [void][PV]::WTSLogoffSession([IntPtr]::Zero, $cid, $false) }
try { $form.Close(); $form.Dispose() } catch {}
$pwd = $null
Say ("report: " + $report)
