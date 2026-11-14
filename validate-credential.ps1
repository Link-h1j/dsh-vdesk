# validate-credential.ps1 -- check whether the stored password actually authenticates locally,
# and with which account-name spelling. Uses LogonUser (no session is disturbed, nothing is printed).
# This is the same check Doubao's UI calls "validatePipWindowsUserPassword".
# ASCII only.

param(
  [string]$CredTarget = 'DSH-CHILDSESSION',
  [string]$Machine = '',
  [string]$Msa = '1010930312@qq.com',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$report = Join-Path $OutDir ('validate-cred-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$script:lines = New-Object System.Collections.ArrayList
function Say($s) { [void]$script:lines.Add([string]$s); [IO.File]::WriteAllLines($report, $script:lines, (New-Object Text.UTF8Encoding($false))); Write-Host $s }

if (-not $Machine) { $Machine = $env:COMPUTERNAME }

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class V
{
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
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string t, uint ty, uint f, out IntPtr p);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);

    [DllImport("advapi32.dll", EntryPoint="LogonUserW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);

    public static string ReadPwd(string target, out string user)
    {
        user = null; IntPtr p = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out p)) return null;
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            user = c.UserName;
            if (c.CredentialBlob == IntPtr.Zero || c.CredentialBlobSize == 0) return null;
            return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2));
        } finally { CredFree(p); }
    }

    public static int TryLogon(string user, string domain, string pwd)
    {
        IntPtr tok = IntPtr.Zero;
        bool ok = LogonUser(user, domain, pwd, 2, 0, out tok);   // 2 = LOGON32_LOGON_INTERACTIVE
        int err = Marshal.GetLastWin32Error();
        if (tok != IntPtr.Zero) CloseHandle(tok);
        return ok ? 0 : err;
    }
}
'@
try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop } catch { Say ("Add-Type failed: " + $_.Exception.Message); return }

$storedUser = ''
$pwd = [V]::ReadPwd($CredTarget, [ref]$storedUser)
if (-not $pwd) { Say ("no credential named '" + $CredTarget + "'"); return }
Say ("credential found: stored user='" + $storedUser + "', " + $pwd.Length + " chars")
Say ("machine = " + $Machine + " ; msa = " + $Msa)
Say ""

$cases = @(
  @{ u = $Msa;                      d = 'MicrosoftAccount' },
  @{ u = 'MicrosoftAccount\' + $Msa; d = '.' },
  @{ u = 'Administrator';           d = $Machine },
  @{ u = 'Administrator';           d = '.' },
  @{ u = $Machine + '\Administrator'; d = '.' },
  @{ u = $storedUser;               d = '.' },
  @{ u = $storedUser;               d = $null }
)
$any = $false
foreach ($c in $cases) {
  $d = $c.d; if ($null -eq $d) { $d = '' }
  $err = [V]::TryLogon($c.u, $d, $pwd)
  $name = if ($d -ne '') { $d + '\' + $c.u } else { $c.u }
  if ($err -eq 0) { Say ("  [OK]      " + $name); $any = $true }
  else { Say ("  [fail " + $err + "] " + $name + "   (" + $(switch ($err) { 1326 { 'wrong user or password' } 1331 { 'account disabled' } 1385 { 'logon type not granted' } 1907 { 'password must change' } default { 'see win32 code' } }) + ")") }
}
$pwd = $null

Say ""
if ($any) { Say "RESULT: the stored password IS valid for at least one account spelling above." }
else { Say "RESULT: the stored password did NOT authenticate with any spelling -> it is stale or wrong." }
Say ("report: " + $report)
