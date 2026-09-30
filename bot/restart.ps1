# Bot を再起動する（.env を書き換えた後に実行）
& (Join-Path $PSScriptRoot 'stop.ps1')
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'LP Bot'
Write-Host 'Bot を起動しました。ログ: Get-Content C:\lp-bot\bot\bot.log -Tail 20 -Wait -Encoding UTF8' -ForegroundColor Green