# capture-during-doubao.ps1 -- run elevated (via the SYSTEM bridge) for a few minutes and record
# a fine-grained timeline while the user triggers Doubao's virtual desktop:
#   * qwinsta + every session whose window station contains '#' (the child session)
#   * every process whose SessionId is NOT 0 and NOT the console session -> name, pid, command line
#     (this is how we learn what Doubao launches INSIDE the child session, and how)
#   * new TerminalServices client/server event log lines
#   * new lines from Doubao's own PIP logs
# ASCII only.

param(
  [int]$Seconds = 200,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot 'out\capture-doubao.txt' }
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null

$sb = New-Object System.Text.StringBuilder
function Log($s) {
  [void]$sb.AppendLine(("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $s))
  [IO.File]::WriteAllText($OutFile, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
}

$cs = @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Cap
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
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

Log ("=== capture start, " + $Seconds + "s, elevated=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + " ===")
Log ("sessions at start: [" + ([string]::Join("] [", [Cap]::All())) + "]")

$pipLogDir = "C:\Users\Administrator\AppData\Local\Doubao\User Data\sdk_storage\log"
$clientLog = 'Microsoft-Windows-TerminalServices-RDPClient/Operational'
$lsmLog    = 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'
$rcmLog    = 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'

$seenEvents = @{}
$seenPip = @{}
$lastSig = ''
$childSeen = $false
$lastChildAt = $null

for ($t = 0; $t -lt $Seconds; $t += 2) {
  Start-Sleep -Seconds 2
  if ($childSeen -and $lastChildAt -and ((Get-Date) - $lastChildAt).TotalSeconds -gt 20) {
    Log ("=== child session has been gone for 20s -> stopping early (t=+" + $t + "s) ===")
    break
  }

  $sess = [Cap]::All()
  $kids = @($sess | Where-Object { $_ -match '#' })
  $sig = ($sess -join ',') + '|' + ($kids -join ',')
  if ($sig -ne $lastSig) {
    Log ("SESSIONS changed: [" + ([string]::Join("] [", $sess)) + "]")
    $lastSig = $sig
  }
  if ($kids.Count -gt 0) {
    $childSeen = $true
    $lastChildAt = Get-Date
    Log ("*** CHILD SESSION PRESENT: " + ($kids -join ' ; '))
    # what runs inside it?
    $kidIds = @()
    foreach ($k in $kids) { $kidIds += [int]($k.Split('|')[0]) }
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $kidIds -contains $_.SessionId }
    if ($procs) {
      foreach ($p in $procs) {
        $cl = $p.CommandLine; if (-not $cl) { $cl = '' }
        if ($cl.Length -gt 190) { $cl = $cl.Substring(0,190) }
        Log ("    [child proc] sid=" + $p.SessionId + " pid=" + $p.ProcessId + " " + $p.Name + "  cmd=" + $cl)
      }
    } else { Log "    (no processes enumerated in the child session)" }
  }

  # new event log lines
  foreach ($pair in @(@($clientLog,'cli'), @($lsmLog,'lsm'), @($rcmLog,'rcm'))) {
    try {
      $evs = Get-WinEvent -LogName $pair[0] -MaxEvents 8 -ErrorAction Stop
      foreach ($e in ($evs | Sort-Object TimeCreated)) {
        $key = $pair[1] + '|' + $e.RecordId
        if (-not $seenEvents.ContainsKey($key)) {
          $seenEvents[$key] = 1
          $m = ($e.Message -replace "`r`n", ' | ')
          if ($m.Length -gt 150) { $m = $m.Substring(0,150) }
          Log ("  [" + $pair[1] + "] " + $e.TimeCreated.ToLocalTime().ToString('HH:mm:ss') + " id=" + $e.Id + " " + $m)
        }
      }
    } catch { }
  }

  # new PIP log lines (Doubao's own client log)
  try {
    $newest = Get-ChildItem $pipLogDir -Filter 'pip_main_*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) {
      $lines = Get-Content $newest.FullName -Tail 40 -ErrorAction SilentlyContinue
      foreach ($l in $lines) {
        if ($l -match 'Connect|Property|advanced|Server|shadow|Session|session id|helper|explorer|password|credential') {
          $key = $newest.Name + '|' + $l
          if (-not $seenPip.ContainsKey($key)) { $seenPip[$key] = 1; Log ("  [pip] " + $l) }
        }
      }
    }
  } catch { }
}

Log ("=== capture end; child session ever seen = " + $childSeen + " ===")
Log ("sessions at end: [" + ([string]::Join("] [", [Cap]::All())) + "]")
Write-Output ("capture written to " + $OutFile + " ; childSeen=" + $childSeen)
