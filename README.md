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
| `FTP_SERVER_DIR` | `/uniswap.test-test.me/lpbot/` |
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

## 3. VPS で Bot を動かす（Node.js 20.6 以上）

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

| 項目 | 説明 |
|---|---|
| `RANGE_WIDTH_PCT` | 新レンジ幅（現在価格 ±%） |
| `REBALANCE_DELAY_MIN` | レンジ外がこの分数続いたらリバランス対象と判定 |
| `POLL_INTERVAL_SEC` | 監視間隔 |

## ロードマップ

- [x] フェーズ1: 監視・レンジ外検知・リバランス案の提示・管理画面
- [ ] フェーズ2: 自動リバランス（手数料回収 → 流動性引出 → 比率調整スワップ → 再提供）
      ※ ローカルフォーク（anvil）で十分テストしてから、Bot専用ウォレット＋少額で本番
