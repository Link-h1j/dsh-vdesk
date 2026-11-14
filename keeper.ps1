# keeper.ps1 -- the "main" role: holds the RDP ActiveX connection so the child session stays
# ALIVE and ACTIVE (a disconnected child session has no rendering surface, so the in-session
# helper cannot screenshot it). Mirrors what Doubao's `pip_main.exe --type=main` does.
#
# It: creates the child session, pumps Windows messages forever (the message pump is what makes
# the connection work at all), and writes a status file the other components can read.
# Stop it by writing "stop" into the stop file, or by killing the process.
#
# Native window (policy B, 2026-10-02 incident): the form starts hidden and is shown only while the
# flag file out\keeper.window exists. A leftover flag is DELETED at keeper startup -- a stale flag
# once put a window on the user's own desktop uninvited -- and an open window hides itself after
# VDESK_WINDOW_IDLE_MIN minutes (default 10) without interaction (see CloseIdleWindow).
#
# UTF-8 with BOM (Chinese log strings); the code itself stays ASCII.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [int]$MaxSeconds = 1800,
  [string]$StatusFile = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\keeper.json',
  [string]$StopFile = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\keeper.stop',
  [int]$Width = 1280,
  [int]$Height = 800
)

$ErrorActionPreference = 'Continue'
$logFile = [IO.Path]::ChangeExtension($StatusFile, '.log')
$script:logLines = New-Object System.Collections.ArrayList
function Log($s) {
  [void]$script:logLines.Add(((Get-Date).ToString('HH:mm:ss') + ' ' + $s))
  try { [IO.File]::WriteAllLines($logFile, $script:logLines, (New-Object Text.UTF8Encoding($false))) } catch {}
}
function WriteStatus($obj) {
  try { [IO.File]::WriteAllText($StatusFile, ($obj | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch {}
}

$cs = @'
using System; using System.Collections.Generic; using System.Drawing; using System.Runtime.InteropServices; using System.Windows.Forms;
public static class KP
{
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
    // child session = a session whose window station name contains '#'
    public static int ChildId() { foreach (string s in All()) { string[] a = s.Split('|'); if (a.Length > 1 && a[1].Contains("#")) return int.Parse(a[0]); } return 0; }
    public static string ChildState() { foreach (string s in All()) { string[] a = s.Split('|'); if (a.Length > 2 && a[1].Contains("#")) return a[2]; } return ""; }
    public static string StateOf(int id) { foreach (string s in All()) { string[] a = s.Split('|'); if (a.Length > 2 && a[0] == id.ToString()) return a[2]; } return "?"; }

    public static readonly Guid IID_Ext = new Guid("302d8188-0052-4807-806a-362b628f9ac5");
    public static readonly Guid IID_Adv = new Guid("3c65b4ab-12b3-465b-acd4-b8dad3bff9e2");
    public static readonly Guid IID_NS5 = new Guid("4f6996d5-d7b1-412c-b0ff-063718566907");

    [StructLayout(LayoutKind.Explicit, Size=24)] public struct VARIANT {
        [FieldOffset(0)] public ushort vt; [FieldOffset(2)] public ushort r1; [FieldOffset(4)] public ushort r2; [FieldOffset(6)] public ushort r3;
        [FieldOffset(8)] public short bVal; [FieldOffset(8)] public IntPtr ptr;
        public static VARIANT Bool(bool v){ VARIANT x=new VARIANT(); x.vt=11; x.bVal=(short)(v?-1:0); return x; } }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PropertyFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string name, ref VARIANT val);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutBstrFn(IntPtr pThis, [MarshalAs(UnmanagedType.BStr)] string value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutBoolFn(IntPtr pThis, [MarshalAs(UnmanagedType.VariantBool)] bool value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate int PutUlongFn(IntPtr pThis, uint value);

    public static IntPtr Qi(object o, Guid iid, out int hr) { IntPtr unk = Marshal.GetIUnknownForObject(o), p = IntPtr.Zero;
        hr = Marshal.QueryInterface(unk, ref iid, out p); Marshal.Release(unk); return hr == 0 ? p : IntPtr.Zero; }
    public static IntPtr Slot(IntPtr p, int s) { IntPtr vt = Marshal.ReadIntPtr(p); return Marshal.ReadIntPtr(vt, IntPtr.Size * s); }
    public static PutBstrFn FnBstr(IntPtr p, int s) { return (PutBstrFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBstrFn)); }
    public static PutBoolFn FnBool(IntPtr p, int s) { return (PutBoolFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutBoolFn)); }
    public static PutUlongFn FnUlong(IntPtr p, int s) { return (PutUlongFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PutUlongFn)); }
    public static PropertyFn FnProp(IntPtr p, int s) { return (PropertyFn)Marshal.GetDelegateForFunctionPointer(Slot(p, s), typeof(PropertyFn)); }

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
public class KPAx : AxHost { public KPAx() : base("8b918b82-7985-4c24-89df-c33ad2bbfbcd") { } }
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop }
catch { WriteStatus @{ ok = $false; error = "Add-Type: " + $_.Exception.Message }; return }

$pwd = [KP]::ReadPwd($CredTarget)
if (-not $pwd) { WriteStatus @{ ok = $false; error = "no credential " + $CredTarget }; return }
$script:initialIds = @()
foreach ($s0 in [KP]::All()) { $script:initialIds += [int]($s0.Split("|")[0]) }
# Which child session is ours?
#   1) preferred: one that did not exist when we started (the normal case).
#   2) fallback: a LEFTOVER child session from an earlier run of ours, which Connect() has just taken
#      over and which is now Active (s0). Without this the keeper sat in 'connecting' until timeout,
#      because the leftover id was already in initialIds and so never counted as "new" -- this is
#      exactly how the virtual desktop failed to start on 2026-10-01 22:08.
#      Adopting is safe: a session held by Doubao or anything else makes Connect() fail (16s TCP
#      timeout, reason 516) and vdesk.ps1 start refuses to run while a foreign child session exists,
#      so an Active child session right after a successful Connect is ours.
function GetChildRow {
  $rows = @()
  foreach ($sx in [KP]::All()) { $rows += $sx }
  foreach ($sx in $rows) {
    $a = $sx.Split("|")
    if ($script:initialIds -notcontains [int]$a[0]) { return $a }
  }
  $act = @()
  foreach ($sx in $rows) {
    $a = $sx.Split("|")
    if ($a.Length -gt 2 -and [int]$a[0] -gt 1 -and [int]$a[0] -lt 65536 -and $a[2] -eq 's0') { $act += , $a }
  }
  if ($act.Count -eq 1) { return $act[0] }
  return $null
}
function GetChildId { $r = GetChildRow; if ($r) { return [int]$r[0] }; return 0 }
function GetChildState { $r = GetChildRow; if ($r) { return $r[2] }; return "" }
Log ("keeper start; consoleState=" + [KP]::StateOf(1) + " initialIds=" + ($script:initialIds -join ","))

$form = New-Object System.Windows.Forms.Form
# The form hosts the RDP ActiveX control. It starts off-screen (the keeper only needs the session
# alive) and can become a REAL RDP window on demand: it renders the child session through the RDP
# protocol itself and accepts the user's own mouse and keyboard. Toggled by the flag file
# out\keeper.window (vdesk.ps1 window on|off).
$form.ShowInTaskbar = $false; $form.FormBorderStyle = 'Sizable'; $form.StartPosition = 'Manual'
$form.Text = 'DSH 虚拟桌面（子会话）'
$form.MinimumSize = New-Object Drawing.Size 520, 400
# Custom icon, otherwise the window wears powershell.exe's terminal-looking icon in its title bar
# and in the taskbar.
try {
  $script:icoBmp = New-Object Drawing.Bitmap 32, 32
  $g = [Drawing.Graphics]::FromImage($script:icoBmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([Drawing.Color]::Transparent)
  $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255,255,150,80)), 2
  $g.DrawRectangle($pen, 3, 6, 25, 17)
  $g.DrawLine($pen, 11, 28, 21, 28)
  $g.DrawLine($pen, 16, 24, 16, 28)
  $br = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255,46,204,113))
  $g.FillEllipse($br, 21, 7, 8, 8)
  $g.Dispose(); $pen.Dispose(); $br.Dispose()
  $form.Icon = [Drawing.Icon]::FromHandle($script:icoBmp.GetHicon())
} catch { }
# "Hidden" = off-screen and small. Deliberately NOT Opacity<1: Opacity turns the form into a LAYERED
# window, which is what made it behave unlike a normal window. Off-screen keeps it invisible without
# changing the window style at all.
$form.Location = New-Object Drawing.Point -3200, -3200
$form.Size = New-Object Drawing.Size ($Width / 4), ($Height / 4)
$ax = New-Object KPAx; $ax.Dock = 'Fill'; $form.Controls.Add($ax)
$form.Show(); [void]$form.Handle; $ax.CreateControl()
Start-Sleep -Milliseconds 800
$ocx = $ax.GetOcx()
if (-not $ocx) { WriteStatus @{ ok = $false; error = "no OCX" }; return }

