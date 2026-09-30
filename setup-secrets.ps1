# 残りの GitHub Secrets を登録し、管理画面を初回デプロイする（このPCで実行）
# パスワードはこの画面で入力し、GitHub Secrets 以外には保存しません。
$ErrorActionPreference = 'Stop'
$repo = 'ba082083-max/uniswap'
$tokenFile = Join-Path $PSScriptRoot 'bot-token.txt'

function Read-Secret([string]$prompt) {
    $s = Read-Host -AsSecureString $prompt
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Invoke-Gh([string]$label, [string[]]$ghArgs) {
    $out = & gh @ghArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "失敗: $label" -ForegroundColor Red
        Write-Host ($out | Out-String) -ForegroundColor Red
        exit 1
    }
    Write-Host "OK: $label" -ForegroundColor Green
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host 'gh (GitHub CLI) が見つかりません。' -ForegroundColor Red
    exit 1
}
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'GitHub にログインしていません。先に「gh auth login」を実行してください。' -ForegroundColor Red
    exit 1
}

$ftpPw = Read-Secret 'FTPパスワード'
$dashPw = Read-Secret '管理画面ログイン用パスワード（新しく決める）'
if (-not $ftpPw -or -not $dashPw) {
    Write-Host 'パスワードが空です。' -ForegroundColor Red
    exit 1
}

# 既に bot-token.txt があれば同じ値を使う（VPS 側と揃えるため）
if (Test-Path $tokenFile) {
    $token = (Get-Content $tokenFile -Raw).Trim()
} else {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Set-Content -Path $tokenFile -Value $token -Encoding ascii
}

Invoke-Gh 'FTP_PASSWORD を登録' @('secret', 'set', 'FTP_PASSWORD', '-R', $repo, '--body', $ftpPw)
Invoke-Gh 'DASHBOARD_PASSWORD を登録' @('secret', 'set', 'DASHBOARD_PASSWORD', '-R', $repo, '--body', $dashPw)
Invoke-Gh 'BOT_TOKEN を登録' @('secret', 'set', 'BOT_TOKEN', '-R', $repo, '--body', $token)
Invoke-Gh '管理画面のデプロイを開始' @('workflow', 'run', 'deploy-dashboard.yml', '-R', $repo, '--ref', 'main')

Write-Host ''
Write-Host '完了: Secrets を登録し、管理画面のデプロイを開始しました（1〜2分で反映）。' -ForegroundColor Green
Write-Host 'BOT_TOKEN は bot-token.txt に保存しています（VPS のセットアップで使います）。'