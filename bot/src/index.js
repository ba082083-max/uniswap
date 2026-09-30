import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { config } from './config.js';
import {
  makeClient, loadPool, readPoolState, readBalances, readPositions, proposeRange, tickToPrice,
} from './uniswap.js';
import { makeExecutor } from './executor.js';

const once = process.argv.includes('--once');
const client = makeClient(config.rpcUrl);
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state.json');

const events = []; // 直近のイベント（管理画面に表示）
const outOfRangeSince = new Map(); // tokenId -> レンジ外になった時刻(ms)
const alerted = new Set(); // 監視モードでリバランス判定を通知済みの tokenId
const warnedAt = new Map(); // 同じ警告を何度も出さないため
let control = { paused: false, exit_at: null };
let controlKnown = false;
let halted = false; // 連続失敗で自動停止中
let failures = 0;

// 再起動しても残す情報
const saved = {
  rebalanceTimes: [],
  history: [],
  gasSpentWei: '0',
  pendingOpen: false,
  handledExitAt: null,
  ...loadState(),
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2));
}

function log(level, message) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${level.toUpperCase()} ${message}`);
  events.unshift({ time, level, message });
  if (events.length > 50) events.pop();
}

// 同じ内容の警告は 1 時間に 1 回まで
function warnOnce(message) {
  const last = warnedAt.get(message) || 0;
  if (Date.now() - last < 3_600_000) return;
  warnedAt.set(message, Date.now());
  log('warn', message);
}

function addHistory(type, detail) {
  saved.history.unshift({ time: new Date().toISOString(), type, detail });
  saved.history = saved.history.slice(0, 30);
  saveState();
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
    const next = { paused: Boolean(body?.control?.paused), exit_at: body?.control?.exit_at ?? null };
    if (controlKnown && next.paused !== control.paused) {
      log('info', next.paused ? '管理画面から一時停止されました' : '管理画面から再開されました');
      if (!next.paused && halted) {
        halted = false;
        failures = 0;
        log('info', '自動停止を解除しました');
      }
    }
    control = next;
    controlKnown = true;
  } catch (e) {
    console.error(`[report] 管理画面への送信に失敗: ${e.message}`);
  }
}

// レンジ内外の変化を記録
function trackRange(positions, range, pool) {
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
    if (config.mode === 'monitor' && elapsed >= delayMs && !alerted.has(p.tokenId)) {
      alerted.add(p.tokenId);
      log(
        'action',
        `[監視モード] #${p.tokenId} はリバランス対象です → 新レンジ案 ${fmt(range.tickLower)}〜${fmt(range.tickUpper)}` +
          (control.paused ? '（一時停止中）' : '') + '。実際の取引は行っていません。'
      );
    }
  }
}

// 失敗を数え、3 回連続で自動停止
async function guarded(label, fn) {
  try {
    log('action', `${label} を開始します`);
    await fn();
    failures = 0;
  } catch (e) {
    failures += 1;
    log('error', `${label} に失敗: ${e.shortMessage || e.message}`);
    if (failures >= 3) {
      halted = true;
      log('error', '3 回連続で失敗したため自動取引を停止しました。原因を確認後、管理画面で「一時停止」→「再開」すると再開します。');
    }
  } finally {
    saveState();
  }
}

