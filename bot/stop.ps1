# Bot を完全に停止する（タスクと node プロセスの両方）
Stop-ScheduledTask -TaskName 'LP Bot' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*src\index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Bot を停止しました。' -ForegroundColor Yellow