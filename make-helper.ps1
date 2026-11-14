# make-helper.ps1 -- compile the child-session helper.
#
# SOURCE OF TRUTH: helper\dsh-vdesk-helper.cs, maintained directly since the P0 series
# (apps / clipboard / token auth / console gate / virtual cursor / P4 stream+input all
# live there). The script originally re-derived that .cs from the isolated-desktop guest
# agent; that transform is now LOSSY -- tools\isolated-desktop\guest\dsh-agent.cs is an
# old 13 KB agent with none of those features, so re-running it deletes them. It is
# therefore opt-in behind -Regen only.
#
#   .\make-helper.ps1            compile helper\dsh-vdesk-helper.cs -> helper\dsh-vdesk-helper.exe
#   .\make-helper.ps1 -Regen     ALSO re-derive the .cs from the isolated-desktop agent first (lossy)
#
# ASCII only; all paths come from $PSScriptRoot so no non-ASCII literals.

param([switch]$Regen)

$ErrorActionPreference = 'Stop'

$dir = Join-Path $PSScriptRoot 'helper'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$out = Join-Path $dir 'dsh-vdesk-helper.cs'
$exe = Join-Path $dir 'dsh-vdesk-helper.exe'

if ($Regen) {
  Write-Host '-Regen: re-deriving the helper source from the isolated-desktop guest agent (LOSSY).'
  $src = Join-Path (Split-Path $PSScriptRoot -Parent) 'isolated-desktop\guest\dsh-agent.cs'
  if (-not (Test-Path $src)) { $src = 'C:\Users\Administrator\Documents\deepseek-harness\默认工作区\tools\isolated-desktop\guest\dsh-agent.cs' }
  if (-not (Test-Path $src)) { throw ('agent source not found: ' + $src) }

  $code = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8)
  $code = $code.Replace('class DshAgent', 'class VdeskHelper')

  $oldMain = @'
    static void Main(string[] args)
    {
        FreeConsole();

        int port = 8765;
        if (args.Length > 0) { int.TryParse(args[0], out port); }
'@

  $newMain = @'
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytesReturned);
    [DllImport("wtsapi32.dll")]
    static extern void WTSFreeMemory(IntPtr p);

    // WTS_CURRENT_SESSION = -1 ; WTSWinStationName = 6 ; WTSSessionId = 24
    static string WinStationName()
    {
        IntPtr buf; int len;
        if (WTSQuerySessionInformation(IntPtr.Zero, -1, 6, out buf, out len) && buf != IntPtr.Zero)
        {
            string s = Marshal.PtrToStringUni(buf);
            WTSFreeMemory(buf);
            return s == null ? "" : s;
        }
        return "";
    }

    static int SessionId()
    {
        IntPtr buf; int len;
        if (WTSQuerySessionInformation(IntPtr.Zero, -1, 24, out buf, out len) && buf != IntPtr.Zero)
        {
            int id = Marshal.ReadInt32(buf);
            WTSFreeMemory(buf);
            return id;
        }
        return -1;
    }

    static void Main(string[] args)
    {
        FreeConsole();

        int port = 8790;
        if (args.Length > 0) { int.TryParse(args[0], out port); }

        // Only serve when we are NOT the interactive console session. The console
        // session's window station is named "Console"; a loopback CHILD session gets a
        // name like "<listener-guid>#0". So this same copy can sit in the user's
        // Startup folder and stay dormant at every ordinary logon.
        string ws = WinStationName();
        int sid = SessionId();
        bool force = Array.IndexOf(args, "--force") >= 0;
        string marker = Path.Combine(Path.GetTempPath(), "dsh-vdesk-helper.json");
        if (ws == "Console" && !force)
        {
            try { File.WriteAllText(marker, "{\"served\":false,\"reason\":\"console session\",\"winsta\":\"" + ws + "\",\"session\":" + sid + "}"); } catch { }
            Environment.Exit(0);
        }
        try { File.WriteAllText(marker, "{\"served\":true,\"winsta\":\"" + ws + "\",\"session\":" + sid + ",\"port\":" + port + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}"); } catch { }
'@

  if (-not $code.Contains($oldMain)) { throw 'patch anchor (Main) not found' }
  $code = $code.Replace($oldMain, $newMain)

  $oldHealth = '",\"user\":\"" + Environment.UserName + "\",\"width\":'
  $newHealth = '",\"user\":\"" + Environment.UserName + "\",\"winsta\":\"" + WinStationName() + "\",\"session\":" + SessionId() + ",\"width\":'
  if ($code.Contains($oldHealth)) { $code = $code.Replace($oldHealth, $newHealth) } else { Write-Host "note: /health anchor not found, skipping" }

  # Bind loopback only (a "+" prefix would listen on every interface), and so the URL ACL
  # we add is scoped to 127.0.0.1.
  $oldPrefix = 'listener.Prefixes.Add("http://+:" + port + "/");'
  $newPrefix = 'listener.Prefixes.Add("http://127.0.0.1:" + port + "/");'
  if ($code.Contains($oldPrefix)) { $code = $code.Replace($oldPrefix, $newPrefix); Write-Host "prefix -> loopback only" } else { Write-Host "note: prefix anchor not found" }

  [IO.File]::WriteAllText($out, $code, (New-Object Text.UTF8Encoding($false)))
  Write-Host ("regenerated source -> " + $out + "  (" + (Get-Item $out).Length + " bytes)")
}

if (-not (Test-Path $out)) { throw ('helper source not found: ' + $out) }
Write-Host ("source: " + $out + "  (" + (Get-Item $out).Length + " bytes)")

$csc = @(
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'csc.exe not found' }
Write-Host ("csc: " + $csc)

& $csc /nologo /target:winexe /out:$exe /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll $out
Write-Host ("csc exit = " + $LASTEXITCODE)
if ($LASTEXITCODE -ne 0) { throw ('csc failed with exit ' + $LASTEXITCODE) }
if (Test-Path $exe) {
  $f = Get-Item $exe
  Write-Host ("exe: " + $exe + "  " + $f.Length + " bytes  " + $f.LastWriteTime.ToString('s'))
  Write-Host ("sha256: " + (Get-FileHash $exe -Algorithm SHA256).Hash)
} else {
  throw 'EXE NOT PRODUCED'
}
