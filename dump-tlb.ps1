# dump-tlb.ps1 -- read the type library embedded in mstscax.dll and print, for the
# IMsRdpClientNonScriptable* / IMsRdpExtendedSettings interfaces, every method with its
# vtable offset (FUNCDESC.oVft / IntPtr.Size = slot index) and its IID.
# ASCII only.

$ErrorActionPreference = 'Stop'
$dll = Join-Path $env:SystemRoot 'System32\mstscax.dll'
Write-Host ("typelib source: " + $dll + "  exists=" + (Test-Path $dll))

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Collections.Generic;

public static class TlbDump
{
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string szFile, int regKind, out ITypeLib pptlib);

    public static List<string> Dump(string path, string[] wanted)
    {
        List<string> outp = new List<string>();
        ITypeLib tlb;
        LoadTypeLibEx(path, 0 /*REGKIND_NONE*/, out tlb);
        int n = tlb.GetTypeInfoCount();
        outp.Add("typeinfos: " + n);
        for (int i = 0; i < n; i++)
        {
            ITypeInfo ti;
            try { tlb.GetTypeInfo(i, out ti); } catch { continue; }
            string name = "", doc = "", help = "";
            int ctx = 0;
            try { ti.GetDocumentation(-1, out name, out doc, out ctx, out help); } catch { name = "(noname)"; }

            bool want = false;
            foreach (string w in wanted) if (name != null && name.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0) want = true;
            if (!want) { Marshal.ReleaseComObject(ti); continue; }

            outp.Add("");
            outp.Add("=== " + name + " ===");

            IntPtr pAttr;
            try { ti.GetTypeAttr(out pAttr); } catch { outp.Add("  (no type attr)"); Marshal.ReleaseComObject(ti); continue; }
            Guid g = (Guid)Marshal.PtrToStructure(pAttr, typeof(Guid));
            outp.Add("  IID = " + g.ToString("D"));
            ti.ReleaseTypeAttr(pAttr);

            for (int f = 0; ; f++)
            {
                IntPtr pfd;
                try { ti.GetFuncDesc(f, out pfd); } catch { break; }
                int memid = Marshal.ReadInt32(pfd, 0);
                short oVft = Marshal.ReadInt16(pfd, 40);
                string fname = "memid=" + memid;
                try {
                    string[] names = new string[1];
                    int cn;
                    ti.GetNames(memid, names, 1, out cn);
                    if (names[0] != null) fname = names[0];
                } catch { }
                outp.Add("  slot " + (oVft / IntPtr.Size) + " (oVft=" + oVft + ")  " + fname);
                ti.ReleaseFuncDesc(pfd);
            }
            Marshal.ReleaseComObject(ti);
        }
        return outp;
    }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop

$wanted = @('IMsRdpClientNonScriptable', 'IMsRdpExtendedSettings', 'IMsTscAdvancedSettings', 'IMsRdpClientAdvancedSettings')
$res = [TlbDump]::Dump($dll, $wanted)
$outFile = Join-Path $PSScriptRoot 'out\mstscax-typelib.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $outFile) | Out-Null
[IO.File]::WriteAllLines($outFile, $res, (New-Object Text.UTF8Encoding($false)))
Write-Host ("lines: " + $res.Count + " -> " + $outFile)
# show the key parts
$show = $res | Where-Object { $_ -match '^(===|  IID|typeinfos)' -or $_ -match 'ClearTextPassword|AllowPromptingForCredentials|ConnectToChildSession|Property' }
$show | ForEach-Object { Write-Host $_ }