try { $ocx.GetType().InvokeMember('Server',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('localhost')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('UserName',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@('MicrosoftAccount\1010930312@qq.com')) | Out-Null } catch {}
try { $ocx.GetType().InvokeMember('DesktopWidth',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($Width)) | Out-Null
      $ocx.GetType().InvokeMember('DesktopHeight',[Reflection.BindingFlags]::SetProperty,$null,$ocx,@($Height)) | Out-Null } catch {}
$adv = $null
try { $adv = $ocx.GetType().InvokeMember('AdvancedSettings7',[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch {}
if ($adv) {
  try { $adv.GetType().InvokeMember('EnableCredSspSupport',[Reflection.BindingFlags]::SetProperty,$null,$adv,@($true)) | Out-Null } catch {}
  $hr = 0; $pAdv = [KP]::Qi($adv, [KP]::IID_Adv, [ref]$hr)
  if ($pAdv -ne [IntPtr]::Zero) {
    $null = [KP]::FnBstr($pAdv, 112).Invoke($pAdv, $pwd)          # put_ClearTextPassword
    $null = [KP]::FnUlong($pAdv, 147).Invoke($pAdv, [uint32]0)    # AuthenticationLevel = 0
    [void][Runtime.InteropServices.Marshal]::Release($pAdv)
  }
}
$hrN = 0; $pNs = [KP]::Qi($ocx, [KP]::IID_NS5, [ref]$hrN)
if ($pNs -ne [IntPtr]::Zero) { try { $null = [KP]::FnBool($pNs, 63).Invoke($pNs, $false) } catch {}; [void][Runtime.InteropServices.Marshal]::Release($pNs) }
$hrE = 0; $pE = [KP]::Qi($ocx, [KP]::IID_Ext, [ref]$hrE)
if ($pE -ne [IntPtr]::Zero) { $v = [KP+VARIANT]::Bool($true); $null = [KP]::FnProp($pE, 3).Invoke($pE, 'ConnectToChildSession', [ref]$v); [void][Runtime.InteropServices.Marshal]::Release($pE) }

Log "calling Connect()"
try { $ocx.GetType().InvokeMember('Connect',[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch { Log ("Connect threw: " + $_.Exception.InnerException.Message) }

# ---- message loop: this is the product ----
# Everything periodic runs from a Windows.Forms.Timer on a REAL message loop (Application.Run)
# instead of a DoEvents spin loop. That is what makes the window behave like any ordinary window
# (drag, resize, minimize, maximize) while the RDP control keeps rendering. The loop is also what
# keeps the child session alive.
WriteStatus @{ ok = $true; pid = $PID; phase = 'connecting'; width = $Width; height = $Height; startedAt = (Get-Date).ToString('s') }
$script:start = Get-Date
$script:lastBeat = Get-Date
$script:pumpErrors = 0
$script:phase = 'connecting'
$script:childId = 0
$script:deadline = (Get-Date).AddSeconds(60)
$script:windowed = $false
$script:winFlag = Join-Path (Split-Path $StatusFile) 'keeper.window'
$script:winTouch = Join-Path (Split-Path $StatusFile) 'keeper.touch'
# Interaction clock for the native window: a window nobody touched for N minutes is closed (hidden
# + flag removed) so it can never sit unattended on the user's desktop. VDESK_WINDOW_IDLE_MIN
# overrides the 10-minute default; the monitor refreshes keeper.touch when the panel injects input.
$script:idleMin = 10
try { if ($env:VDESK_WINDOW_IDLE_MIN) { $v = [int]$env:VDESK_WINDOW_IDLE_MIN; if ($v -gt 0) { $script:idleMin = $v } } } catch { }
$script:idleSec = $script:idleMin * 60
$script:lastTouch = Get-Date
$script:winSince = $null
# Never resurrect: a keeper.window left behind by an earlier run must not open a window now.
if (Test-Path $script:winFlag) {
  Remove-Item $script:winFlag -ErrorAction SilentlyContinue
  Remove-Item $script:winTouch -ErrorAction SilentlyContinue
  Log "启动时发现遗留的原生窗口标志 -> 已删除（策略 B：默认关闭，只有新的 window on 才开）"
}

function ApplyWindow([bool]$want) {
  if ($want) {
    try {
      $form.ShowInTaskbar = $true
      $form.Size = New-Object Drawing.Size ($Width + 16), ($Height + 39)
      $form.Location = New-Object Drawing.Point 80, 80
      if (-not $form.Visible) { $form.Show() }
      [void]$form.Handle
      $form.Activate()
      $script:winSince = Get-Date
      $script:lastTouch = Get-Date
      Log "native window shown (real RDP surface; draggable like any window)"
    } catch { Log ("show window failed: " + $_.Exception.Message) }
  } else {
    try {
      $form.ShowInTaskbar = $false
      $form.Size = New-Object Drawing.Size ($Width / 4), ($Height / 4)
      $form.Location = New-Object Drawing.Point -3200, -3200
      $script:winSince = $null
      Log "native window hidden again"
    } catch { Log ("hide window failed: " + $_.Exception.Message) }
  }
}

# Policy B idle close, kept as its own function so it can be unit-tested offline (see P0-TOOLS.md).
# Returns $true when it actually closed the window.
function CloseIdleWindow([int]$IdleSec) {
  if (-not $script:windowed) { return $false }
  # another touch source (the monitor, writing keeper.touch) may be newer than our own clock
  try {
    if (Test-Path $script:winTouch) {
      $t = (Get-Item $script:winTouch).LastWriteTime
      if ($t -gt $script:lastTouch) { $script:lastTouch = $t }
    }
  } catch { }
  if (((Get-Date) - $script:lastTouch).TotalSeconds -lt $IdleSec) { return $false }
  Remove-Item $script:winFlag -ErrorAction SilentlyContinue
  Remove-Item $script:winTouch -ErrorAction SilentlyContinue
  $script:windowed = $false
  $script:winSince = $null
  ApplyWindow $false
  Log ("原生窗口空闲自动关闭（" + $script:idleMin + " 分钟无交互）")
  return $true
}

# The user's own mouse/keyboard go straight into the RDP control, so neither the monitor nor the
# in-session helper can observe them: "cursor is over the window" is the touch that keeps a window
# the human is actually using alive. Keyboard-only use is covered by the form's Activated event.
function TouchIfUsed {
  try {
    if ($script:windowed -and $form.RectangleToScreen($form.ClientRectangle).Contains([System.Windows.Forms.Cursor]::Position)) {
      $script:lastTouch = Get-Date
    }
  } catch { }
}

$form.Add_Activated({ try { $script:lastTouch = Get-Date } catch { } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  try {
    if ($script:phase -eq 'connecting') {
      if ((Get-Date) -gt $script:deadline) {
        Log 'no child session within 60s -> exit'
        WriteStatus @{ ok = $false; pid = $PID; error = 'no child session appeared' }
        $form.Close(); return
      }
      $cid = GetChildId
      if ($cid -gt 0 -and (GetChildState) -eq 's0') {
        $script:childId = $cid
        $script:phase = 'holding'
        Log ("child session ready: id=" + $cid)
        WriteStatus @{ ok = $true; pid = $PID; phase = 'holding'; childId = $cid; width = $Width; height = $Height; startedAt = $script:start.ToString('s') }
      }
      return
    }

    if (Test-Path $StopFile) { Log 'stop file found -> exit'; $form.Close(); return }
    if (((Get-Date) - $script:start).TotalSeconds -gt $MaxSeconds) { Log ('max seconds ' + $MaxSeconds + ' -> exit'); $form.Close(); return }

    $want = Test-Path $script:winFlag
    if ($want -ne $script:windowed) { $script:windowed = $want; ApplyWindow $want }

    # policy B: refresh the interaction clock, then close a window nobody has used
    TouchIfUsed
    [void](CloseIdleWindow $script:idleSec)

    if (((Get-Date) - $script:lastBeat).TotalSeconds -ge 10) {
      $script:lastBeat = Get-Date
      $conn = ''
      try { $conn = $ocx.GetType().InvokeMember("Connected",[Reflection.BindingFlags]::GetProperty,$null,$ocx,$null) } catch { $script:pumpErrors++ }
      $cs1 = '?'; try { $cs1 = [KP]::StateOf(1) } catch {}
      $kids = @()
      try { foreach ($sx in [KP]::All()) { $a = $sx.Split("|"); if ($a.Length -gt 2 -and [int]$a[0] -gt 1 -and [int]$a[0] -lt 65536) { $kids += ($a[0] + ":" + $a[2]) } } } catch {}
      WriteStatus @{ ok = $true; pid = $PID; phase = 'holding'; childId = $script:childId; connected = $conn; candidates = ($kids -join ","); windowed = $script:windowed; windowSince = $(if ($script:winSince) { $script:winSince.ToString('s') } else { $null }); windowIdleSec = $(if ($script:windowed) { [int]((Get-Date) - $script:lastTouch).TotalSeconds } else { $null }); windowIdleMin = $script:idleMin; consoleState = $cs1; uptimeSec = [int]((Get-Date) - $script:start).TotalSeconds; pumpErrors = $script:pumpErrors; width = $Width; height = $Height }
    }
  } catch { $script:pumpErrors++; Log ("tick error: " + $_.Exception.Message) }
})
$timer.Start()
try { [System.Windows.Forms.Application]::Run($form) } catch { Log ("message loop ended: " + $_.Exception.Message) }
try { $timer.Stop(); $timer.Dispose() } catch {}

WriteStatus @{ ok = $false; pid = $PID; stopped = $true }
try { $ocx.GetType().InvokeMember("Disconnect",[Reflection.BindingFlags]::InvokeMethod,$null,$ocx,$null) | Out-Null } catch {}
try { $form.Close(); $form.Dispose() } catch {}
$pwd = $null
Log "keeper exit"
