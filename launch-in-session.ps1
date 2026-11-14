# launch-in-session.ps1 (v2) -- run a command IN the interactive session with the user's
# ELEVATED (unfiltered) token, without any UAC prompt.
#
# Executed by the SYSTEM bridge (hv-bridge.ps1, runs as NT AUTHORITY\SYSTEM).
# v1 used WTSQueryUserToken and got the FILTERED token (Medium integrity, Administrators
# deny-only). A filtered token carries its unfiltered counterpart as the "linked token"
# (TokenLinkedToken), which is exactly what UAC elevation hands out. SYSTEM is allowed to
# ask for it, so we swap to the linked token before CreateProcessAsUser.
#
# ASCII only.

param(
  [int]$SessionId = 1,
  [string]$Target = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\e2e-demo.ps1',
  [string]$WorkDir = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession'
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class SessionLauncher2
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buf, int bufLen, out int retLen);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(IntPtr existing, uint desiredAccess, IntPtr attrs,
        int impLevel, int tokenType, out IntPtr newToken);
    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine,
        IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    const int TokenLinkedToken = 19;

    static IntPtr GetLinkedToken(IntPtr filtered)
    {
        int need = IntPtr.Size;
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
            int ret;
            if (!GetTokenInformation(filtered, TokenLinkedToken, buf, need, out ret)) return IntPtr.Zero;
            return Marshal.ReadIntPtr(buf);
        } finally { Marshal.FreeHGlobal(buf); }
    }

    public static string Run(int sessionId, string exe, string args, string cwd, out string detail)
    {
        detail = "";
        IntPtr filtered;
        if (!WTSQueryUserToken(sessionId, out filtered))
            return "FAIL WTSQueryUserToken err=" + Marshal.GetLastWin32Error();

        IntPtr elevated = GetLinkedToken(filtered);
        detail += (elevated != IntPtr.Zero)
            ? "linked token acquired (unfiltered)"
            : "no linked token (err=" + Marshal.GetLastWin32Error() + "); falling back to the filtered token";

        IntPtr use = elevated != IntPtr.Zero ? elevated : filtered;

        // duplicate so it is a primary token we can start a process with
        IntPtr primary = IntPtr.Zero;
        const uint TOKEN_ALL_ACCESS = 0x000F01FF;
        if (!DuplicateTokenEx(use, TOKEN_ALL_ACCESS, IntPtr.Zero, 2 /*SecurityImpersonation*/, 1 /*TokenPrimary*/, out primary))
            return "FAIL DuplicateTokenEx err=" + Marshal.GetLastWin32Error();
        detail += "; primary token ok";

        IntPtr env = IntPtr.Zero;
        bool haveEnv = CreateEnvironmentBlock(out env, primary, false);

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = "winsta0\\default";

        PROCESS_INFORMATION pi;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint CREATE_NO_WINDOW = 0x08000000;
        bool ok = CreateProcessAsUser(primary, exe, "\"" + exe + "\" " + args,
            IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            haveEnv ? env : IntPtr.Zero, cwd, ref si, out pi);
        int err = Marshal.GetLastWin32Error();

        if (haveEnv && env != IntPtr.Zero) DestroyEnvironmentBlock(env);
        CloseHandle(primary);
        if (elevated != IntPtr.Zero) CloseHandle(elevated);
        CloseHandle(filtered);

        if (!ok) return "FAIL CreateProcessAsUser err=" + err;
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return "OK started pid=" + pi.dwProcessId + " in session " + sessionId;
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

Write-Output ("runner identity: " + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
Write-Output ("target: " + $Target)

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $Target + '"'
$detail = ''
$r = [SessionLauncher2]::Run($SessionId, $ps, $psArgs, $WorkDir, [ref]$detail)
Write-Output ("token: " + $detail)
Write-Output $r
