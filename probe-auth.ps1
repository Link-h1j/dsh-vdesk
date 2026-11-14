# probe-auth.ps1 -- focused probe: does the child session finish its LOGON?
# Judged by the TerminalServices logon event (id=21) for a new session, NOT by
# WTSGetChildSessionId (which also reports half-created sessions).
# Varies only AdvancedSettings7.AuthenticationLevel.
# Run elevated (via the SYSTEM bridge + linked token).
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$AuthLevel = 2,          # 2 = must verify server cert (default), 0 = do not verify
  [switch]$SetAuth,
  [string]$PropName = 'ConnectToChildSession',
  [int]$WaitSec = 15,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('probe-' + (Get-Date -Format 'HHmmss') + '-' + $PropName + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

Say ("elevated = " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Say ("AuthenticationLevel will be " + $(if ($SetAuth) { "SET to " + $AuthLevel } else { "left at default" }))

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class PA
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
public class PAAx : AxHost { public PAAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [PA]::ReadPwd($CredTarget)
if (-not $pwd) { Say "no credential"; return }
Say ("credential loaded (" + $pwd.Length + " chars)")
Say ("sessions BEFORE: [" + ([string]::Join("] [", [PA]::All())) + "]")

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
$ax = New-Object PAAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 700
$ocx = $ax.GetOcx()
if (-not $ocx) { Say "no OCX"; return }
try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1280)) | Out-Null
      $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(800)) | Out-Null } catch {}
try {
  $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
  $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null
  $adv.ClearTextPassword = $pwd
  if ($SetAuth) {
    $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($AuthLevel)) | Out-Null
    Say ("AuthenticationLevel set to " + $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::GetProperty,$null,$adv,$null))
  }
} catch { Say ("adv fail: " + $_.Exception.InnerException.Message) }
$p = [PA]::Qi($ocx)
if ($p -eq [IntPtr]::Zero) { Say "no IMsRdpExtendedSettings"; return }
$put = [PA]::Fn($p, 3); $get = [PA]::Fn($p, 4)
foreach ($prop in @($PropName) + ($ExtraProps -split ',' | Where-Object { $_ })) {
  $v = [PA+VARIANT]::Bool($true)
  $hrP = $put.Invoke($p, $prop, [ref]$v)
  $back = New-Object PA+VARIANT
  $hrG = $get.Invoke($p, $prop, [ref]$back)
  Say ("put_Property('" + $prop + "') hr=0x" + $hrP.ToString('X8') + "   get hr=0x" + $hrG.ToString('X8') + " vt=" + $back.vt + " bVal=" + $back.bVal)
}
[void][Runtime.InteropServices.Marshal]::Release($p)
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("Connect threw: " + $_.Exception.InnerException.Message) }

for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
  $cid = [uint32]0; $o = [PA]::WTSGetChildSessionId([ref]$cid)
  Say ("  t=+" + $i + "s conn=" + $conn + " childApi=" + $(if ($o) { $cid } else { "-" }) + " err=" + $err)
}
Say ("sessions AFTER: [" + ([string]::Join("] [", [PA]::All())) + "]")

# did a real logon happen in the last 2 minutes?
try {
  $since = (Get-Date).AddMinutes(-3)
  $ev = Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 60 -ErrorAction SilentlyContinue |
        Where-Object { $_.TimeCreated -gt $since -and ($_.Id -eq 21 -or $_.Id -eq 41) }
  if ($ev) { foreach ($e in ($ev | Sort-Object TimeCreated)) { Say ("  [EVENT] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " id=" + $e.Id + " " + (($e.Message -replace "`r`n",' | ').Substring(0,[Math]::Min(90,($e.Message -replace "`r`n",' | ').Length)))) } }
  else { Say "  [EVENT] 最近 3 分钟没有任何 logon(21)/arbitration(41) 事件 -> 登录没有完成" }
} catch { Say ("event query failed: " + $_.Exception.Message) }
try {
  Say "  [CLIENT LOG tail]"
  Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-RDPClient/Operational' -MaxEvents 5 -ErrorAction SilentlyContinue |
    Sort-Object TimeCreated | ForEach-Object { Say ("    " + $_.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " id=" + $_.Id + " " + (($_.Message -replace "`r`n",' ').Substring(0,[Math]::Min(120,($_.Message -replace "`r`n",' ').Length)))) }
} catch {}

try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
$cid2 = [uint32]0
if ([PA]::WTSGetChildSessionId([ref]$cid2) -and $cid2 -ne 4294967295) { [void][PA]::WTSLogoffSession([IntPtr]::Zero, $cid2, $false); Say ("logged off child " + $cid2) }
try { $form.Close(); $form.Dispose() } catch {}
$pwd = $null
Say ("report: " + $report)
