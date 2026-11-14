# selftest-p3b-startup.ps1 -- offline checks for startup-folder isolation. ASCII only (no BOM).
# The REAL Startup folder is never touched: the extracted functions are re-pointed at a temp dir.
$ErrorActionPreference = 'Stop'
$wsName = -join (0x9ED8, 0x8BA4, 0x5DE5, 0x4F5C, 0x533A | ForEach-Object { [char]$_ })
$D = Join-Path (Join-Path 'C:\Users\Administrator\Documents\deepseek-harness' $wsName) 'tools\vdesk-childsession'
$ok = 0; $fail = 0; $out = New-Object System.Collections.ArrayList
function Check($cond, $label, $detail) {
  if ($cond) { $script:ok++; [void]$script:out.Add("ok   $label") }
  else { $script:fail++; [void]$script:out.Add("FAIL $label -> " + (($detail | Out-String).Trim())) }
}
$tmp = Join-Path $env:TEMP ('p3b-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---------- BOM + parse ----------
$p = Join-Path $D 'vdesk.ps1'
$b = [IO.File]::ReadAllBytes($p)
Check ((($b[0..2]) -join ',') -eq '239,187,191') 'vdesk.ps1 is UTF-8 with BOM' (($b[0..2]) -join ',')
$e = $null; $t = $null
$V = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e)
Check ($e.Count -eq 0) 'vdesk.ps1 parses' $e

# ---------- static: the call sites exist in the right order ----------
$sw = $V.FindAll({ $args[0] -is [System.Management.Automation.Language.SwitchStatementAst] }, $true) | Select-Object -First 1
function Clause($name) {
  foreach ($c in $sw.Clauses) { if ($c.Item1 -and $c.Item1.Extent.Text -match ("'" + $name + "'")) { return $c } }
  return $null
}
$startCmds = (Clause 'start').Item2.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
$stopCmds = (Clause 'stop').Item2.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
$statusCmds = (Clause 'status').Item2.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
$hold = $startCmds | Where-Object { $_.GetCommandName() -eq 'HoldStartup' }
$launch = $startCmds | Where-Object { $_.GetCommandName() -eq 'Bridge' -and $_.Extent.Text -match 'launch-in-session' }
$guard = $startCmds | Where-Object { $_.GetCommandName() -eq 'WriteStartupGuard' }
Check (@($hold).Count -ge 1) 'start calls HoldStartup' (@($hold).Count)
Check (@($launch).Count -ge 1) 'start launches the keeper' (@($launch).Count)
if (@($hold).Count -ge 1 -and @($launch).Count -ge 1) {
  Check ($hold[0].Extent.StartOffset -lt $launch[0].Extent.StartOffset) 'start holds Startup BEFORE the keeper launch'
}
Check (@($guard).Count -ge 1) 'start runs the post-start guard check' (@($guard).Count)
Check (@($stopCmds | Where-Object { $_.GetCommandName() -eq 'RestoreStartup' }).Count -ge 1) 'stop restores Startup'
Check (@($statusCmds | Where-Object { $_.GetCommandName() -eq 'HealStartup' }).Count -ge 1) 'status self-heals'
$fnNames = @($V.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
$holdBody = ($V.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -eq 'HoldStartup' })[0].Extent.Text
Check ($holdBody -match 'HealStartup') 'HoldStartup self-heals before taking the folder'
foreach ($n in 'GetStartupState', 'HoldStartup', 'RestoreStartup', 'HealStartup', 'GetGuestSingletonHits', 'WriteStartupGuard') {
  Check ($fnNames -contains $n) "vdesk.ps1 defines $n"
}
Check ($V.Extent.Text -match 'DesktopMgr64') 'singleton list includes the Tencent suite'
Check ($V.Extent.Text -match 'QQPCExternal' -and $V.Extent.Text -match 'DesktopAITaskCenter') 'singleton list covers QQPCTray/DesktopAITaskCenter family'
Check (-not ($V.Extent.Text -match 'Remove-ItemProperty.*Run')) 'does NOT touch registry Run keys'
Check (-not ($V.Extent.Text -match 'Stop-Process.*DesktopMgr')) 'does NOT kill the user processes'

