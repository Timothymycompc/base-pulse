// The trade test: buy a little of a token and sell it straight back, inside a simulation of the current block
// (eth_simulateV1), so a token that can be bought but not sold (a honeypot) is caught before anyone pays. Nothing is
// sent to the chain. Covers Uniswap v2 and v3 pools against WETH; other pools get "not tested" with the reason.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, maxUint256, numberToHex, parseAbi, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { UNISWAP, WETH } from "./chain";
import type { Pool } from "./market";
import type { ToolContext } from "./types";

// A made-up address, funded with ETH only inside the simulation. It has no code, like a normal wallet.
export const TRADER = "0x00000000000000000000000000000000B45E7E57";
export const BUY_ETH = 10n ** 16n; // 0.01 ETH
const DEADLINE = 2n ** 32n;

const v2Router = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);
const v3Router = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const v3Quoter = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const poolAbi = parseAbi(["function factory() view returns (address)", "function fee() view returns (uint24)"]);

export type TradePool = { kind: "v2"; address: string; liquidityUsd: number | null } | { kind: "v3"; address: string; fee: number; liquidityUsd: number | null };

// The deepest Uniswap v2 or v3 pool against WETH, checked on chain: DexScreener's labels are a hint, the pool's own
// factory() is the proof (forks reuse the names).
export async function pickTradePool(ctx: ToolContext, pools: Pool[]): Promise<TradePool | null> {
  const candidates = pools
    .filter((p) => p.dex === "uniswap" && (p.version === "v2" || p.version === "v3") && p.quote.toLowerCase() === WETH.toLowerCase())
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const client = ctx.client("base");
  for (const p of candidates.slice(0, 3)) {
    try {
      const factory = await client.readContract({ address: p.address as Hex, abi: poolAbi, functionName: "factory", authorizationList: undefined });
      if (p.version === "v2" && factory.toLowerCase() === UNISWAP.v2Factory.toLowerCase()) return { kind: "v2", address: p.address, liquidityUsd: p.liquidityUsd };
      if (p.version === "v3" && factory.toLowerCase() === UNISWAP.v3Factory.toLowerCase()) {
        const fee = await client.readContract({ address: p.address as Hex, abi: poolAbi, functionName: "fee", authorizationList: undefined });
        return { kind: "v3", address: p.address, fee, liquidityUsd: p.liquidityUsd };
      }
    } catch { /* not a pool we can read; try the next */ }
  }
  return null;
}

type Call = { to: string; data: Hex; value?: bigint };
type CallResult = { ok: boolean; data: Hex; error: string | null };

async function simulate(client: PublicClient<Transport, Chain>, block: bigint, calls: Call[]): Promise<CallResult[]> {
  const result: any = await client.request({
    method: "eth_simulateV1" as any,
    params: [{
      blockStateCalls: [{
        stateOverrides: { [TRADER]: { balance: numberToHex(10n ** 18n) } },
        calls: calls.map((c) => ({ from: TRADER, to: c.to, data: c.data, ...(c.value ? { value: numberToHex(c.value) } : {}) })),
      }],
      validation: false,
    }, numberToHex(block)] as any,
  });
  return (result?.[0]?.calls ?? []).map((c: any) => ({ ok: c.status === "0x1", data: c.returnData ?? "0x", error: c.error?.message ?? null }));
}

const balanceOf = (token: string): Call => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [TRADER as Hex] }) });
const readUint = (r: CallResult) => (r.ok ? decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.data }) : null);

