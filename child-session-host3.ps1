# child-session-host3.ps1 -- DSH R3 prototype, step 3.
# Difference from host2: the RDP ActiveX control is now properly HOSTED inside a (hidden)
# WinForms window via System.Windows.Forms.AxHost, so Windows Forms provides the OLE
# client-site / in-place-activation plumbing the control needs.
# ConnectToChildSession is still set through the raw IMsRdpExtendedSettings vtable call,
# because the managed ComImport cast refuses to QI (raw QI succeeds).
# ASCII only.

param(
  [string]$Server = 'localhost',
  [int]$Width = 1280,
  [int]$Height = 800,
  [int]$WaitSec = 20,
  [string]$UserName = 'MicrosoftAccount\1010930312@qq.com',
  [string]$Domain = '',
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [switch]$KeepAlive,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('child-session3-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

Say ("PowerShell apartment = " + [Threading.Thread]::CurrentThread.GetApartmentState())

$cs = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class CsHost3
{
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSIsChildSessionsEnabled(out bool b);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr h, uint id, int cls, out IntPtr buf, out uint len);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static readonly Guid IID_IMsRdpExtendedSettings = new Guid("302D8188-0052-4807-806A-362B628F9AC5");
    public const ushort VT_BOOL = 11;

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct VARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort r1;
        [FieldOffset(4)] public ushort r2;
        [FieldOffset(6)] public ushort r3;
        [FieldOffset(8)] public short bVal;
        [FieldOffset(8)] public long llVal;
        [FieldOffset(8)] public IntPtr ptr;
        public static VARIANT Bool(bool v) { VARIANT x = new VARIANT(); x.vt = VT_BOOL; x.bVal = (short)(v ? -1 : 0); return x; }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PropertyFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string name, ref VARIANT val);

    public static IntPtr Qi(object o, Guid iid, out int hr)
    {
        IntPtr unk = Marshal.GetIUnknownForObject(o); IntPtr p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk);
        return hr == 0 ? p : IntPtr.Zero;
    }
    public static PropertyFn Fn(IntPtr p, int slot)
    {
        IntPtr v = Marshal.ReadIntPtr(p);
        return (PropertyFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(v, IntPtr.Size * slot), typeof(PropertyFn));
    }
    public static string WinStationName(uint id)
    {
        IntPtr buf; uint len;
        if (WTSQuerySessionInformation(IntPtr.Zero, id, 6, out buf, out len) && buf != IntPtr.Zero)
        { string s = Marshal.PtrToStringUni(buf); WTSFreeMemory(buf); return s; }
        return "(err=" + Marshal.GetLastWin32Error() + ")";
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags; public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buf);

    // returns the password read from the Credential Manager, or null
    public static string ReadStoredPassword(string target, out string user)
    {
        user = null;
        IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p)) return null;
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            user = c.UserName;
            if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
            return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2));
        }
        finally { CredFree(p); }
    }
}

// CLSID 8b918b82-7985-4c24-89df-c33ad2bbfbcd = Microsoft RDP Client Control (v10 on this box)
public class RdpAx : AxHost
{
    public RdpAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { }
}
'@

try {
  Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop
  Say "Add-Type ok"
} catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$en = $false; $null = [CsHost3]::WTSIsChildSessionsEnabled([ref]$en)
Say ("child sessions enabled = " + $en + " ; session = " + (Get-Process -Id $PID).SessionId)

# ---- host the control in an off-screen form ----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsh-childsession-host'
$form.ShowInTaskbar = $false
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point -3000, -3000
$form.Size = New-Object Drawing.Size 200, 150
$form.Opacity = 0.01
$ax = New-Object RdpAx
$ax.Dock = 'Fill'
$form.Controls.Add($ax)
# create handles WITHOUT showing/activating the window (avoids stealing the user's focus)
$form.CreateControl()
$ax.CreateControl()
Start-Sleep -Milliseconds 900
$ocx = $ax.GetOcx()
if (-not $ocx) {
  Say "CreateControl() without Show() did not produce an OCX -> falling back to Show()"
  $form.Show()
  [void]$form.Handle
  $ax.CreateControl()
  Start-Sleep -Milliseconds 900
  $ocx = $ax.GetOcx()
}
Say ("control hosted; GetOcx -> " + $(if ($ocx) { $ocx.GetType().FullName } else { 'null' }))

$hr = 0
$pExt = [CsHost3]::Qi($ocx, [CsHost3]::IID_IMsRdpExtendedSettings, [ref]$hr)
Say ("raw QI IMsRdpExtendedSettings hr=0x" + $hr.ToString('X8'))

function Prop($name, $val) { try { $ocx.GetType().InvokeMember($name, [Reflection.BindingFlags]::SetProperty, $null, $ocx, @($val)) | Out-Null; Say ("  put_" + $name + " = " + $val) } catch { Say ("  put_" + $name + " FAILED: " + $_.Exception.InnerException.Message) } }

