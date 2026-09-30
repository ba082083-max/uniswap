# 残りの GitHub Secrets を登録し、管理画面を初回デプロイする（このPCで実行）
# パスワードはこの画面で入力し、GitHub Secrets 以外には保存しません。
$ErrorActionPreference = 'Stop'
$repo = 'ba082083-max/uniswap'

function Read-Secret([string]$prompt) {
    $s = Read-Host -AsSecureString $prompt
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$dir = Read-Host 'FTP_SERVER_DIR（ファイルマネージャーで確認した公開フォルダ + lpbot/  例: /uniswap.test-test.me/lpbot/）'
if (-not $dir.EndsWith('/')) { $dir += '/' }
$ftpPw = Read-Secret 'FTPパスワード'
$dashPw = Read-Secret '管理画面ログイン用パスワード（新しく決める）'

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })

gh secret set FTP_SERVER_DIR -R $repo -b "$dir"
gh secret set FTP_PASSWORD -R $repo -b "$ftpPw"
gh secret set DASHBOARD_PASSWORD -R $repo -b "$dashPw"
gh secret set BOT_TOKEN -R $repo -b "$token"

# VPS の .env に入れる用に保存（.gitignore 済み）
Set-Content -Path (Join-Path $PSScriptRoot 'bot-token.txt') -Value $token -Encoding ascii

gh workflow run deploy-dashboard.yml -R $repo
Write-Host ''
Write-Host '完了: Secrets を登録し、管理画面のデプロイを開始しました。'
Write-Host "BOT_TOKEN は bot-token.txt に保存しました（VPS のセットアップで使います）。"
