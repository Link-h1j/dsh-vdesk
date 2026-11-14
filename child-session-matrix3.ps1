# child-session-matrix3.ps1 -- vary (Server name, AuthenticationLevel) and read the RDP client/server
# event logs after EVERY variant, so we can see exactly where it dies.
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$WaitSec = 9,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('matrix3-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$script:cs = @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class M3
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
public class M3Ax : AxHost { public M3Ax() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $script:cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$storedUser = ''
$pwd = [M3]::ReadPwd($CredTarget, [ref]$storedUser)
if (-not $pwd) { Say "no stored credential"; return }
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1',('TERMSRV/' + $env:COMPUTERNAME)) {
  $e = [M3]::WritePwd($t, 'MicrosoftAccount\1010930312@qq.com', $pwd); Say ("  credstore <- " + $t + " win32=" + $e)
}

function DumpLogs($tag) {
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-RDPClient/Operational' -MaxEvents 6 -ErrorAction Stop |
      Sort-Object TimeCreated | ForEach-Object { Say ("    [cli] {0:HH:mm:ss} id={1} {2}" -f $_.TimeCreated.ToLocalTime(), $_.Id, (($_.Message -replace "`r`n",' ').Substring(0,[Math]::Min(110,($_.Message -replace "`r`n",' ').Length)))) }
  } catch { Say ("    [cli] log error " + $_.Exception.Message) }
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational' -MaxEvents 4 -ErrorAction Stop |
      Sort-Object TimeCreated | ForEach-Object { Say ("    [srv] {0:HH:mm:ss} id={1} {2}" -f $_.TimeCreated.ToLocalTime(), $_.Id, (($_.Message -replace "`r`n",' ').Substring(0,[Math]::Min(110,($_.Message -replace "`r`n",' ').Length)))) }
  } catch { }
}

function Run-Variant($label, $server, $authLevel, $user, $domain) {
  Say ""
  Say ("===== " + $label + "  server='" + $server + "' authLevel=" + $authLevel + " user='" + $user + "' =====")
  $form = New-Object System.Windows.Forms.Form
  $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
  $ax = New-Object M3Ax; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
  Start-Sleep -Milliseconds 600
  $ocx = $ax.GetOcx()
  if (-not $ocx) { Say "  no OCX"; $form.Close(); $form.Dispose(); return $false }
  try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($server)) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1024)) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(768)) | Out-Null } catch {}
  if ($user) { try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($user)) | Out-Null } catch {} }
  if ($domain) { try { $ocx.GetType().InvokeMember('Domain',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($domain)) | Out-Null } catch {} }
  try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
        $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null
        $adv.ClearTextPassword = $pwd
        $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($authLevel)) | Out-Null
        Say ("  credssp=on authLevel=" + $authLevel + " password=set")
  } catch { Say ("  advsettings fail: " + $_.Exception.InnerException.Message) }
  $p = [M3]::Qi($ocx)
  if ($p -ne [IntPtr]::Zero) { $put = [M3]::Fn($p, 3); $v = [M3+VARIANT]::Bool($true)
    $hr = $put.Invoke($p, 'ConnectToChildSession', [ref]$v); Say ("  ConnectToChildSession hr=0x" + $hr.ToString('X8'))
    [void][Runtime.InteropServices.Marshal]::Release($p) }
  try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }
  $found = [uint32]0
  for ($i = 1; $i -le $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    $ui = (Get-Process -Name CredentialUIBroker -ErrorAction SilentlyContinue | Measure-Object).Count
    $cid = [uint32]0; $o = [M3]::WTSGetChildSessionId([ref]$cid)
    $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
    if ($i -eq $WaitSec -or ($o -and $cid -ne 4294967295) -or $ui -gt 0) { Say ("  t=+" + $i + "s conn=" + $conn + " child=" + $cid + " credUI=" + $ui) }
    if ($o -and $cid -ne 4294967295) { $found = $cid; break }
    if ($ui -gt 0) { Say "  !! prompt appeared"; break }
  }
  try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
  if ($found -ne 0) { Say ("  *** CHILD SESSION " + $found + " CREATED ***"); [void][M3]::WTSLogoffSession([IntPtr]::Zero, $found, $false) }
  try { $form.Close(); $form.Dispose() } catch {}
  Start-Sleep -Seconds 1
  DumpLogs $label
  return ($found -ne 0)
}

$machine = $env:COMPUTERNAME
$ok = $false
if (-not $ok) { $ok = Run-Variant 'W1 machine-name auth2' $machine 2 '1010930312@qq.com' 'MicrosoftAccount' }
if (-not $ok) { $ok = Run-Variant 'W2 machine-name auth0' $machine 0 '1010930312@qq.com' 'MicrosoftAccount' }
if (-not $ok) { $ok = Run-Variant 'W3 localhost   auth0' 'localhost' 0 '1010930312@qq.com' 'MicrosoftAccount' }
if (-not $ok) { $ok = Run-Variant 'W4 machine-name admin auth0' $machine 0 'Administrator' '' }

Say ""
Say ("=== MATRIX3 RESULT: " + $(if ($ok) { 'CREATED' } else { 'none worked' }) + " ===")
foreach ($t in 'TERMSRV/localhost','TERMSRV/127.0.0.1',('TERMSRV/' + $machine)) { $d = [M3]::CredDelete($t, 1, 0); Say ("  cleanup " + $t + " -> " + $d) }
$pwd = $null
Say ("report: " + $report)
