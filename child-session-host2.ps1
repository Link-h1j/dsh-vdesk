# child-session-host2.ps1 -- DSH R3 prototype, step 2.
# Same goal as child-session-host.ps1, but sets ConnectToChildSession by calling the
# IMsRdpExtendedSettings vtable DIRECTLY (raw QI + function pointer + hand-built VARIANT),
# because the managed ComImport cast refused to QI even though a raw QI succeeds.
#
# ASCII only.

param(
  [string]$Server = '127.0.0.1',
  [int]$Width = 1920,
  [int]$Height = 1080,
  [int]$WaitSec = 20,
  [switch]$KeepAlive,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('child-session2-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class CsHost
{
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSIsChildSessionsEnabled(out bool b);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSLogoffSession(IntPtr h, uint id, bool wait);
    [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr h, uint id, int cls, out IntPtr buf, out uint len);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);

    public static readonly Guid IID_IMsRdpExtendedSettings = new Guid("302D8188-0052-4807-806A-362B628F9AC5");
    public const ushort VT_BOOL = 11;
    public const ushort VT_EMPTY = 0;

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

    // returns the raw QI'd pointer for the interface, or IntPtr.Zero
    public static IntPtr Qi(object comObj, Guid iid, out int hr)
    {
        IntPtr unk = Marshal.GetIUnknownForObject(comObj);
        IntPtr p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p);
        Marshal.Release(unk);
        if (hr != 0) return IntPtr.Zero;
        return p;
    }

    public static PropertyFn GetFn(IntPtr pExt, int slotIndex)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(pExt);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, IntPtr.Size * slotIndex);
        return (PropertyFn)Marshal.GetDelegateForFunctionPointer(fn, typeof(PropertyFn));
    }

    public static string WinStationName(uint id)
    {
        IntPtr buf; uint len;
        if (WTSQuerySessionInformation(IntPtr.Zero, id, 6, out buf, out len) && buf != IntPtr.Zero)
        { string s = Marshal.PtrToStringUni(buf); WTSFreeMemory(buf); return s; }
        return "(winsta query err=" + Marshal.GetLastWin32Error() + ")";
    }
}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

$en = $false; $null = [CsHost]::WTSIsChildSessionsEnabled([ref]$en)
Say ("child sessions enabled = " + $en + " ; this process session = " + (Get-Process -Id $PID).SessionId)

$clsid = [Guid]'8B918B82-7985-4C24-89DF-C33AD2BBFBCD'   # Microsoft RDP Client Control (v10 per registry)
$t = [Type]::GetTypeFromCLSID($clsid)
$ax = [Activator]::CreateInstance($t)
Say ("RDP ActiveX created: " + $ax.GetType().FullName)

function Prop($name, $val) { try { $ax.GetType().InvokeMember($name, [Reflection.BindingFlags]::SetProperty, $null, $ax, @($val)) | Out-Null; Say ("  put_" + $name + " = " + $val) } catch { Say ("  put_" + $name + " FAILED: " + $_.Exception.InnerException.Message) } }