function buyCalls(token: string, pool: TradePool): { quote: Call; buy: Call } {
  if (pool.kind === "v2") {
    const path = [WETH as Hex, token as Hex];
    return {
      quote: { to: UNISWAP.v2Router, data: encodeFunctionData({ abi: v2Router, functionName: "getAmountsOut", args: [BUY_ETH, path] }) },
      buy: { to: UNISWAP.v2Router, value: BUY_ETH, data: encodeFunctionData({ abi: v2Router, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, path, TRADER as Hex, DEADLINE] }) },
    };
  }
  return {
    quote: { to: UNISWAP.v3Quoter, data: encodeFunctionData({ abi: v3Quoter, functionName: "quoteExactInputSingle", args: [{ tokenIn: WETH as Hex, tokenOut: token as Hex, amountIn: BUY_ETH, fee: pool.fee, sqrtPriceLimitX96: 0n }] }) },
    buy: { to: UNISWAP.v3Router, value: BUY_ETH, data: encodeFunctionData({ abi: v3Router, functionName: "exactInputSingle", args: [{ tokenIn: WETH as Hex, tokenOut: token as Hex, fee: pool.fee, recipient: TRADER as Hex, amountIn: BUY_ETH, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) },
  };
}

function sellCalls(token: string, pool: TradePool, amount: bigint): { quote: Call; sell: Call; router: string } {
  if (pool.kind === "v2") {
    const path = [token as Hex, WETH as Hex];
    return {
      router: UNISWAP.v2Router,
      quote: { to: UNISWAP.v2Router, data: encodeFunctionData({ abi: v2Router, functionName: "getAmountsOut", args: [amount, path] }) },
      sell: { to: UNISWAP.v2Router, data: encodeFunctionData({ abi: v2Router, functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens", args: [amount, 0n, path, TRADER as Hex, DEADLINE] }) },
    };
  }
  return {
    router: UNISWAP.v3Router,
    quote: { to: UNISWAP.v3Quoter, data: encodeFunctionData({ abi: v3Quoter, functionName: "quoteExactInputSingle", args: [{ tokenIn: token as Hex, tokenOut: WETH as Hex, amountIn: amount, fee: pool.fee, sqrtPriceLimitX96: 0n }] }) },
    sell: { to: UNISWAP.v3Router, data: encodeFunctionData({ abi: v3Router, functionName: "exactInputSingle", args: [{ tokenIn: token as Hex, tokenOut: WETH as Hex, fee: pool.fee, recipient: TRADER as Hex, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }) },
  };
}

// The quoted amount out: the last entry of getAmountsOut (v2) or the first return value of the quoter (v3).
function quoted(pool: TradePool, r: CallResult): bigint | null {
  if (!r.ok) return null;
  if (pool.kind === "v2") return (decodeFunctionResult({ abi: v2Router, functionName: "getAmountsOut", data: r.data }) as readonly bigint[]).at(-1) ?? null;
  return (decodeFunctionResult({ abi: v3Quoter, functionName: "quoteExactInputSingle", data: r.data }) as readonly bigint[])[0] ?? null;
}

// Tax as a fraction of what the pool's own price says should arrive (0 = none, 1 = everything taken).
const taxOf = (expected: bigint | null, got: bigint | null) =>
  expected && expected > 0n && got !== null ? Math.max(0, Math.min(1, 1 - Number((got * 1_000_000n) / expected) / 1_000_000)) : null;

export type TradeTest = {
  block: number;
  pool: TradePool;
  bought: boolean;
  buyError: string | null;
  buyTax: number | null;
  sold: boolean | null;  // null when the buy failed, so there was nothing to sell
  sellError: string | null;
  sellTax: number | null;
};

// Runs on the first simulation node that answers. The block comes from that same node, so both steps see one state.
export async function tradeTest(ctx: ToolContext, token: string, pool: TradePool): Promise<TradeTest> {
  const nodes = ctx.simulators?.() ?? [ctx.client("base")];
  let lastError: unknown;
  for (const node of nodes) {
    try { return await tradeTestOn(node, token, pool); } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function tradeTestOn(client: PublicClient<Transport, Chain>, token: string, pool: TradePool): Promise<TradeTest> {
  const block = await client.getBlockNumber();
  const { quote, buy } = buyCalls(token, pool);
  const [buyQuote, buyResult, balance] = await simulate(client, block, [quote, buy, balanceOf(token)]);
  const received = readUint(balance);
  const base = { block: Number(block), pool };
  if (!buyResult.ok || !received) {
    return { ...base, bought: false, buyError: buyResult.error ?? (received === 0n ? "the buy went through but no tokens arrived" : "the buy failed"), buyTax: null, sold: null, sellError: null, sellTax: null };
  }
  const buyTax = taxOf(quoted(pool, buyQuote), received);

  // The same buy again (same block, so the same result), then approve the router and sell every token received.
  const s = sellCalls(token, pool, received);
  const approve: Call = { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.router as Hex, maxUint256] }) };
  const results = await simulate(client, block, [buy, approve, s.quote, s.sell, balanceOf(WETH)]);
  const [, approveResult, sellQuote, sellResult, wethBalance] = results;
  if (!approveResult.ok) return { ...base, bought: true, buyError: null, buyTax, sold: false, sellError: `approve failed: ${approveResult.error ?? "reverted"}`, sellTax: null };
  if (!sellResult.ok) return { ...base, bought: true, buyError: null, buyTax, sold: false, sellError: sellResult.error ?? "the sell reverted", sellTax: null };
  return { ...base, bought: true, buyError: null, buyTax, sold: true, sellError: null, sellTax: taxOf(quoted(pool, sellQuote), readUint(wethBalance)) };
}
