import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません (.env を確認)`);
  return v;
}

function num(name, def, { allowZero = false } = {}) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new Error(`${name} は${allowZero ? '0以上' : '正'}の数にしてください: ${v}`);
  }
  return n;
}

function bool(name, def) {
  const v = (process.env[name] || '').toLowerCase();
  if (v === '') return def;
  return v === 'true' || v === '1' || v === 'yes';
}

const mode = process.env.MODE || 'monitor';
if (mode !== 'monitor' && mode !== 'live') {
  throw new Error(`MODE は monitor か live にしてください: ${mode}`);
}

let account = null;
let wallet;
if (mode === 'live') {
  const pk = required('PRIVATE_KEY').trim();
  account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  wallet = account.address;
  if (process.env.WALLET_ADDRESS && getAddress(process.env.WALLET_ADDRESS) !== wallet) {
    console.warn(`[config] WALLET_ADDRESS と秘密鍵のアドレスが違います。秘密鍵のアドレス ${wallet} を使います。`);
  }
} else {
  wallet = getAddress(required('WALLET_ADDRESS'));
}

export const config = {
  mode,
  account, // live のときだけ（秘密鍵から作ったアカウント）
  rpcUrl: required('RPC_URL'),
  wallet,
  pool: getAddress(required('POOL_ADDRESS')),
  rangeWidthPct: num('RANGE_WIDTH_PCT', 5),
  rebalanceDelayMin: num('REBALANCE_DELAY_MIN', 30, { allowZero: true }),
  pollIntervalSec: num('POLL_INTERVAL_SEC', 60),
  dashboardUrl: process.env.DASHBOARD_URL || '',
  botToken: process.env.BOT_TOKEN || '',

  // ---- live モード用の安全設定 ----
  // 運用に使う上限額（token1 建て。WETH/USDC なら USDC）。ウォレットにこれ以上あっても使わない
  maxDeployValue: num('MAX_DEPLOY_VALUE', 100),
  // これ未満の資金では新規ポジションを作らない
  minOpenValue: num('MIN_OPEN_VALUE', 10),
  // ポジションが無いとき自動で作るか
  autoOpen: bool('AUTO_OPEN', true),
  // スワップ・流動性操作の許容スリッページ（%）
  slippagePct: num('SLIPPAGE_PCT', 0.5),
  // 現在価格と 5 分平均価格の差がこれ以上なら操作しない（価格操作・急変対策, %）
  maxPriceDeviationPct: num('MAX_PRICE_DEVIATION_PCT', 1),
  // ガス代として残す ETH
  minEthForGas: num('MIN_ETH_FOR_GAS', 0.0005),
  // 余った ETH を WETH に変換して運用に回すか
  wrapExcessEth: bool('WRAP_EXCESS_ETH', true),
  // 24時間あたりのリバランス上限回数
  maxRebalancesPerDay: num('MAX_REBALANCES_PER_DAY', 6),
  // この金額（token1 建て）未満のスワップは行わない
  minSwapValue: num('MIN_SWAP_VALUE', 1),
};

if (config.dashboardUrl && !config.botToken) {
  throw new Error('DASHBOARD_URL を使う場合は BOT_TOKEN も設定してください');
}
