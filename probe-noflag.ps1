# probe-noflag.ps1 -- the combination never tried before, based on Doubao's observed behaviour:
#   * do NOT set ConnectToChildSession        (Doubao's connection went over TCP to the listener)
#   * Server = localhost, UserName, password via the non-scriptable vtable
#   * AuthenticationLevel = 0                 (the loopback listener presents the MACHINE cert)
#   * CredSSP on
# Safety: watches the console session every 2 s and immediately runs `tscon 1 /dest:console`
# if it stops being Active (a normal RDP loopback could try to take the console over).
# Verdict: session list + TerminalServices logon event. ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$AuthLevel = 0,
  [int]$WaitSec = 18,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('noflag-' + (Get-Date -Format 'HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class PN
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
    public static string ConsoleState() { foreach (string s in All()) { string[] a = s.Split('|'); if (a.Length > 2 && a[0] == "1") return a[2]; } return "?"; }

    public static readonly Guid IID_Adv = new Guid("3c65b4ab-12b3-465b-acd4-b8dad3bff9e2");

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutBstrFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutUlongFn(IntPtr pThis, uint value);

    public static IntPtr Qi(object o, Guid iid, out int hr) { IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk); return hr == 0 ? p : IntPtr.Zero; }
    public static IntPtr Slot(IntPtr p, int slot) { IntPtr vt = Marshal.ReadIntPtr(p); return Marshal.ReadIntPtr(vt, IntPtr.Size * slot); }
    public static PutBstrFn FnBstr(IntPtr p, int s) { return (PutBstrFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBstrFn)); }
    public static PutUlongFn FnUlong(IntPtr p, int s) { return (PutUlongFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutUlongFn)); }

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
public class PNAx : AxHost { public PNAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$pwd = [PN]::ReadPwd($CredTarget)
if (-not $pwd) { Say "no credential"; return }
Say ("credential ok (" + $pwd.Length + " chars); console=" + [PN]::ConsoleState() + " childCount=" + [PN]::ChildCount())

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3200, -3200; $form.Size = New-Object Drawing.Size 110, 85; $form.Opacity = 0.01
$ax = New-Object PNAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax); $form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 700
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
  $hrA = 0; $pAdv = [PN]::Qi($adv, [PN]::IID_Adv, [ref]$hrA)
  if ($pAdv -ne [IntPtr]::Zero) {
    $put = [PN]::FnBstr($pAdv, 112); $r1 = $put.Invoke($pAdv, $pwd); Say ("  vtable ClearTextPassword hr=0x" + $r1.ToString('X8'))
    $putAl = [PN]::FnUlong($pAdv, 147); $r2 = $putAl.Invoke($pAdv, [uint32]$AuthLevel)
    Say ("  vtable AuthenticationLevel(slot147)=" + $AuthLevel + " hr=0x" + $r2.ToString('X8'))
    [void][Runtime.InteropServices.Marshal]::Release($pAdv)
  }
  try { $adv.GetType().InvokeMember('AuthenticationLevel',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($AuthLevel)) | Out-Null; Say "  dispatch AuthenticationLevel set" } catch { Say ("  dispatch authLevel failed: " + $_.Exception.InnerException.Message) }
}
Say "  NOTE: ConnectToChildSession is deliberately NOT set"
Say "calling Connect() ..."
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Say ("  Connect threw: " + $_.Exception.InnerException.Message) }

$restored = $false
for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $cs2 = [PN]::ConsoleState()
  $conn = ''; try { $conn = $ocx.GetType().InvokeMember('Connected',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
  $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,@(0,0)) } catch {}
  Say ("  t=+" + $i + "s conn=" + $conn + " console=" + $cs2 + " childCount=" + [PN]::ChildCount() + " err=" + $err)
  if ($cs2 -ne "s0") {
    Say "  !! console is no longer Active -> running tscon 1 /dest:console"
    & cmd /c "tscon 1 /dest:console" 2>&1 | Out-Null
    $restored = $true
    Start-Sleep -Seconds 2
    Say ("  console after restore = " + [PN]::ConsoleState())
    break
  }
  if ([PN]::ChildCount() -gt 0) { Say "  *** CHILD SESSION APPEARED ***"; break }
}
Say ("sessions: [" + ([string]::Join("] [", [PN]::All())) + "]")
Say ("console restored = " + $restored)
try {
  $since = (Get-Date).AddMinutes(-3)
  $ev = Get-WinEvent -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -MaxEvents 60 -ErrorAction SilentlyContinue |
        Where-Object { $_.TimeCreated -gt $since -and $_.Id -eq 21 }
  if ($ev) { foreach ($e in $ev) { Say ("  [EVENT logon] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " " + (($e.Message -replace "`r`n",' | ').Substring(0,[Math]::Min(70,($e.Message -replace "`r`n",' | ').Length)))) } }
  else { Say "  [EVENT] 最近 3 分钟没有 logon 事件" }
} catch {}
try { $ocx.GetType().InvokeMember('Disconnect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
try { $form.Close(); $form.Dispose() } catch {}
$pwd = $null
Say ("report: " + $report)
