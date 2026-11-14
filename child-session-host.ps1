# child-session-host.ps1 -- DSH R3 prototype, step 1:
# create a Windows CHILD SESSION with the in-box RDP ActiveX control (mstscax.dll)
# by setting IMsRdpExtendedSettings.Property("ConnectToChildSession", TRUE), then Connect().
#
# Why: docs say a child session is "a special loopback Remote Desktop session that is tied to a
# user's existing session" and that it can ONLY be created through the RDP ActiveX control.
# Plain mstsc cannot do this (verified: 0x708).
#
# Side effects: a NEW logon of the same user happens (so their Startup/Run items run once);
# the script always tries to log the child session off again at the end.
#
# ASCII ONLY (PowerShell 5.1 reads BOM-less files as ANSI/GBK).

param(
  [string]$Server = '127.0.0.1',
  [int]$Width  = 1920,
  [int]$Height = 1080,
  [int]$WaitSec = 25,
  [switch]$KeepAlive,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('child-session-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$lines.Add($s); [IO.File]::WriteAllLines($report, $lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

$cs = @'
using System;
using System.Runtime.InteropServices;

public class ChildSession
{
    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSEnableChildSessions(bool bEnable);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSIsChildSessionsEnabled(out bool pbEnabled);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSGetChildSessionId(out uint pSessionId);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSLogoffSession(IntPtr hServer, uint sessionId, bool bWait);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSQuerySessionInformation(IntPtr hServer, uint sessionId, int infoClass, out IntPtr ppBuffer, out uint pBytesReturned);
    [DllImport("wtsapi32.dll")]
    public static extern void WTSFreeMemory(IntPtr p);

    // The named-property bag that carries "ConnectToChildSession".
    [ComImport, Guid("302D8188-0052-4807-806A-362B628F9AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMsRdpExtendedSettings
    {
        [PreserveSig] int put_Property([MarshalAs(UnmanagedType.BStr)] string name, [MarshalAs(UnmanagedType.Struct)] ref object value);
        [PreserveSig] int get_Property([MarshalAs(UnmanagedType.BStr)] string name, [MarshalAs(UnmanagedType.Struct)] out object value);
    }

    public static string SessionName(uint id)
    {
        IntPtr buf; uint len;
        // WTSWinStationName = 6
        if (WTSQuerySessionInformation(IntPtr.Zero, id, 6, out buf, out len) && buf != IntPtr.Zero)
        {
            string s = Marshal.PtrToStringUni(buf);
            WTSFreeMemory(buf);
            return s;
        }
        return "(query failed err=" + Marshal.GetLastWin32Error() + ")";
    }

    public static object CreateRdpClient(out string usedProgId)
    {
        usedProgId = null;
        string[] progIds = new string[] {
            "MsRdpClient10NotSafeForScripting", "MsRdpClient9NotSafeForScripting",
            "MsRdpClient8NotSafeForScripting", "MsRdpClient11NotSafeForScripting",
            "MsRdpClient10", "MsRdpClient9", "MsRdpClient8"
        };
        foreach (string p in progIds)
        {
            Type t = Type.GetTypeFromProgID(p, false);
            if (t != null)
            {
                try { object o = Activator.CreateInstance(t); usedProgId = p; return o; }
                catch { }
            }
        }
        // last resort: CLSID_MsRdpClient9NotSafeForScripting
        Type t2 = Type.GetTypeFromCLSID(new Guid("8B918B82-7985-4C24-89DF-C33AD2BBFBCD"), false);
        if (t2 != null) { try { object o = Activator.CreateInstance(t2); usedProgId = "CLSID 8B918B82..."; return o; } catch { } }
        return null;
    }
}
'@

try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; Say "Add-Type ok" }
catch { Say ("Add-Type FAILED: " + $_.Exception.Message); return }

# ---------- 0. environment ----------
$en = $false
$okEn = [ChildSession]::WTSIsChildSessionsEnabled([ref]$en)
Say ("WTSIsChildSessionsEnabled: ok=" + $okEn + " enabled=" + $en + " err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
if (-not $en) {
  Say "child sessions are NOT enabled -> would need elevation: WTSEnableChildSessions(true)"
  Say "ABORT: run the elevated enable step first."
  return
}
$mySession = (Get-Process -Id $PID).SessionId
Say ("this process runs in session " + $mySession)
$beforeChild = 0
$null = [ChildSession]::WTSGetChildSessionId([ref]$beforeChild)
Say ("WTSGetChildSessionId before: " + $beforeChild + " (4294967295 = none)")
Say ("qwinsta before: " + ((& qwinsta 2>&1 | Out-String) -replace "`r?`n", ' | ').Trim())

# ---------- 1. create the control ----------
$used = ''
$ax = [ChildSession]::CreateRdpClient([ref]$used)
if (-not $ax) { Say "ABORT: could not create any MsRdpClient COM object"; return }
Say ("RDP ActiveX created via ProgID: " + $used + "  type=" + $ax.GetType().FullName)

$ext = $null
try { $ext = [ChildSession+IMsRdpExtendedSettings]$ax; Say "QueryInterface IMsRdpExtendedSettings: OK" }
catch { Say ("QueryInterface IMsRdpExtendedSettings FAILED: " + $_.Exception.Message) }

function Set-Prop($name, $value) {
  try { $ax.GetType().InvokeMember($name, [Reflection.BindingFlags]::SetProperty, $null, $ax, @($value)) | Out-Null; Say ("  put_" + $name + " = " + $value + " OK") }
  catch { Say ("  put_" + $name + " FAILED: " + $_.Exception.InnerException.Message) }
}

if ($ext) {
  $v = [object]$true
  try { $hr = $ext.put_Property("ConnectToChildSession", [ref]$v); Say ("put_Property(ConnectToChildSession,true) hr=0x" + $hr.ToString('X8')) }
  catch { Say ("put_Property(ConnectToChildSession) threw: " + $_.Exception.Message) }
  try {
    $back = $null
    $hr2 = $ext.get_Property("ConnectToChildSession", [ref]$back)
    Say ("get_Property(ConnectToChildSession) hr=0x" + $hr2.ToString('X8') + " value=" + $back)
  } catch { Say ("get_Property threw: " + $_.Exception.Message) }
}

Set-Prop 'Server' $Server
Set-Prop 'DesktopWidth' $Width
Set-Prop 'DesktopHeight' $Height

# ---------- 2. connect ----------
Say "calling Connect() ..."
try { $ax.GetType().InvokeMember('Connect', [Reflection.BindingFlags]::InvokeMethod, $null, $ax, $null) | Out-Null; Say "Connect() returned" }
catch { Say ("Connect() FAILED: " + $_.Exception.InnerException.Message) }

# ---------- 3. watch for the child session ----------
$childId = 0
for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $cid = 0
  $o = [ChildSession]::WTSGetChildSessionId([ref]$cid)
  $conn = $null
  try { $conn = $ax.GetType().InvokeMember('Connected', [Reflection.BindingFlags]::GetProperty, $null, $ax, $null) } catch {}
  $name = if ($o -and $cid -ne 4294967295) { [ChildSession]::SessionName([uint32]$cid) } else { '-' }
  Say ("  t=+" + $i + "s Connected=" + $conn + " childSessionId=" + $cid + " winstaName=" + $name)
  if ($o -and $cid -ne 4294967295) { $childId = [uint32]$cid; break }
}
Say ("qwinsta during: " + ((& qwinsta 2>&1 | Out-String) -replace "`r?`n", ' | ').Trim())

# ---------- 4. verdict ----------
Say "--- VERDICT ---"
if ($childId -ne 0) { Say ("CHILD SESSION CREATED: id=" + $childId + " -> R3 mechanism CONFIRMED on this machine.") }
else { Say "NO child session detected (check errors above)." }

# ---------- 5. cleanup ----------
if (-not $KeepAlive) {
  try { $ax.GetType().InvokeMember('Disconnect', [Reflection.BindingFlags]::InvokeMethod, $null, $ax, $null) | Out-Null; Say "Disconnect() called" } catch { Say ("Disconnect failed: " + $_.Exception.Message) }
  Start-Sleep -Seconds 2
  if ($childId -ne 0) {
    $lo = [ChildSession]::WTSLogoffSession([IntPtr]::Zero, $childId, $false)
    Say ("WTSLogoffSession(" + $childId + ") = " + $lo + " err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    Start-Sleep -Seconds 3
  }
  $after = 0
  $null = [ChildSession]::WTSGetChildSessionId([ref]$after)
  Say ("WTSGetChildSessionId after cleanup: " + $after)
} else {
  Say "KeepAlive set -> leaving the child session running (log it off manually)"
}
Say ("qwinsta after: " + ((& qwinsta 2>&1 | Out-String) -replace "`r?`n", ' | ').Trim())
Say ("report: " + $report)