# ---------- behavioural: run the REAL functions against a temp folder ----------
function Fn($name) { ($V.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | Where-Object { $_.Name -eq $name })[0].Extent.Text }
$script:StartupDir = Join-Path $tmp 'Startup'
$script:StartupHeld = Join-Path $tmp 'Startup.vdesk-held'
$script:StartupMarker = Join-Path $tmp 'startup-held.json'
$script:GuardFile = Join-Path $tmp 'startup-guard.json'
$script:SingletonNames = @('DesktopMgr64', 'QQPCExternal', 'QQPCTray', 'DesktopAITaskCenter', 'QQPCSoftCmd')
$script:sessionIds = @()
function OurChildIds { return $script:sessionIds }
$script:sout = New-Object System.Collections.ArrayList
function Write-Host { param([Parameter(ValueFromPipeline = $true)]$Object) [void]$script:sout.Add([string]$Object) }
Invoke-Expression (Fn 'GetStartupState')
Invoke-Expression (Fn 'HealStartup')
Invoke-Expression (Fn 'HoldStartup')
Invoke-Expression (Fn 'RestoreStartup')

New-Item -ItemType Directory -Force -Path $script:StartupDir | Out-Null
Set-Content -Path (Join-Path $script:StartupDir 'real-item.lnk') -Value 'x'
HoldStartup | Out-Null
Check (-not (Test-Path $script:StartupDir)) 'HoldStartup renames Startup away'
Check (Test-Path $script:StartupHeld) 'Startup.vdesk-held now exists'
Check (Test-Path (Join-Path $script:StartupHeld 'real-item.lnk')) 'the folder contents travel with the rename'
Check (Test-Path $script:StartupMarker) 'a marker file is written'
$mk = Get-Content $script:StartupMarker -Raw | ConvertFrom-Json
Check ($mk.original -eq $script:StartupDir -and $mk.held -eq $script:StartupHeld -and $mk.pid -gt 0) 'marker records original/held/pid' $mk
HoldStartup | Out-Null
Check ((Test-Path $script:StartupHeld) -and -not (Test-Path $script:StartupDir)) 'HoldStartup is idempotent'
RestoreStartup 'selftest' | Out-Null
Check (Test-Path $script:StartupDir) 'RestoreStartup gives the original name back'
Check (-not (Test-Path $script:StartupHeld)) 'no held folder is left behind'
Check (Test-Path (Join-Path $script:StartupDir 'real-item.lnk')) 'contents survived hold+restore'
Check (-not (Test-Path $script:StartupMarker)) 'RestoreStartup clears the marker'

# self-heal: held with no session -> restore
HoldStartup | Out-Null
$script:sessionIds = @()
HealStartup 'selftest-heal' | Out-Null
Check (Test-Path $script:StartupDir) 'HealStartup restores a leftover hold when no session runs'
Check (-not (Test-Path $script:StartupHeld)) 'heal leaves no held folder'
# self-heal must NOT steal the folder while our session is alive
HoldStartup | Out-Null
$script:sessionIds = @(7)
HealStartup 'selftest-live' | Out-Null
Check ((Test-Path $script:StartupHeld) -and -not (Test-Path $script:StartupDir)) 'HealStartup keeps the hold while our session runs'
$script:sessionIds = @()
RestoreStartup 'cleanup' | Out-Null
# a stale marker without a hold is dropped
[IO.File]::WriteAllText($script:StartupMarker, '{}')
HealStartup 'selftest-stale' | Out-Null
Check (-not (Test-Path $script:StartupMarker)) 'HealStartup drops a stale marker'
# both present -> refuse to overwrite
New-Item -ItemType Directory -Force -Path $script:StartupDir | Out-Null
New-Item -ItemType Directory -Force -Path $script:StartupHeld | Out-Null
RestoreStartup 'both' | Out-Null
Check ((Test-Path $script:StartupDir) -and (Test-Path $script:StartupHeld)) 'with both present nothing is overwritten'
Remove-Item $script:StartupHeld -Recurse -Force

