# store-credential.ps1 -- store the Windows account password for the child-session prototype
# in the Windows Credential Manager (generic credential).
#
# Run this YOURSELF in your own terminal. The password is typed into a secure prompt
# (Read-Host -AsSecureString), never echoed, never written to disk in plaintext, never logged.
#
# ASCII only.

param(
  [string]$Target = 'DSH-CHILDSESSION',
  [string]$UserName = '',
  [switch]$Delete,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class CredStore
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buf);
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

if ($Delete) {
  $ok = [CredStore]::CredDelete($Target, 1, 0)
  Write-Host ("delete '" + $Target + "' -> " + $ok + " (win32 " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ")")
  return
}

if (-not $UserName) { $UserName = $env:USERNAME }

if ($SelfTest) {
  $t = 'DSH-CHILDSESSION-SELFTEST'
  $secret = 'dummy-' + [Guid]::NewGuid().ToString('N')
  $b = [Text.Encoding]::Unicode.GetBytes($secret)
  $h = [Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
  [Runtime.InteropServices.Marshal]::Copy($b, 0, $h, $b.Length)
  $c = New-Object CredStore+CREDENTIAL
  $c.Type = 1; $c.TargetName = $t; $c.UserName = 'selftest'
  $c.CredentialBlob = $h; $c.CredentialBlobSize = [uint32]$b.Length; $c.Persist = 2
  $ok1 = [CredStore]::CredWrite([ref]$c, 0); $e1 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [Runtime.InteropServices.Marshal]::FreeHGlobal($h)
  Write-Host ("selftest CredWrite ok=" + $ok1 + " win32=" + $e1)
  $p2 = [IntPtr]::Zero
  if ([CredStore]::CredRead($t, 1, 0, [ref]$p2)) {
    $r2 = [Runtime.InteropServices.Marshal]::PtrToStructure($p2, [Type]'CredStore+CREDENTIAL')
    $back = [Runtime.InteropServices.Marshal]::PtrToStringUni($r2.CredentialBlob, [int]($r2.CredentialBlobSize / 2))
    Write-Host ("selftest CredRead OK: bytes=" + $r2.CredentialBlobSize + " match=" + ($back -eq $secret))
    [CredStore]::CredFree($p2)
  } else { Write-Host ("selftest CredRead FAILED win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  $ok3 = [CredStore]::CredDelete($t, 1, 0)
  Write-Host ("selftest cleanup delete=" + $ok3)
  return
}

$sec = Read-Host -Prompt ("Enter the Windows password for '" + $UserName + "' (hidden)") -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$plain = ''
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

$bytes = [Text.Encoding]::Unicode.GetBytes($plain)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($bytes.Length, 2))
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)

$cred = New-Object CredStore+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1          # CRED_TYPE_GENERIC
$cred.TargetName = $Target
$cred.UserName = $UserName
$cred.CredentialBlob = $blob
$cred.CredentialBlobSize = [uint32]$bytes.Length
$cred.Persist = 2       # CRED_PERSIST_LOCAL_MACHINE

$ok = $false
$err = 0
try {
  $ok = [CredStore]::CredWrite([ref]$cred, 0)
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
} finally {
  for ($i = 0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($blob, $i, 0) }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = 0 }
  $plain = $null
}
Write-Host ("CredWrite -> ok=" + $ok + " win32=" + $err)

# verify by reading it back (we do NOT print the secret)
$p = [IntPtr]::Zero
if ([CredStore]::CredRead($Target, 1, 0, [ref]$p)) {
  $r = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type]'CredStore+CREDENTIAL')
  Write-Host ("verify OK: target='" + $r.TargetName + "' user='" + $r.UserName + "' blobBytes=" + $r.CredentialBlobSize)
  [CredStore]::CredFree($p)
} else {
  Write-Host ("verify FAILED: CredRead win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
Write-Host ("delete later with: cmdkey /delete:" + $Target)
