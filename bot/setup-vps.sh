#!/usr/bin/env bash
# VPS 上で Bot をセットアップして pm2 で常駐させる
#   git clone https://github.com/ba082083-max/uniswap.git && bash uniswap/bot/setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Node.js 20.6 以上を用意
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".").map(Number).reduce((a,x,i)=>a+x*[1e6,1e3,1][i],0)')
  [ "$v" -ge 20006000 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "Node.js 22 をインストールします..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO "$(command -v dnf || command -v yum)" install -y nodejs
  else
    echo "Node.js 20.6 以上を手動でインストールしてから再実行してください" >&2
    exit 1
  fi
fi

npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  read -r -s -p "BOT_TOKEN（PC の bot-token.txt の中身）: " token; echo
  [ -z "$token" ] && { echo "BOT_TOKEN が空です" >&2; exit 1; }
  sed -i "s/^BOT_TOKEN=.*/BOT_TOKEN=${token}/" .env
  chmod 600 .env
fi

echo "--- 動作確認（1回だけ実行） ---"
node --env-file=.env src/index.js --once

command -v pm2 >/dev/null 2>&1 || $SUDO npm install -g pm2
pm2 start ecosystem.config.cjs --update-env
pm2 save
echo
echo "起動しました。ログ: pm2 logs lp-bot"
echo "VPS 再起動後も自動起動させるには、次の行に表示されるコマンドを実行してください:"
pm2 startup | tail -1
