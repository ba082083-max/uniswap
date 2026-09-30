// 実際に取引を行う部分（MODE=live のときだけ使われる）
import {
  createWalletClient, http, parseAbi, encodeFunctionData, formatUnits, formatEther, parseEther,
} from 'viem';
import { arbitrum } from 'viem/chains';
import {
  POSITION_MANAGER, NPM_ABI, ERC20_ABI, MAX_UINT128,
  readPoolState, readRawBalances, readTwapTick, positionAmountsRaw, unitAmounts, proposeRange, tickToPrice,
} from './uniswap.js';

// Uniswap SwapRouter02 (Arbitrum)
export const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

const ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

// x から pct% 引いた値（最低受取量の計算用）
function minus(x, pct) {
  return (x * BigInt(Math.round((100 - pct) * 100))) / 10000n;
}

function toBig(x) {
  return x > 0 ? BigInt(Math.floor(x)) : 0n;
}

export function makeExecutor({ publicClient, config, pool, log, onGas }) {
  const account = config.account;
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http(config.rpcUrl) });
  const me = account.address;
  const { token0, token1 } = pool;
  const fmt = (raw, token) => Number(formatUnits(raw, token.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 });

  async function deadline() {
    const block = await publicClient.getBlock();
    return block.timestamp + 600n;
  }

  // 事前にシミュレーションし、成功する場合だけ送信する
  async function send(label, req) {
    const { request } = await publicClient.simulateContract({ account, ...req });
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    onGas(receipt.gasUsed * receipt.effectiveGasPrice);
    if (receipt.status !== 'success') throw new Error(`${label} が失敗しました (tx ${hash})`);
    log('tx', `${label} 完了 tx=${hash}`);
    return receipt;
  }

  async function ensureAllowance(token, spender, amount) {
    if (amount === 0n) return;
    const current = await publicClient.readContract({
      address: token.address, abi: ERC20_ABI, functionName: 'allowance', args: [me, spender],
    });
    if (current >= amount) return;
    await send(`${token.symbol} の使用許可`, {
      address: token.address, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount],
    });
  }

  // 操作してよい状況かを確認。問題があれば理由（文字列）を返す
  async function preflight() {
    const eth = await publicClient.getBalance({ address: me });
    if (eth < parseEther(String(config.minEthForGas))) {
      return `ガス代用の ETH が不足しています（残高 ${formatEther(eth)} ETH）`;
    }
    const state = await readPoolState(publicClient, pool);
    const twap = await readTwapTick(publicClient, pool, 300);
    const deviationPct = Math.abs(Math.pow(1.0001, state.tick - twap) - 1) * 100;
    if (deviationPct > config.maxPriceDeviationPct) {
      return `価格が急変しているため待機します（5分平均との差 ${deviationPct.toFixed(2)}%）`;
    }
    return null;
  }

  // ポジションの流動性を全部引き出し、手数料と一緒に回収する
  async function closePosition(pos) {
    const state = await readPoolState(publicClient, pool);
    const tokenId = BigInt(pos.tokenId);
    const liquidity = BigInt(pos.liquidity);
    const [e0, e1] = positionAmountsRaw(liquidity, state.sqrtP, pos.tickLower, pos.tickUpper);
    const dl = await deadline();
    const calls = [
      encodeFunctionData({
        abi: NPM_ABI,
        functionName: 'decreaseLiquidity',
        args: [{
          tokenId, liquidity,
          amount0Min: minus(e0, config.slippagePct),
          amount1Min: minus(e1, config.slippagePct),
          deadline: dl,
        }],
      }),
      encodeFunctionData({
        abi: NPM_ABI,
        functionName: 'collect',
        args: [{ tokenId, recipient: me, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      }),
    ];
    await send(`ポジション #${pos.tokenId} を解除（手数料も回収）`, {
      address: POSITION_MANAGER, abi: NPM_ABI, functionName: 'multicall', args: [calls],
    });
  }

  // ガス代分を残して、余った ETH を WETH に変換
  async function wrapExcessEth() {
    if (!config.wrapExcessEth) return;
    if (![token0, token1].some((t) => t.address.toLowerCase() === WETH.toLowerCase())) return;
    const eth = await publicClient.getBalance({ address: me });
    const keep = parseEther(String(config.minEthForGas)) * 2n;
    const excess = eth - keep;
    if (excess < parseEther('0.0001')) return;
    await send(`${formatEther(excess)} ETH を WETH に変換`, {
      address: WETH, abi: ERC20_ABI, functionName: 'deposit', value: excess,
    });
  }

  async function swap(tokenIn, tokenOut, amountIn, expectedOut) {
    await ensureAllowance(tokenIn, SWAP_ROUTER, amountIn);
    const amountOutMinimum = minus(expectedOut, config.slippagePct + pool.fee / 10000);
    await send(`スワップ ${fmt(amountIn, tokenIn)} ${tokenIn.symbol} → ${tokenOut.symbol}`, {
      address: SWAP_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: pool.fee, recipient: me,
        amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n,
      }],
    });
  }

  // ウォレットの資金（上限 MAX_DEPLOY_VALUE）で、現在価格中心の新しいポジションを作る
  // 資金不足なら false を返す
  async function openPosition() {
    await wrapExcessEth();

    let state = await readPoolState(publicClient, pool);
    const range = proposeRange(state.tick, pool.tickSpacing, config.rangeWidthPct);
    let { b0, b1 } = await readRawBalances(publicClient, pool, me);
    let pRaw = state.sqrtP ** 2; // token1(raw) / token0(raw)
    const unit1 = 10 ** token1.decimals;

    const totalValue = Number(b0) * pRaw + Number(b1); // token1(raw) 建て
    const deploy = Math.min(totalValue, config.maxDeployValue * unit1);
    if (deploy < config.minOpenValue * unit1) {
      return { ok: false, reason: `資金不足のためポジションを作れません（運用可能額 ${(totalValue / unit1).toFixed(2)} ${token1.symbol}、最低 ${config.minOpenValue}）` };
    }

    // レンジに合わせた token0 / token1 の価値の比率
    const [u0, u1] = unitAmounts(state.sqrtP, range.tickLower, range.tickUpper);
    const share0 = (u0 * pRaw) / (u0 * pRaw + u1);
    const target0Value = deploy * share0;
    const target1 = deploy * (1 - share0);
    const minSwap = config.minSwapValue * unit1;

    const need1 = target1 - Number(b1);
    const need0Value = target0Value - Number(b0) * pRaw;
    if (need1 > minSwap) {
      let amountIn = toBig(need1 / pRaw);
      if (amountIn > b0) amountIn = b0;
      await swap(token0, token1, amountIn, toBig(Number(amountIn) * pRaw));
    } else if (need0Value > minSwap) {
      let amountIn = toBig(need0Value);
      if (amountIn > b1) amountIn = b1;
      await swap(token1, token0, amountIn, toBig(Number(amountIn) / pRaw));
    }

    // スワップ後の残高と価格で、入れられる最大の流動性を計算
    state = await readPoolState(publicClient, pool);
    ({ b0, b1 } = await readRawBalances(publicClient, pool, me));
    pRaw = state.sqrtP ** 2;
    const [v0, v1] = unitAmounts(state.sqrtP, range.tickLower, range.tickUpper);
    const L = Math.min(
      v0 > 0 ? Number(b0) / v0 : Infinity,
      v1 > 0 ? Number(b1) / v1 : Infinity,
      deploy / (v0 * pRaw + v1),
    ) * 0.999;
    const want0 = toBig(L * v0);
    const want1 = toBig(L * v1);
    const desired0 = want0 > b0 ? b0 : want0;
    const desired1 = want1 > b1 ? b1 : want1;

    await ensureAllowance(token0, POSITION_MANAGER, desired0);
    await ensureAllowance(token1, POSITION_MANAGER, desired1);

    const pl = tickToPrice(range.tickLower, token0.decimals, token1.decimals).toFixed(2);
    const pu = tickToPrice(range.tickUpper, token0.decimals, token1.decimals).toFixed(2);
    await send(`新ポジション作成 ${pl}〜${pu}（${fmt(desired0, token0)} ${token0.symbol} + ${fmt(desired1, token1)} ${token1.symbol}）`, {
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'mint',
      args: [{
        token0: token0.address, token1: token1.address, fee: pool.fee,
        tickLower: range.tickLower, tickUpper: range.tickUpper,
        amount0Desired: desired0, amount1Desired: desired1,
        amount0Min: minus(desired0, config.slippagePct),
        amount1Min: minus(desired1, config.slippagePct),
        recipient: me, deadline: await deadline(),
      }],
    });
    return { ok: true, priceLower: Number(pl), priceUpper: Number(pu) };
  }

  return { preflight, closePosition, openPosition };
}