# Doubao's order: Server first, then credentials policy, then the child-session flag, then Connect.
Prop 'Server' $Server
Prop 'DesktopWidth' $Width
Prop 'DesktopHeight' $Height
try {
  $adv = $ocx.GetType().InvokeMember('AdvancedSettings7', [Reflection.BindingFlags]::GetProperty, $null, $ocx, $null)
  $adv.GetType().InvokeMember('EnableCredSspSupport', [Reflection.BindingFlags]::SetProperty, $null, $adv, @($true)) | Out-Null
  Say ("  AdvancedSettings7.EnableCredSspSupport = " + $adv.GetType().InvokeMember('EnableCredSspSupport', [Reflection.BindingFlags]::GetProperty, $null, $adv, $null))
} catch { Say ("  credssp failed: " + $_.Exception.InnerException.Message) }
try {
  $ocx.GetType().InvokeMember('AllowPromptingForCredentials', [Reflection.BindingFlags]::SetProperty, $null, $ocx, @($false)) | Out-Null
  Say "  AllowPromptingForCredentials = False"
} catch { Say ("  AllowPromptingForCredentials not settable: " + $_.Exception.InnerException.Message) }

Prop 'UserName' $UserName
if ($Domain) { Prop 'Domain' $Domain }

$storedUser = ''
$pw = [CsHost3]::ReadStoredPassword($CredTarget, [ref]$storedUser)
if ($pw) {
  Say ("  credential '" + $CredTarget + "' found (stored user='" + $storedUser + "', " + $pw.Length + " chars)")
  try {
    $adv.ClearTextPassword = $pw
    Say "  AdvancedSettings7.ClearTextPassword = SET (password never printed)"
  } catch { Say ("  ClearTextPassword failed: " + $_.Exception.InnerException.Message) }
} else {
  Say ("  NO stored credential named '" + $CredTarget + "' -> Windows will prompt for credentials")
}
$pw = $null

$setOk = $false
if ($pExt -ne [IntPtr]::Zero) {
  $put = [CsHost3]::Fn($pExt, 3); $get = [CsHost3]::Fn($pExt, 4)
  $v = [CsHost3+VARIANT]::Bool($true)
  $hrPut = $put.Invoke($pExt, 'ConnectToChildSession', [ref]$v)
  $back = New-Object CsHost3+VARIANT
  $hrGet = $get.Invoke($pExt, 'ConnectToChildSession', [ref]$back)
  $setOk = ($hrGet -eq 0 -and $back.vt -eq 11 -and $back.bVal -ne 0)
  Say ("put_Property hr=0x" + $hrPut.ToString('X8') + " get_Property hr=0x" + $hrGet.ToString('X8') + " value=" + $back.bVal + " -> set=" + $setOk)
  [void][Runtime.InteropServices.Marshal]::Release($pExt)
}

$fgBefore = [CsHost3]::GetForegroundWindow()
Say "calling Connect() ..."
try { $ocx.GetType().InvokeMember('Connect', [Reflection.BindingFlags]::InvokeMethod, $null, $ocx, $null) | Out-Null; Say "Connect() returned" }
catch { Say ("Connect() FAILED: " + $_.Exception.InnerException.Message) }

$childId = [uint32]0
for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  [System.Windows.Forms.Application]::DoEvents()
  Push-Location | Out-Null; Pop-Location | Out-Null
  $cid = [uint32]0
  $o = [CsHost3]::WTSGetChildSessionId([ref]$cid)
  $conn = $null; try { $conn = $ocx.GetType().InvokeMember('Connected', [Reflection.BindingFlags]::GetProperty, $null, $ocx, $null) } catch {}
  $err = ''; try { $err = $ocx.GetType().InvokeMember('GetErrorDescription', [Reflection.BindingFlags]::InvokeMethod, $null, $ocx, @(0,0)) } catch {}
  $xr = ''; try { $xr = $ocx.GetType().InvokeMember('ExtendedDisconnectReason', [Reflection.BindingFlags]::GetProperty, $null, $ocx, $null) } catch {}
  $dt = ''; try { $dt = $ocx.GetType().InvokeMember('DisconnectedText', [Reflection.BindingFlags]::GetProperty, $null, $ocx, $null) } catch {}
  $sn = ''; try { $sn = $ocx.GetType().InvokeMember('ConnectedStatusText', [Reflection.BindingFlags]::GetProperty, $null, $ocx, $null) } catch {}
  Say ("  t=+" + $i + "s Connected=" + $conn + " childSessionId=" + $cid + " extReason=" + $xr + " status='" + $sn + "' disconnectedText='" + $dt + "' errDesc=" + $err)
  if ($o -and $cid -ne 4294967295) { $childId = $cid; break }
}
Say ("foreground window changed = " + ([CsHost3]::GetForegroundWindow() -ne $fgBefore))
Say ("qwinsta: " + ((& qwinsta 2>&1 | Out-String) -replace "`r?`n", ' | ').Trim())

Say "--- VERDICT ---"
if ($childId -ne 0) { Say ("CHILD SESSION CREATED id=" + $childId + " -> R3 mechanism CONFIRMED on this machine") } else { Say "no child session created" }

if (-not $KeepAlive) {
  try { $ocx.GetType().InvokeMember('Disconnect', [Reflection.BindingFlags]::InvokeMethod, $null, $ocx, $null) | Out-Null; Say "Disconnect() ok" } catch { Say ("Disconnect failed: " + $_.Exception.InnerException.Message) }
  if ($childId -ne 0) { Start-Sleep -Seconds 2; $lo = [CsHost3]::WTSLogoffSession([IntPtr]::Zero, $childId, $false); Say ("WTSLogoffSession(" + $childId + ")=" + $lo) }
}
try { $form.Close(); $form.Dispose() } catch {}
Say ("report: " + $report)
