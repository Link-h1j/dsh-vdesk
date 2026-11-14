# selftest-p4-helper-redeploy.ps1 -- Lead-side test for the new `vdesk.ps1 helper` action.
# ASCII only (no BOM needed). Read-only: it never starts/stops a session, never kills anything.
#   * static: BOM, parse, action shape, ordering (kill BEFORE sync BEFORE launch), session filter,
#     NEVER logoff, Stage default path preserved for `start`
#   * live:   `vdesk.ps1 status` exits 0

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot          # ...\tools\vdesk-childsession
$ps1 = Join-Path $root 'vdesk.ps1'

$ok = 0; $fail = 0
function Check([string]$name, [bool]$cond, $detail) {
  if ($cond) { $script:ok++ } else { $script:fail++ }
  $tag = if ($cond) { 'ok  ' } else { 'FAIL' }
  if ($null -eq $detail) { Write-Output ("$tag $name") } else { Write-Output ("$tag $name  $detail") }
}

Check 'vdesk.ps1 exists' (Test-Path $ps1) $ps1
$bytes = [IO.File]::ReadAllBytes($ps1)
Check 'vdesk.ps1 has UTF-8 BOM (EF BB BF)' (($bytes[0] -eq 239) -and ($bytes[1] -eq 187) -and ($bytes[2] -eq 191)) (($bytes[0..2]) -join ',')

$errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($ps1, [ref]$null, [ref]$errs)
Check 'vdesk.ps1 parses with 0 errors' (@($errs).Count -eq 0) (@($errs).Count)

$text = [IO.File]::ReadAllText($ps1, [Text.Encoding]::UTF8)

# isolate the 'helper' action block: from "  'helper' {" up to the next "  'window' {"
$iA = $text.IndexOf("'helper' {")
$iB = $text.IndexOf("'window' {")
$block = if ($iA -ge 0 -and $iB -gt $iA) { $text.Substring($iA, $iB - $iA) } else { '' }
Check "helper action block present" ($block.Length -gt 200) ("len=" + $block.Length)

Check 'header documents the helper action' ($text.Contains('.\vdesk.ps1 helper'))
Check 'block writes the in-session kill script' ($block.Contains('w-helper-kill.ps1'))
Check 'kill filters by the session own id' (($block.Contains('GetCurrentProcess().SessionId')) -and ($block.Contains('-eq $sid')))
Check 'block never logs off / never touches the session slot' ((-not $block.Contains('logoff')) -and (-not $block.Contains('WTSLogoffSession')))
Check 'block refuses when we own no child session' ($block.Contains('keeper.json'))
Check 'block syncs scripts with Stage -SkipHelper' ($block.Contains('Stage -SkipHelper'))
Check 'block copies the helper with an explicit retry loop' (($block.Contains('for ($i = 0; $i -lt 60; $i++)')) -and ($block.Contains('Copy-Item (Join-Path $hs')))
Check 'block proves the staged exe matches the workspace exe' (($block.Contains('workspace exe')) -and ($block.Contains('staged    exe')))
Check 'block launches helper-runner.ps1 in the child session' ($block.Contains('helper-runner.ps1'))
Check 'block waits for HelperOk and fails loudly when it never comes up' (($block.Contains('for ($i = 0; $i -lt 10; $i++)')) -and ($block.Contains('exit 1')))

# ordering inside the block: kill script -> sync -> launch
$iKill = $block.IndexOf('w-helper-kill.ps1')
$iSync = $block.IndexOf('Stage -SkipHelper')
$iRun  = $block.IndexOf('helper-runner.ps1')
Check 'ordering: kill BEFORE sync BEFORE launch' (($iKill -ge 0) -and ($iKill -lt $iSync) -and ($iSync -lt $iRun)) ("kill=$iKill sync=$iSync run=$iRun")

# Stage must keep its default behaviour for `start` (bare Stage call + guarded helper copy)
Check 'Stage still has a bare call site (start path unchanged)' ($text -match "(?m)^\s*Stage\s*$")
Check 'Stage helper copy is guarded by -SkipHelper' ($text.Contains('(-not $SkipHelper)'))
Check 'Stage declares the SkipHelper switch' ($text.Contains('param([switch]$SkipHelper)'))

# live, read-only smoke: status must exit 0 and report our own session
$out = & powershell -NoProfile -File $ps1 status 2>&1
$code = $LASTEXITCODE
Check 'vdesk.ps1 status exits 0' ($code -eq 0) ("exit=" + $code)
Check 'status prints an ours line' (($out -join "`n").Contains('ours')) $null

Write-Output ("ok=$ok fail=$fail")
exit $(if ($fail -eq 0) { 0 } else { 1 })
