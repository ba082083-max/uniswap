import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

// Uniswap v3 NonfungiblePositionManager (Arbitrum)
export const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

export const POOL_ABI = parseAbi([
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function deposit() payable',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
]);

export const NPM_ABI = parseAbi([
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
]);

export const MAX_UINT128 = 2n ** 128n - 1n;

export function makeClient(rpcUrl) {
  return createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
}

// token1 per token0（人間が読める単位）
export function tickToPrice(tick, dec0, dec1) {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

// 現在の tick を中心に ±widthPct% のレンジを tickSpacing に揃えて返す
export function proposeRange(tick, tickSpacing, widthPct) {
  const half = Math.round(Math.log(1 + widthPct / 100) / Math.log(1.0001));
  const tickLower = Math.floor((tick - half) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((tick + half) / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

// 流動性 L からポジション内のトークン量（raw 単位, float）を計算
function amountsForLiquidity(liquidity, sqrtP, tickLower, tickUpper) {
  const L = Number(liquidity);
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  if (sqrtP <= sa) return [(L * (sb - sa)) / (sa * sb), 0];
  if (sqrtP >= sb) return [0, L * (sb - sa)];
  return [(L * (sb - sqrtP)) / (sqrtP * sb), L * (sqrtP - sa)];
}

export async function loadPool(client, pool) {
  const [token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token1' }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'fee' }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'tickSpacing' }),
  ]);
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'symbol' }),
  ]);
  return {
    address: pool,
    token0: { address: token0, decimals: dec0, symbol: sym0 },
    token1: { address: token1, decimals: dec1, symbol: sym1 },
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
  };
}

export async function readPoolState(client, pool) {
  const [sqrtPriceX96, tick] = await client.readContract({
    address: pool.address,
    abi: POOL_ABI,
    functionName: 'slot0',
  });
  const t = Number(tick);
  return {
    tick: t,
    sqrtP: Number(sqrtPriceX96) / 2 ** 96,
    price: tickToPrice(t, pool.token0.decimals, pool.token1.decimals),
  };
}

// 過去 seconds 秒間の平均 tick（TWAP）
export async function readTwapTick(client, pool, seconds = 300) {
  const [tickCumulatives] = await client.readContract({
    address: pool.address,
    abi: POOL_ABI,
    functionName: 'observe',
    args: [[seconds, 0]],
  });
  const diff = Number(tickCumulatives[1] - tickCumulatives[0]);
  return Math.floor(diff / seconds);
}

// ポジション内のトークン量（raw, bigint）を現在価格で計算
export function positionAmountsRaw(liquidity, sqrtP, tickLower, tickUpper) {
  const [a0, a1] = amountsForLiquidity(liquidity, sqrtP, tickLower, tickUpper);
  return [BigInt(Math.floor(a0)), BigInt(Math.floor(a1))];
}

// 流動性 1 単位あたりの token0 / token1 必要量（raw, float）
export function unitAmounts(sqrtP, tickLower, tickUpper) {
  return amountsForLiquidity(1n, sqrtP, tickLower, tickUpper);
}

export async function readRawBalances(client, pool, wallet) {
  const [eth, b0, b1] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.readContract({ address: pool.token0.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    client.readContract({ address: pool.token1.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
  ]);
  return { eth, b0, b1 };
}

export async function readBalances(client, pool, wallet) {
  const [eth, b0, b1] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.readContract({ address: pool.token0.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    client.readContract({ address: pool.token1.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
  ]);
  return [
    { symbol: 'ETH', amount: formatUnits(eth, 18) },
    { symbol: pool.token0.symbol, amount: formatUnits(b0, pool.token0.decimals) },
    { symbol: pool.token1.symbol, amount: formatUnits(b1, pool.token1.decimals) },
  ];
}

// ウォレットが持つ、このプールのポジション（流動性 > 0）を取得
export async function readPositions(client, pool, state, wallet) {
  const count = await client.readContract({
    address: POSITION_MANAGER, abi: NPM_ABI, functionName: 'balanceOf', args: [wallet],
  });
  const ids = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({
        address: POSITION_MANAGER, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [wallet, BigInt(i)],
      })
    )
  );

  const { decimals: d0 } = pool.token0;
  const { decimals: d1 } = pool.token1;
  const result = [];
  for (const tokenId of ids) {
    const p = await client.readContract({
      address: POSITION_MANAGER, abi: NPM_ABI, functionName: 'positions', args: [tokenId],
    });
    const [, , t0, t1, fee, tickLower, tickUpper, liquidity] = p;
    if (t0.toLowerCase() !== pool.token0.address.toLowerCase()) continue;
    if (t1.toLowerCase() !== pool.token1.address.toLowerCase()) continue;
    if (Number(fee) !== pool.fee || liquidity === 0n) continue;

    // collect を静的呼び出しして未回収手数料を取得（実際には何も送信しない）
    const { result: [fees0, fees1] } = await client.simulateContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'collect',
      args: [{ tokenId, recipient: wallet, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      account: wallet,
    });

    const tl = Number(tickLower);
    const tu = Number(tickUpper);
    const [a0, a1] = amountsForLiquidity(liquidity, state.sqrtP, tl, tu);
    const amount0 = a0 / 10 ** d0;
    const amount1 = a1 / 10 ** d1;
    const f0 = Number(formatUnits(fees0, d0));
    const f1 = Number(formatUnits(fees1, d1));
    result.push({
      tokenId: tokenId.toString(),
      tickLower: tl,
      tickUpper: tu,
      priceLower: tickToPrice(tl, d0, d1),
      priceUpper: tickToPrice(tu, d0, d1),
      inRange: state.tick >= tl && state.tick < tu,
      liquidity: liquidity.toString(),
      amount0,
      amount1,
      fees0: f0,
      fees1: f1,
      // token1 建ての評価額（WETH/USDC なら USDC 建て）
      valueInToken1: amount0 * state.price + amount1,
      feesInToken1: f0 * state.price + f1,
    });
  }
  return result;
}
