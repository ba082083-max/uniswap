# Windows VPS 用 セットアップ／更新スクリプト（管理者 PowerShell で実行）
# 何度実行しても OK（.env は保持され、コードだけ最新になります）
param(
    [string]$InstallDir = 'C:\lp-bot',
    [string]$Token = '',
    [switch]$SkipTask
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoZip = 'https://github.com/ba082083-max/uniswap/archive/refs/heads/main.zip'
$taskName = 'LP Bot'
$botDir = Join-Path $InstallDir 'bot'

function Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Get-NodeExe {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $p) { return $p }
    return $null
}

function Test-NodeVersion([string]$exe) {
    if (-not $exe) { return $false }
    $v = [version](& $exe -p "process.versions.node")
    return $v -ge [version]'20.6.0'
}

# 1. Node.js
Step 'Node.js を確認'
$node = Get-NodeExe
if (-not (Test-NodeVersion $node)) {
    Write-Host 'Node.js 22 (LTS) をインストールします...'
    # PowerShell 5.1 では括弧で囲まないと配列が1要素として流れるため ( ) が必要
    $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') |
        Where-Object { $_.version -like 'v22.*' -and $_.files -contains 'win-x64-msi' } |
        Select-Object -First 1
    if (-not $rel) { throw 'Node.js のバージョン情報を取得できませんでした' }
    $msi = Join-Path $env:TEMP "node-$($rel.version)-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-x64.msi" -OutFile $msi -UseBasicParsing
    $proc = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "Node.js のインストールに失敗しました (exit $($proc.ExitCode))" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-NodeExe
    if (-not (Test-NodeVersion $node)) { throw 'Node.js が見つかりません。PowerShell を開き直して再実行してください。' }
}
$npm = Join-Path (Split-Path $node) 'npm.cmd'
Write-Host "Node.js $(& $node -v) : $node"

# 2. 実行中の Bot を止める（更新時）
if (-not $SkipTask -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Step '実行中の Bot を停止'
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*src\index.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# 3. 最新コードを取得（.env と node_modules はそのまま残る）
Step 'GitHub から最新コードを取得'
$zip = Join-Path $env:TEMP 'lp-bot-main.zip'
$tmp = Join-Path $env:TEMP ('lp-bot-extract-' + [guid]::NewGuid().ToString('N'))
Invoke-WebRequest $repoZip -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Join-Path (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName 'bot'
New-Item -ItemType Directory -Force $botDir | Out-Null
Copy-Item (Join-Path $src '*') $botDir -Recurse -Force
Write-Host "展開先: $botDir"

# 4. 依存パッケージ
Step 'npm install'
Push-Location $botDir
try {
    & $npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install に失敗しました' }
} finally { Pop-Location }

# 5. .env
$envFile = Join-Path $botDir '.env'
if (-not (Test-Path $envFile)) {
    Step '.env を作成'
    if (-not $Token) {
        $s = Read-Host -AsSecureString 'BOT_TOKEN（PC の bot-token.txt の中身を貼り付け）'
        $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
        try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    }
    $Token = $Token.Trim()
    if (-not $Token) { throw 'BOT_TOKEN が空です' }
    $utf8 = New-Object Text.UTF8Encoding($false)
    $content = [IO.File]::ReadAllText((Join-Path $botDir '.env.example'), $utf8)
    $content = [regex]::Replace($content, '(?m)^BOT_TOKEN=.*$', "BOT_TOKEN=$Token")
    [IO.File]::WriteAllText($envFile, $content, $utf8)
    Write-Host '.env を作成しました'
} else {
    Write-Host "`n.env は既にあるので変更しません（$envFile）"
}

# 6. 動作確認
Step '動作確認（1回だけ実行）'
Push-Location $botDir
try {
    & $node --env-file=.env src/index.js --once
    if ($LASTEXITCODE -ne 0) { throw '動作確認でエラーが出ました。上のメッセージを確認してください。' }
} finally { Pop-Location }

if ($SkipTask) { return }

# 7. 常駐（Windows 起動時に自動起動、落ちたら 10 秒後に再起動）
Step '常駐設定（タスク スケジューラ）'
$runner = Join-Path $botDir 'run-bot.cmd'
$cmd = @"
@echo off
cd /d "$botDir"
:loop
"$node" --env-file=.env src\index.js >> bot.log 2>&1
timeout /t 10 /nobreak > nul
goto loop
"@
[IO.File]::WriteAllText($runner, $cmd, (New-Object Text.UTF8Encoding($false)))

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "`n完了: Bot を起動しました（Windows 再起動後も自動で起動します）。" -ForegroundColor Green
Write-Host "ログ確認:  Get-Content '$botDir\bot.log' -Tail 20 -Wait -Encoding UTF8"
Write-Host "停止:      Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "更新:      このスクリプトをもう一度実行"
