$log = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\helper-runner.log'
function L($m) { Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) }
L ('runner start session=' + [System.Diagnostics.Process]::GetCurrentProcess().SessionId + ' user=' + $env:USERNAME + ' temp=' + $env:TEMP)
$exe = 'C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\helper\dsh-vdesk-helper.exe'
L ('exe exists=' + (Test-Path $exe))
try {
  $p = Start-Process -FilePath $exe -ArgumentList '8790' -WindowStyle Hidden -PassThru
  L ('started pid=' + $p.Id)
} catch { L ('start failed: ' + $_.Exception.Message) }
Start-Sleep -Seconds 3
$marker = Join-Path $env:TEMP 'dsh-vdesk-helper.json'
if (Test-Path $marker) { L ('marker: ' + (Get-Content $marker -Raw)) } else { L 'no marker' }
L ('helper processes in this session: ' + ((Get-Process -Name 'dsh-vdesk-helper' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','))