async function act(executor, positions) {
  if (config.dashboardUrl && !controlKnown) return; // 管理画面の指示を受け取るまで何もしない

  // 管理画面の「全部引き上げ」
  if (control.exit_at && control.exit_at !== saved.handledExitAt) {
    await guarded('全ポジションの引き上げ', async () => {
      for (const p of positions) await executor.closePosition(p);
      addHistory('exit', `${positions.length} 件のポジションを解除`);
    });
    saved.handledExitAt = control.exit_at;
    saved.pendingOpen = false;
    saveState();
    return;
  }
  if (control.paused || halted) return;

  if (positions.length > 1) {
    warnOnce('このプールにポジションが複数あるため自動取引を見送ります（Bot は 1 つだけ管理します）');
    return;
  }

  const dayAgo = Date.now() - 86_400_000;
  saved.rebalanceTimes = saved.rebalanceTimes.filter((t) => t > dayAgo);

  if (positions.length === 1) {
    const p = positions[0];
    if (p.inRange) return;
    const since = outOfRangeSince.get(p.tokenId);
    if (!since || Date.now() - since < config.rebalanceDelayMin * 60_000) return;
    if (saved.rebalanceTimes.length >= config.maxRebalancesPerDay) {
      warnOnce(`24時間のリバランス上限（${config.maxRebalancesPerDay} 回）に達したため待機します`);
      return;
    }
    const problem = await executor.preflight();
    if (problem) return warnOnce(problem);

    await guarded('リバランス', async () => {
      await executor.closePosition(p);
      saved.pendingOpen = true;
      saved.rebalanceTimes.push(Date.now());
      saveState();
      const r = await executor.openPosition();
      if (!r.ok) throw new Error(r.reason);
      saved.pendingOpen = false;
      addHistory('rebalance', `#${p.tokenId} を解除 → 新レンジ ${r.priceLower}〜${r.priceUpper}`);
    });
    return;
  }

  // ポジションなし
  if (!config.autoOpen && !saved.pendingOpen) return;
  const problem = await executor.preflight();
  if (problem) return warnOnce(problem);
  let reason = null;
  await guarded('新規ポジション作成', async () => {
    const r = await executor.openPosition();
    if (!r.ok) {
      reason = r.reason;
      return;
    }
    saved.pendingOpen = false;
    addHistory('open', `新レンジ ${r.priceLower}〜${r.priceUpper}`);
  });
  if (reason) warnOnce(reason);
}

async function tick(pool, executor) {
  let state = await readPoolState(client, pool);
  let positions = await readPositions(client, pool, state, config.wallet);
  const range = proposeRange(state.tick, pool.tickSpacing, config.rangeWidthPct);

  trackRange(positions, range, pool);

  if (executor) {
    await act(executor, positions);
    // 取引した可能性があるので最新の状態を読み直して報告する
    state = await readPoolState(client, pool);
    positions = await readPositions(client, pool, state, config.wallet);
  }

  const balances = await readBalances(client, pool, config.wallet);
  const { decimals: d0 } = pool.token0;
  const { decimals: d1 } = pool.token1;
  const pair = `${pool.token0.symbol}/${pool.token1.symbol}`;
  const summary = positions.length
    ? positions.map((p) => `#${p.tokenId}${p.inRange ? '(レンジ内)' : '(レンジ外)'}`).join(' ')
    : 'ポジションなし';
  console.log(`[${new Date().toISOString()}] ${pair} = ${state.price.toFixed(2)} tick=${state.tick} | ${summary}`);

  await report({
    mode: config.mode,
    paused: control.paused,
    halted,
    updatedAt: new Date().toISOString(),
    chain: 'Arbitrum',
    wallet: config.wallet,
    settings: {
      rangeWidthPct: config.rangeWidthPct,
      rebalanceDelayMin: config.rebalanceDelayMin,
      pollIntervalSec: config.pollIntervalSec,
      maxDeployValue: config.maxDeployValue,
      maxRebalancesPerDay: config.maxRebalancesPerDay,
      slippagePct: config.slippagePct,
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
    gasSpentEth: formatEther(BigInt(saved.gasSpentWei)),
    rebalances24h: saved.rebalanceTimes.length,
    history: saved.history,
    events,
  });
}

async function main() {
  log('info', `起動しました（MODE=${config.mode}, wallet=${config.wallet}）`);
  if (config.mode === 'live') {
    log('warn', `実取引モードです。運用上限 ${config.maxDeployValue}、レンジ ±${config.rangeWidthPct}%、1日最大 ${config.maxRebalancesPerDay} 回`);
  }
  const pool = await loadPool(client, config.pool);
  log('info', `対象プール: ${pool.token0.symbol}/${pool.token1.symbol} fee=${pool.fee / 10000}%`);

  const executor = config.mode === 'live'
    ? makeExecutor({
        publicClient: client,
        config,
        pool,
        log,
        onGas: (wei) => {
          saved.gasSpentWei = (BigInt(saved.gasSpentWei) + wei).toString();
        },
      })
    : null;

  for (;;) {
    try {
      await tick(pool, executor);
    } catch (e) {
      log('error', `処理中にエラー: ${e.shortMessage || e.message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, config.pollIntervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
