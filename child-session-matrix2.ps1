# child-session-matrix2.ps1 -- the credential is known-good (LogonUser passes).
# Now find the (credential storage + account spelling) combination the RDP control accepts.
#   * writes the password to TERMSRV/localhost (the name the RDP stack actually looks up)
#   * tries several UserName/Domain spellings, each with ClearTextPassword set
#   * aborts a variant the moment a Windows credential dialog appears
#   * removes the TERMSRV/localhost entry at the end
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$WaitSec = 10,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('matrix2-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class M2
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
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t, uint ty, uint f, out IntPtr p);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL c, uint f);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string t, uint ty, uint f);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);

    public static string ReadPwd(string target, out string user) {
        user = null; IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p)) return null;
        try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); user = c.UserName;
              if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
              return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2)); }
        finally { CredFree(p); } }

    public static int WritePwd(string target, string user, string pwd) {
        byte[] b = System.Text.Encoding.Unicode.GetBytes(pwd);
        IntPtr blob = Marshal.AllocHGlobal(b.Length);
        Marshal.Copy(b, 0, blob, b.Length);
        CREDENTIAL c = new CREDENTIAL();
        c.Type = 1; c.TargetName = target; c.UserName = user; c.CredentialBlob = blob;
        c.CredentialBlobSize = (uint)b.Length; c.Persist = 2;
        bool ok = CredWrite(ref c, 0); int err = Marshal.GetLastWin32Error();
        for (int i=0;i<b.Length;i++) Marshal.WriteByte(blob, i, 0);
        Marshal.FreeHGlobal(blob);
        return ok ? 0 : err; }
}
public class M2Ax : AxHost { public M2Ax() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$storedUser = ''
$pwd = [M2]::ReadPwd($CredTarget, [ref]$storedUser)
if (-not $pwd) { Say "no stored credential"; return }
Say ("password loaded (" + $pwd.Length + " chars) from '" + $CredTarget + "'")

# put it where the RDP stack looks
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1') {
  $e = [M2]::WritePwd($t, 'MicrosoftAccount\1010930312@qq.com', $pwd)
  Say ("  credstore <- " + $t + " (win32=" + $e + ")")
}

$machine = $env:COMPUTERNAME

function Run-Variant($label, $user, $domain) {
  Say ""
  Say ("===== " + $label + "  (user='" + $user + "' domain='" + $domain + "') =====")
  $form = New-Object System.Windows.Forms.Form
  $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
  $ax = New-Object M2Ax; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
  Start-Sleep -Milliseconds 600
  $ocx = $ax.GetOcx()
  if (-not $ocx) { Say "  no OCX"; $form.Close(); $form.Dispose(); return $false }
  try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1024)) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(768)) | Out-Null } catch {}
  if ($user) { try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($user)) | Out-Null } catch { Say ("  UserName fail: " + $_.Exception.InnerException.Message) } }
  if ($domain) { try { $ocx.GetType().InvokeMember('Domain',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($domain)) | Out-Null } catch { Say ("  Domain fail: " + $_.Exception.InnerException.Message) } }
  $adv = $null
  try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
        $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null
        $adv.ClearTextPassword = $pwd
        # loopback self-signed cert: do not require server authentication
        try { $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::SetProperty,$null,$adv,@(0)) | Out-Null
              $al = $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::GetProperty,$null,$adv,$null)
              Say ("  AuthenticationLevel = " + $al) } catch { Say ("  AuthenticationLevel failed: " + $_.Exception.InnerException.Message) }
        Say "  credssp=on, ClearTextPassword=set"
  } catch { Say ("  advsettings fail: " + $_.Exception.InnerException.Message) }
  $p = [M2]::Qi($ocx)
  if ($p -ne [IntPtr]::Zero) { $put = [M2]::Fn($p, 3); $v = [M2+VARIANT]::Bool($true)
    $hr = $put.Invoke($p, 'ConnectToChildSession', [ref]$v); Say ("  ConnectToChildSession hr=0x" + $hr.ToString('X8'))
    [void][Runtime.InteropServices.Marshal]::Release($p) }
  try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }
  $found = [uint32]0
  for ($i = 1; $i -le $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    $ui = (Get-Process -Name CredentialUIBroker -ErrorAction SilentlyContinue | Measure-Object).Count
    $cid = [uint32]0; $o = [M2]::WTSGetChildSessionId([ref]$cid)
    $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
    Say ("  t=+" + $i + "s conn=" + $conn + " child=" + $cid + " credUI=" + $ui)
    if ($o -and $cid -ne 4294967295) { $found = $cid; break }
    if ($ui -gt 0) { Say "  !! prompt appeared -> abort variant"; break }
  }
  try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
  if ($found -ne 0) { Say ("  *** CHILD SESSION " + $found + " CREATED ***"); [void][M2]::WTSLogoffSession([IntPtr]::Zero, $found, $false) }
  try { $form.Close(); $form.Dispose() } catch {}
  Start-Sleep -Seconds 1
  return ($found -ne 0)
}

$ok = $false
if (-not $ok) { $ok = Run-Variant 'V1 msa-split'      '1010930312@qq.com' 'MicrosoftAccount' }
if (-not $ok) { $ok = Run-Variant 'V2 machine-admin'  'Administrator' $machine }
if (-not $ok) { $ok = Run-Variant 'V3 bare-admin'     'Administrator' '' }
if (-not $ok) { $ok = Run-Variant 'V4 no-user'        '' '' }

Say ""
Say ("=== MATRIX2 RESULT: " + $(if ($ok) { 'one variant CREATED the child session' } else { 'none worked' }) + " ===")
Say "--- cleanup ---"
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1') { $d = [M2]::CredDelete($t, 1, 0); Say ("  delete " + $t + " -> " + $d) }
$pwd = $null
Say ("report: " + $report)
