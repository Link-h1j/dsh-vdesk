# child-session-matrix4.ps1 -- same setup, but try the three CLSIDs that the IMsRdpExtendedSettings
# documentation lists (MsRdpClient7/8/9 NotSafeForScripting). Maybe the newer control dropped
# child-session support.
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$WaitSec = 9,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('matrix4-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$helper = @'
using System; using System.Runtime.InteropServices;
public static class M4
{
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32.dll", SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);
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
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL c, uint f);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string t, uint ty, uint f);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
    public static string ReadPwd(string target, out string user) { user = null; IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p)) return null;
        try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); user = c.UserName;
              if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
              return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2)); } finally { CredFree(p); } }
    public static int WritePwd(string target, string user, string pwd) {
        byte[] b = System.Text.Encoding.Unicode.GetBytes(pwd);
        IntPtr blob = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, blob, b.Length);
        CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user;
        c.CredentialBlob = blob; c.CredentialBlobSize = (uint)b.Length; c.Persist = 2;
        bool ok = CredWrite(ref c, 0); int err = Marshal.GetLastWin32Error();
        for (int i=0;i<b.Length;i++) Marshal.WriteByte(blob, i, 0);
        Marshal.FreeHGlobal(blob); return ok ? 0 : err; }
}
'@
try { Add-Type -TypeDefinition $helper -Language CSharp -ErrorAction Stop } catch { Say ("helper Add-Type failed: " + $_.Exception.Message); return }

$storedUser = ''
$pwd = [M4]::ReadPwd($CredTarget, [ref]$storedUser)
if (-not $pwd) { Say "no stored credential"; return }
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1') { [void][M4]::WritePwd($t, 'MicrosoftAccount\1010930312@qq.com', $pwd) }

$variants = @(
  @{ label = 'C7  MsRdpClient7NotSafeForScripting'; clsid = '54d38bf7-b1ef-4479-9674-1bd6ea465258'; cls = 'AxC7' },
  @{ label = 'C8  MsRdpClient8NotSafeForScripting'; clsid = 'a3bc03a0-041d-42e3-ad22-882b7865c9c5'; cls = 'AxC8' },
  @{ label = 'C9  MsRdpClient9NotSafeForScripting'; clsid = '8b918b82-7985-4c24-89df-c33ad2bbfbcd'; cls = 'AxC9' },
  @{ label = 'C11 redistributable v11';             clsid = 'c0efa91a-eeb7-41c7-97fa-f0ed645efb24'; cls = 'AxC11' }
)

$anyOk = $false
foreach ($v in $variants) {
  Say ""
  Say ("===== " + $v.label + "  clsid=" + $v.clsid + " =====")
  $src = @"
using System.Windows.Forms;
public class $($v.cls) : AxHost { public $($v.cls)() : base("$($v.clsid)") { } }
"@
  try { Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies System.Windows.Forms -ErrorAction Stop }
  catch { Say ("  Add-Type failed: " + $_.Exception.Message); continue }

  $form = New-Object System.Windows.Forms.Form
  $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
  $t = [Type]$v.cls
  $ax = [Activator]::CreateInstance($t)
  $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
  Start-Sleep -Milliseconds 700
  $ocx = $ax.GetOcx()
  if (-not $ocx) { Say "  no OCX -> skip"; $form.Close(); $form.Dispose(); continue }
  Say ("  OCX created: " + $ocx.GetType().FullName)
  $p = [M4]::Qi($ocx)
  if ($p -eq [IntPtr]::Zero) { Say "  no IMsRdpExtendedSettings -> skip"; $form.Close(); $form.Dispose(); continue }
  try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('1010930312@qq.com')) | Out-Null
        $ocx.GetType().InvokeMember('Domain',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount')) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1024)) | Out-Null
        $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(768)) | Out-Null } catch {}
  $advName = 'AdvancedSettings7'
  try { $adv = $ocx.GetType().InvokeMember($advName,[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch { $adv = $null; Say ("  no " + $advName) }
  if (-not $adv) { try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings2',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {} }
  if ($adv) {
    try { $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null } catch {}
    try { $adv.ClearTextPassword = $pwd } catch { Say ("  ClearTextPassword failed: " + $_.Exception.InnerException.Message) }
    try { $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::SetProperty,$null,$adv,@(0)) | Out-Null } catch {}
  }
  $put = [M4]::Fn($p, 3); $val = [M4+VARIANT]::Bool($true)
  $hr = $put.Invoke($p, 'ConnectToChildSession', [ref]$val)
  $get = [M4]::Fn($p, 4); $back = New-Object M4+VARIANT
  $hr2 = $get.Invoke($p, 'ConnectToChildSession', [ref]$back)
  Say ("  ConnectToChildSession put hr=0x" + $hr.ToString('X8') + " get hr=0x" + $hr2.ToString('X8') + " val=" + $back.bVal)
  [void][Runtime.InteropServices.Marshal]::Release($p)
  try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }
  $found = [uint32]0
  for ($i=1; $i -le $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    $cid = [uint32]0; $o = [M4]::WTSGetChildSessionId([ref]$cid)
    $ui = (Get-Process -Name CredentialUIBroker -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($o -and $cid -ne 4294967295) { $found = $cid; break }
  }
  $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
  Say ("  final: conn=" + $conn + " child=" + $found + " credUI=" + $ui + " err=" + $err)
  try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
  if ($found -ne 0) { $anyOk = $true; Say ("  *** CHILD SESSION " + $found + " CREATED ***"); [void][M4]::WTSLogoffSession([IntPtr]::Zero, $found, $false) }
  try { $form.Close(); $form.Dispose() } catch {}
  Start-Sleep -Seconds 1
}
Say ""
Say ("=== MATRIX4 RESULT: " + $(if ($anyOk) { 'one CLSID CREATED a child session' } else { 'none worked' }) + " ===")
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1') { [void][M4]::CredDelete($t, 1, 0) }
$pwd = $null
Say ("report: " + $report)
