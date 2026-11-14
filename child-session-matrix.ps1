# child-session-matrix.ps1 -- try several control configurations WITHOUT any credential,
# to find one where the child session is created by auto-logon (no prompt).
# Every variant aborts immediately if a Windows credential dialog shows up.
# ASCII only.

param(
  [int]$WaitSec = 12,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('child-session-matrix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class Mx
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
    public static PropertyFn Fn(IntPtr p, int slot) {
        IntPtr v = Marshal.ReadIntPtr(p);
        return (PropertyFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(v, IntPtr.Size*slot), typeof(PropertyFn)); }
    public static IntPtr Qi(object o) {
        Guid iid = IID;
        IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        int hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk); return hr==0?p:IntPtr.Zero; }
}
public class MxAx : AxHost { public MxAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

function Run-Variant($label, $useCredSsp, $useUserName, $useServer, $userName) {
  Say ""
  Say ("========== VARIANT: " + $label + " (credssp=" + $useCredSsp + " user=" + $useUserName + " server=" + $useServer + ") ==========")
  $form = New-Object System.Windows.Forms.Form
  $form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 120, 90; $form.Opacity = 0.01
  $ax = New-Object MxAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
  Start-Sleep -Milliseconds 700
  $ocx = $ax.GetOcx()
  if (-not $ocx) { Say "  no OCX -> skip"; $form.Close(); $form.Dispose(); return $false }
  if ($useServer) { try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {} }
  try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(1024)) | Out-Null } catch {}
  try { $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@(768)) | Out-Null } catch {}
  if ($useUserName) { try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($userName)) | Out-Null; Say ("  UserName set to " + $userName) } catch { Say ("  UserName failed: " + $_.Exception.InnerException.Message) } }
  try {
    $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null)
    $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($useCredSsp)) | Out-Null
    Say ("  EnableCredSspSupport = " + $useCredSsp)
  } catch { Say ("  credssp failed: " + $_.Exception.InnerException.Message) }
  $p = [Mx]::Qi($ocx)
  if ($p -ne [IntPtr]::Zero) {
    $put = [Mx]::Fn($p, 3); $v = [Mx+VARIANT]::Bool($true)
    $hr = $put.Invoke($p, 'ConnectToChildSession', [ref]$v)
    Say ("  ConnectToChildSession put hr=0x" + $hr.ToString('X8'))
    [void][Runtime.InteropServices.Marshal]::Release($p)
  } else { Say "  QI failed"; }
  try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }

  $found = [uint32]0
  for ($i = 1; $i -le $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    $ui = (Get-Process -Name CredentialUIBroker -ErrorAction SilentlyContinue | Measure-Object).Count
    $cid = [uint32]0; $o = [Mx]::WTSGetChildSessionId([ref]$cid)
    $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
    $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
    Say ("  t=+" + $i + "s conn=" + $conn + " child=" + $cid + " credUI=" + $ui + " err=" + $err)
    if ($ui -gt 0) { Say "  !! credential prompt appeared -> aborting this variant"; break }
    if ($o -and $cid -ne 4294967295) { $found = $cid; break }
  }
  try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
  if ($found -ne 0) { Say ("  *** CHILD SESSION " + $found + " CREATED ***"); [void][Mx]::WTSLogoffSession([IntPtr]::Zero, $found, $false) }
  try { $form.Close(); $form.Dispose() } catch {}
  Start-Sleep -Seconds 1
  return ($found -ne 0)
}

$ok = $false
$ok = Run-Variant 'A no-credssp, no-user, server=localhost' $false $false $true ''
if (-not $ok) { $ok = Run-Variant 'B no-credssp, user=Administrator, server=localhost' $false $true $true 'Administrator' }
if (-not $ok) { $ok = Run-Variant 'C credssp, user local Administrator' $true $true $true 'Administrator' }
Say ""
Say "=== MATRIX RESULT: " + $(if ($ok) { 'a variant created the child session' } else { 'no variant worked without credentials' }) + " ==="
Say ("report: " + $report)