# ---------- behavioural: the post-start guard ----------
function Get-CimInstance {
  [CmdletBinding()] param([Parameter(Position = 0)]$Class, [Parameter(Position = 1)]$Filter)
  return $script:procs
}
Invoke-Expression (Fn 'GetGuestSingletonHits')
Invoke-Expression (Fn 'WriteStartupGuard')
$script:procs = @(
  [pscustomobject]@{ Name = 'DesktopMgr64.exe'; ProcessId = 111; SessionId = 9 },
  [pscustomobject]@{ Name = 'QQPCTray.exe'; ProcessId = 222; SessionId = 1 },
  [pscustomobject]@{ Name = 'notepad.exe'; ProcessId = 333; SessionId = 9 }
)
$hits = GetGuestSingletonHits 9
Check (@($hits).Count -eq 1 -and @($hits)[0] -match 'DesktopMgr64') 'only child-session singletons are hits' $hits
$hermetic = WriteStartupGuard 9
Check ($hermetic -eq $false) 'a leaked singleton is reported as not hermetic'
$g = Get-Content $script:GuardFile -Raw | ConvertFrom-Json
Check ($g.hermetic -eq $false -and $g.childId -eq 9 -and @($g.found).Count -eq 1) 'guard json records the leak' $g
Check ((($script:sout | Out-String)) -match 'QQPCTray|DesktopMgr64') 'the alarm names the processes'
$script:sout.Clear()
$script:procs = @([pscustomobject]@{ Name = 'QQPCTray.exe'; ProcessId = 222; SessionId = 1 })
$hermetic = WriteStartupGuard 9
Check ($hermetic -eq $true -and (GetGuestSingletonHits 9).Count -eq 0) 'a clean child session is hermetic'
$g = Get-Content $script:GuardFile -Raw | ConvertFrom-Json
Check ($g.hermetic -eq $true -and @($g.found).Count -eq 0) 'guard json records hermetic=true with empty found' $g
$okWord = -join (0x6709, 0x6548 | ForEach-Object { [char]$_ })
Check ((($script:sout | Out-String)) -match $okWord) 'the success line is written to the log output'
# stop must not leave a stale "held" claim behind in the status record
HoldStartup | Out-Null
RestoreStartup 'guard-honesty' | Out-Null
$g = Get-Content $script:GuardFile -Raw | ConvertFrom-Json
Check ($g.held -eq $false -and $g.releasedAt) 'RestoreStartup marks the guard record as released' $g

# ---------- safety: the real folder was never touched ----------
# NOTE (Lead, P4): a LIVE vdesk child session legitimately holds Startup as "Startup.vdesk-held"
# while it runs (vdesk.ps1 start does that on purpose, see STARTUP-ISOLATION.md). Asserting the
# pristine state therefore produced an environment false-failure. What must hold either way is:
# if the real folder IS held, the hold must be attributable to OUR live session (its own marker),
# not to this test. The pristine assertion is kept for the case where no session is running.
$real = 'C:\Users\Administrator\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
$realHeld = 'C:\Users\Administrator\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup.vdesk-held'
$liveHoldMarker = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\startup-held.json'
$liveHeld = (Test-Path $realHeld) -and (Test-Path $liveHoldMarker)
if ($liveHeld) {
  $lm = $null
  try { $lm = Get-Content $liveHoldMarker -Raw | ConvertFrom-Json } catch { }
  Check ($null -ne $lm -and [bool]$lm.original -and ($lm.held -eq $realHeld)) 'the REAL held folder is attributable to OUR live session (marker points at it)' $lm
  Check ($null -ne $lm -and [bool]$lm.pid -and [bool]$lm.heldAt) 'the live-hold marker is well formed (pid + heldAt recorded)' $lm
} else {
  Check (Test-Path $real) 'the REAL Startup folder is still in place'
  Check (-not (Test-Path $realHeld)) 'no REAL held folder was created by this test'
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
# the Write-Host override above is still active, so report through the console API instead
foreach ($l in $out) { [Console]::WriteLine($l) }
[Console]::WriteLine('---')
[Console]::WriteLine(("ok={0} fail={1}" -f $ok, $fail))
exit $(if ($fail -eq 0) { 0 } else { 1 })
