import { getAddress } from 'viem';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません (.env を確認)`);
  return v;
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} は正の数にしてください: ${v}`);
  return n;
}

export const config = {
  mode: process.env.MODE || 'monitor',
  rpcUrl: required('RPC_URL'),
  wallet: getAddress(required('WALLET_ADDRESS')),
  pool: getAddress(required('POOL_ADDRESS')),
  rangeWidthPct: num('RANGE_WIDTH_PCT', 5),
  rebalanceDelayMin: num('REBALANCE_DELAY_MIN', 30),
  pollIntervalSec: num('POLL_INTERVAL_SEC', 60),
  dashboardUrl: process.env.DASHBOARD_URL || '',
  botToken: process.env.BOT_TOKEN || '',
};

if (config.mode !== 'monitor') {
  throw new Error(
    `MODE=${config.mode} はまだ実装されていません。現在は MODE=monitor（監視のみ）だけ使えます。`
  );
}
if (config.dashboardUrl && !config.botToken) {
  throw new Error('DASHBOARD_URL を使う場合は BOT_TOKEN も設定してください');
}