# ---- raw QI + direct vtable call ----
$hr = 0
$pExt = [CsHost]::Qi($ax, [CsHost]::IID_IMsRdpExtendedSettings, [ref]$hr)
Say ("raw QI IMsRdpExtendedSettings: hr=0x" + $hr.ToString('X8') + " ptr=0x" + $pExt.ToString('X'))
$setOk = $false
if ($pExt -ne [IntPtr]::Zero) {
  for ($order = 0; $order -lt 2 -and -not $setOk; $order++) {
    $putSlot = if ($order -eq 0) { 3 } else { 4 }
    $getSlot = if ($order -eq 0) { 4 } else { 3 }
    try {
      $put = [CsHost]::GetFn($pExt, $putSlot)
      $get = [CsHost]::GetFn($pExt, $getSlot)
      $v = [CsHost+VARIANT]::Bool($true)
      $hrPut = $put.Invoke($pExt, 'ConnectToChildSession', [ref]$v)
      $back = New-Object CsHost+VARIANT
      $hrGet = $get.Invoke($pExt, 'ConnectToChildSession', [ref]$back)
      $val = if ($back.vt -eq 11) { ($back.bVal -ne 0) } else { "vt=" + $back.vt }
      Say ("  order#" + $order + " put(slot " + $putSlot + ") hr=0x" + $hrPut.ToString('X8') + "  get(slot " + $getSlot + ") hr=0x" + $hrGet.ToString('X8') + " -> " + $val)
      if ($hrGet -eq 0 -and $val -eq $true) { $setOk = $true; Say "  => ConnectToChildSession is SET and read back TRUE" }
    } catch { Say ("  order#" + $order + " threw: " + $_.Exception.Message) }
  }
  [void][Runtime.InteropServices.Marshal]::Release($pExt)
}
Say ("ConnectToChildSession set = " + $setOk)

Prop 'Server' $Server
Prop 'DesktopWidth' $Width
Prop 'DesktopHeight' $Height

# Community solution (SO 31670504 / 66120466): a child session needs CredSSP enabled on the client.
foreach ($advName in 'AdvancedSettings7','AdvancedSettings9','AdvancedSettings2') {
  try {
    $adv = $ax.GetType().InvokeMember($advName, [Reflection.BindingFlags]::GetProperty, $null, $ax, $null)
    if ($adv) {
      $adv.GetType().InvokeMember('EnableCredSspSupport', [Reflection.BindingFlags]::SetProperty, $null, $adv, @($true)) | Out-Null
      $back = $adv.GetType().InvokeMember('EnableCredSspSupport', [Reflection.BindingFlags]::GetProperty, $null, $adv, $null)
      Say ("  " + $advName + ".EnableCredSspSupport = " + $back + " (set)")
      break
    }
  } catch { Say ("  " + $advName + " failed: " + $_.Exception.InnerException.Message) }
}

Say "calling Connect() ..."
try { $ax.GetType().InvokeMember('Connect', [Reflection.BindingFlags]::InvokeMethod, $null, $ax, $null) | Out-Null; Say "Connect() returned" }
catch { Say ("Connect() FAILED: " + $_.Exception.InnerException.Message) }

$childId = [uint32]0
for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $cid = [uint32]0
  $o = [CsHost]::WTSGetChildSessionId([ref]$cid)
  $conn = $null; try { $conn = $ax.GetType().InvokeMember('Connected', [Reflection.BindingFlags]::GetProperty, $null, $ax, $null) } catch {}
  $err = ''; try { $err = $ax.GetType().InvokeMember('GetErrorDescription', [Reflection.BindingFlags]::InvokeMethod, $null, $ax, @(0,0)) } catch {}
  Say ("  t=+" + $i + "s Connected=" + $conn + " childSessionId=" + $cid + " errDesc=" + $err)
  if ($o -and $cid -ne 4294967295) { $childId = $cid; break }
}
Say ("qwinsta: " + ((& qwinsta 2>&1 | Out-String) -replace "`r?`n", ' | ').Trim())

Say "--- VERDICT ---"
if ($childId -ne 0) { Say ("CHILD SESSION CREATED id=" + $childId + " -> R3 mechanism CONFIRMED") } else { Say "no child session created" }

if (-not $KeepAlive) {
  try { $ax.GetType().InvokeMember('Disconnect', [Reflection.BindingFlags]::InvokeMethod, $null, $ax, $null) | Out-Null; Say "Disconnect() ok" } catch { Say ("Disconnect failed: " + $_.Exception.InnerException.Message) }
  if ($childId -ne 0) { Start-Sleep -Seconds 2; $lo = [CsHost]::WTSLogoffSession([IntPtr]::Zero, $childId, $false); Say ("WTSLogoffSession(" + $childId + ")=" + $lo + " err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
}
try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ax) } catch {}
Say ("report: " + $report)
