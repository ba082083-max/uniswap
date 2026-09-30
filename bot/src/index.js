import { config } from './config.js';
import {
  makeClient, loadPool, readPoolState, readBalances, readPositions, proposeRange, tickToPrice,
} from './uniswap.js';

const once = process.argv.includes('--once');
const client = makeClient(config.rpcUrl);

const events = []; // 直近のイベント（管理画面に表示）
const outOfRangeSince = new Map(); // tokenId -> レンジ外になった時刻(ms)
const alerted = new Set(); // リバランス判定を通知済みの tokenId
let paused = false;

function log(level, message) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${level.toUpperCase()} ${message}`);
  events.unshift({ time, level, message });
  if (events.length > 50) events.pop();
}

async function report(status) {
  if (!config.dashboardUrl) return;
  try {
    const res = await fetch(config.dashboardUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Token': config.botToken },
      body: JSON.stringify(status),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const nextPaused = Boolean(body?.control?.paused);
    if (nextPaused !== paused) {
      paused = nextPaused;
      log('info', paused ? '管理画面から一時停止されました' : '管理画面から再開されました');
    }
  } catch (e) {
    console.error(`[report] 管理画面への送信に失敗: ${e.message}`);
  }
}

function evaluate(positions, range, pool) {
  const now = Date.now();
  const delayMs = config.rebalanceDelayMin * 60_000;
  const fmt = (t) => tickToPrice(t, pool.token0.decimals, pool.token1.decimals).toFixed(2);

  for (const p of positions) {
    if (p.inRange) {
      if (outOfRangeSince.has(p.tokenId)) log('info', `#${p.tokenId} がレンジ内に戻りました`);
      outOfRangeSince.delete(p.tokenId);
      alerted.delete(p.tokenId);
      continue;
    }
    if (!outOfRangeSince.has(p.tokenId)) {
      outOfRangeSince.set(p.tokenId, now);
      log('warn', `#${p.tokenId} がレンジ外になりました（${fmt(p.tickLower)}〜${fmt(p.tickUpper)}）`);
    }
    const elapsed = now - outOfRangeSince.get(p.tokenId);
    if (elapsed >= delayMs && !alerted.has(p.tokenId)) {
      alerted.add(p.tokenId);
      log(
        'action',
        `[監視モード] #${p.tokenId} はリバランス対象です → 新レンジ案 ${fmt(range.tickLower)}〜${fmt(range.tickUpper)}` +
          (paused ? '（一時停止中）' : '') + '。実際の取引は行っていません。'
      );
    }
  }
}

async function tick(pool) {
  const state = await readPoolState(client, pool);
  const [balances, positions] = await Promise.all([
    readBalances(client, pool, config.wallet),
    readPositions(client, pool, state, config.wallet),
  ]);
  const range = proposeRange(state.tick, pool.tickSpacing, config.rangeWidthPct);
  const { decimals: d0 } = pool.token0;
  const { decimals: d1 } = pool.token1;

  evaluate(positions, range, pool);

  const pair = `${pool.token0.symbol}/${pool.token1.symbol}`;
  const summary = positions.length
    ? positions.map((p) => `#${p.tokenId}${p.inRange ? '(レンジ内)' : '(レンジ外)'}`).join(' ')
    : 'ポジションなし';
  console.log(`[${new Date().toISOString()}] ${pair} = ${state.price.toFixed(2)} tick=${state.tick} | ${summary}`);

  await report({
    mode: config.mode,
    paused,
    updatedAt: new Date().toISOString(),
    chain: 'Arbitrum',
    wallet: config.wallet,
    settings: {
      rangeWidthPct: config.rangeWidthPct,
      rebalanceDelayMin: config.rebalanceDelayMin,
      pollIntervalSec: config.pollIntervalSec,
    },
    pool: {
      address: pool.address,
      symbol0: pool.token0.symbol,
      symbol1: pool.token1.symbol,
      fee: pool.fee,
      tick: state.tick,
      price: state.price,
    },
    balances,
    positions,
    proposedRange: {
      ...range,
      priceLower: tickToPrice(range.tickLower, d0, d1),
      priceUpper: tickToPrice(range.tickUpper, d0, d1),
    },
    events,
  });
}

async function main() {
  log('info', `起動しました（MODE=${config.mode}, wallet=${config.wallet}）`);
  const pool = await loadPool(client, config.pool);
  log('info', `対象プール: ${pool.token0.symbol}/${pool.token1.symbol} fee=${pool.fee / 10000}%`);

  for (;;) {
    try {
      await tick(pool);
    } catch (e) {
      log('error', `監視処理でエラー: ${e.shortMessage || e.message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, config.pollIntervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
