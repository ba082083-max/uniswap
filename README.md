# LP Bot（Uniswap v3 集中流動性 自動管理）

```
[VPS]  bot/        … 24時間 価格とポジションを監視（秘密鍵はここだけ／現段階では不要）
   │ HTTPS POST（X-Bot-Token で認証）
   ▼
[GMOサーバー] dashboard/ → https://uniswap.test-test.me/lpbot/  … 管理画面（パスワード保護）
```

現在のバージョンは **監視モードのみ**。資金は一切動かさない。
対象: Arbitrum / WETH-USDC 0.05%（`bot/.env` で変更可）

---

## 1. GitHub にリポジトリを作る

1. GitHub で **Private** リポジトリを新規作成（例: `lp-bot`）
2. このフォルダで:
   ```bash
   git remote add origin https://github.com/<ユーザー名>/lp-bot.git
   git push -u origin main
   ```

## 2. GitHub Secrets を登録（管理画面の自動アップロード用）

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で以下を登録:

| 名前 | 値 |
|---|---|
| `FTP_SERVER` | `ftp8.gmoserver.jp` |
| `FTP_USERNAME` | FTPアカウント |
| `FTP_PASSWORD` | FTPパスワード |
| `FTP_SERVER_DIR` | `uniswap.test-test.me/lpbot/`（先頭に / を付けない） |
| `DASHBOARD_PASSWORD` | 管理画面のログインパスワード（新しく決める） |
| `BOT_TOKEN` | 長いランダム文字列（下記コマンドで生成） |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`FTP_SERVER_DIR` はファイルマネージャー（https://file8.rentalserver.jp/）で、
`uniswap.test-test.me` のファイルが置かれているフォルダ名を確認してください。
既存サイトを上書きしないよう、`lpbot/` サブフォルダに配置します。

登録後、**Actions → Deploy dashboard → Run workflow** で初回デプロイ。
以降は `dashboard/` を変更して push すると自動でアップロードされます。

## 3. VPS で Bot を動かす

### Windows VPS（管理者 PowerShell で実行。更新時も同じコマンド）

```powershell
[Net.ServicePointManager]::SecurityProtocol='Tls12'; iwr https://raw.githubusercontent.com/ba082083-max/uniswap/main/bot/setup-vps.ps1 -OutFile $env:TEMP\setup-vps.ps1 -UseBasicParsing; powershell -ExecutionPolicy Bypass -File $env:TEMP\setup-vps.ps1
```

- ログ: `Get-Content C:\lp-bot\bot\bot.log -Tail 20 -Wait -Encoding UTF8`
- 停止: `powershell -ExecutionPolicy Bypass -File C:\lp-bot\bot\stop.ps1`
- 再起動（.env 変更後）: `powershell -ExecutionPolicy Bypass -File C:\lp-bot\bot\restart.ps1`

### Linux VPS（Node.js 20.6 以上）

```bash
git clone https://github.com/<ユーザー名>/lp-bot.git
cd lp-bot/bot
npm ci || npm install
cp .env.example .env
nano .env            # BOT_TOKEN を Secrets と同じ値に。RPC_URL は Alchemy 等推奨
npm run once         # 1回だけ実行して動作確認
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # VPS 再起動時も自動起動
```

ログ確認: `pm2 logs lp-bot`　更新: `git pull && pm2 restart lp-bot`

## 設定（bot/.env）

全項目の説明は [bot/.env.example](bot/.env.example) を参照。主なもの:

| 項目 | 説明 |
|---|---|
| `MODE` | `monitor`（監視のみ）/ `live`（実取引） |
| `PRIVATE_KEY` | live 時のみ。Bot 専用ウォレットの秘密鍵 |
| `MAX_DEPLOY_VALUE` | 運用に使う上限額（USDC 建て） |
| `RANGE_WIDTH_PCT` | 新レンジ幅（現在価格 ±%） |
| `REBALANCE_DELAY_MIN` | レンジ外がこの分数続いたらリバランス |
| `MAX_REBALANCES_PER_DAY` | 24時間のリバランス上限 |

## 実取引（live）の安全装置

- すべての取引は送信前にシミュレーションし、失敗する取引は送らない
- 現在価格が5分平均から `MAX_PRICE_DEVIATION_PCT` 以上ずれていたら待機（急変・価格操作対策）
- スワップ・流動性操作に最低受取量（スリッページ上限）を設定
- ガス代用 ETH が不足したら取引しない
- 運用額の上限、1日のリバランス回数上限
- 3回連続で失敗したら自動停止（管理画面で「一時停止」→「再開」で解除）
- 管理画面から一時停止・全部引き上げが可能
- 管理画面の指示を受信するまで取引しない

## ロードマップ

- [x] フェーズ1: 監視・レンジ外検知・リバランス案の提示・管理画面
- [x] フェーズ2: 自動リバランス（手数料回収 → 流動性引出 → 比率調整スワップ → 再提供）
      ローカルフォーク（Hardhat）で新規作成・リバランス・急変時の待機・回数上限・引き上げ・ガス不足を検証済み
