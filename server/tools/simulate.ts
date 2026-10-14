// The trade test: buy a little of a token and sell it straight back, inside a simulation of the current block
// (eth_simulateV1), so a token that can be bought but not sold (a honeypot) is caught before anyone pays. Nothing is
// sent to the chain. Covers Uniswap v2, v3 and v4 pools against ETH or WETH; other pools get "not tested" with the reason.
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, maxUint256, numberToHex, parseAbi, parseAbiItem,
  type Chain, type Hex, type PublicClient, type Transport,
} from "viem";
import { MULTICALL3, NATIVE, UNISWAP, WETH } from "./chain";
import type { Pool } from "./market";
import type { ToolContext } from "./types";

// A made-up address, funded with ETH only inside the simulation. It has no code, like a normal wallet.
export const TRADER = "0x00000000000000000000000000000000B45E7E57";
export const BUY_ETH = 10n ** 16n; // 0.01 ETH
const DEADLINE = 2n ** 32n;
const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2 ** 48 - 1;

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
const v4Quoter = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const universalRouter = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const weth = parseAbi(["function deposit() payable"]);
const multicall = parseAbi(["function getEthBalance(address addr) view returns (uint256 balance)"]);
const initialize = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");

export type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
export type TradePool =
  | { kind: "v2"; address: string; liquidityUsd: number | null }
  | { kind: "v3"; address: string; fee: number; liquidityUsd: number | null }
  | { kind: "v4"; address: string; key: PoolKey; liquidityUsd: number | null };

const isEthSide = (quote: string) => [WETH.toLowerCase(), NATIVE].includes(quote.toLowerCase());

// A v4 pool's settings (its PoolKey) from the Initialize event the pool manager logged when it was created. DexScreener's
// creation time says roughly which block to search: Base makes a block every 2 seconds.
async function v4Key(ctx: ToolContext, pool: Pool): Promise<PoolKey | null> {
  if (!pool.createdAt) return null;
  const client = ctx.client("base");
  const head = await client.getBlockNumber();
  const ageBlocks = BigInt(Math.max(0, Math.floor(((ctx.now ?? Date.now)() - pool.createdAt) / 2000)));
  const centre = head - ageBlocks;
  const logs = await client.getLogs({ address: UNISWAP.v4PoolManager as Hex, event: initialize, args: { id: pool.address as Hex }, fromBlock: centre - 2400n, toBlock: centre + 2400n > head ? head : centre + 2400n });
  const a = logs[0]?.args;
  return a ? { currency0: a.currency0!, currency1: a.currency1!, fee: a.fee!, tickSpacing: a.tickSpacing!, hooks: a.hooks! } : null;
}

// The deepest Uniswap pool against ETH or WETH, checked on chain: DexScreener's labels are a hint, the pool's own
// factory() (v2, v3) or creation event (v4) is the proof, since forks reuse the names.
export async function pickTradePool(ctx: ToolContext, pools: Pool[]): Promise<TradePool | null> {
  const candidates = pools
    .filter((p) => p.dex === "uniswap" && ["v2", "v3", "v4"].includes(p.version ?? "") && isEthSide(p.quote))
    .filter((p) => p.version === "v4" || p.quote.toLowerCase() === WETH.toLowerCase())
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  const client = ctx.client("base");
  for (const p of candidates.slice(0, 3)) {
    try {
      if (p.version === "v4") {
        const key = await v4Key(ctx, p);
        if (key) return { kind: "v4", address: p.address, key, liquidityUsd: p.liquidityUsd };
        continue;
      }
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

const call = (to: string, data: Hex, value?: bigint): Call => ({ to, data, ...(value ? { value } : {}) });
const balanceOf = (token: string) => call(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [TRADER as Hex] }));
const ethBalance = () => call(MULTICALL3, encodeFunctionData({ abi: multicall, functionName: "getEthBalance", args: [TRADER as Hex] }));
const readUint = (r: CallResult) => (r.ok ? decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.data }) : null);
const approve = (token: string, spender: string) => call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, maxUint256] }));
// Universal Router pulls tokens through Permit2: approve Permit2 on the token, then the router on Permit2.
const permit2Steps = (token: string) => [
  approve(token, UNISWAP.permit2),
  call(UNISWAP.permit2, encodeFunctionData({ abi: permit2, functionName: "approve", args: [token as Hex, UNISWAP.universalRouter as Hex, MAX_UINT160, MAX_UINT48] })),
];

// One v4 exact-input swap through the Universal Router: command V4_SWAP (0x10) with the actions SWAP_EXACT_IN_SINGLE (0x06),
// SETTLE_ALL (0x0c) and TAKE_ALL (0x0f), as in https://docs.uniswap.org/contracts/v4/quickstart/swap.
function v4Swap(key: PoolKey, zeroForOne: boolean, amountIn: bigint, value?: bigint): Call {
  const [tokenIn, tokenOut] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" },
    ] }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: 0n, hookData: "0x" }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, 0n]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settle, take]]);
  return call(UNISWAP.universalRouter, encodeFunctionData({ abi: universalRouter, functionName: "execute", args: ["0x10", [input], DEADLINE] }), value);
}
const v4Quote = (key: PoolKey, zeroForOne: boolean, amount: bigint) =>
  call(UNISWAP.v4Quoter, encodeFunctionData({ abi: v4Quoter, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne, exactAmount: amount, hookData: "0x" }] }));

// The calls for each pool kind. buy ends with the token arriving; sell starts with the tokens in hand. received/out
// read the balances that measure each side.
type Plan = {
  buy: Call[]; buyQuote: Call;
  sell: (amount: bigint) => { before: Call[]; quote: Call; swap: Call; out: Call; outBefore?: Call };
  quoted: (r: CallResult) => bigint | null;
};

function planFor(token: string, pool: TradePool): Plan {
  if (pool.kind === "v2") {
    const path = [WETH as Hex, token as Hex];
    const back = [token as Hex, WETH as Hex];
    return {
      buyQuote: call(UNISWAP.v2Router, encodeFunctionData({ abi: v2Router, functionName: "getAmountsOut", args: [BUY_ETH, path] })),
      buy: [call(UNISWAP.v2Router, encodeFunctionData({ abi: v2Router, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, path, TRADER as Hex, DEADLINE] }), BUY_ETH)],
      sell: (amount) => ({
        before: [approve(token, UNISWAP.v2Router)],
        quote: call(UNISWAP.v2Router, encodeFunctionData({ abi: v2Router, functionName: "getAmountsOut", args: [amount, back] })),
        swap: call(UNISWAP.v2Router, encodeFunctionData({ abi: v2Router, functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens", args: [amount, 0n, back, TRADER as Hex, DEADLINE] })),
        out: balanceOf(WETH),
      }),
      quoted: (r) => (r.ok ? (decodeFunctionResult({ abi: v2Router, functionName: "getAmountsOut", data: r.data }) as readonly bigint[]).at(-1) ?? null : null),
    };
  }
  if (pool.kind === "v3") {
    const single = (tokenIn: string, tokenOut: string, amountIn: bigint) => ({ tokenIn: tokenIn as Hex, tokenOut: tokenOut as Hex, fee: pool.fee, recipient: TRADER as Hex, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n });
    const quote = (tokenIn: string, tokenOut: string, amountIn: bigint) => call(UNISWAP.v3Quoter, encodeFunctionData({ abi: v3Quoter, functionName: "quoteExactInputSingle", args: [{ tokenIn: tokenIn as Hex, tokenOut: tokenOut as Hex, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }] }));
    return {
      buyQuote: quote(WETH, token, BUY_ETH),
      buy: [call(UNISWAP.v3Router, encodeFunctionData({ abi: v3Router, functionName: "exactInputSingle", args: [single(WETH, token, BUY_ETH)] }), BUY_ETH)],
      sell: (amount) => ({
        before: [approve(token, UNISWAP.v3Router)],
        quote: quote(token, WETH, amount),
        swap: call(UNISWAP.v3Router, encodeFunctionData({ abi: v3Router, functionName: "exactInputSingle", args: [single(token, WETH, amount)] })),
        out: balanceOf(WETH),
      }),
      quoted: (r) => (r.ok ? (decodeFunctionResult({ abi: v3Quoter, functionName: "quoteExactInputSingle", data: r.data }) as readonly bigint[])[0] ?? null : null),
    };
  }
  // v4: the ETH side is native ETH (sent as value) or WETH (wrapped first, then paid through Permit2).
  const key = pool.key;
  const ethIs0 = key.currency0.toLowerCase() !== token.toLowerCase();
  const ethSide = ethIs0 ? key.currency0 : key.currency1;
  const native = ethSide.toLowerCase() === NATIVE;
  return {
    buyQuote: v4Quote(key, ethIs0, BUY_ETH),
    buy: native
      ? [v4Swap(key, ethIs0, BUY_ETH, BUY_ETH)]
      : [call(WETH, encodeFunctionData({ abi: weth, functionName: "deposit" }), BUY_ETH), ...permit2Steps(WETH), v4Swap(key, ethIs0, BUY_ETH)],
    sell: (amount) => ({
      before: permit2Steps(token),
      quote: v4Quote(key, !ethIs0, amount),
      swap: v4Swap(key, !ethIs0, amount),
      out: native ? ethBalance() : balanceOf(WETH),
      outBefore: native ? ethBalance() : undefined,
    }),
    quoted: (r) => (r.ok ? (decodeFunctionResult({ abi: v4Quoter, functionName: "quoteExactInputSingle", data: r.data }) as readonly bigint[])[0] ?? null : null),
  };
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
  const plan = planFor(token, pool);
  const first = await simulate(client, block, [plan.buyQuote, ...plan.buy, balanceOf(token)]);
  const buyResults = first.slice(1, -1);
  const received = readUint(first.at(-1)!);
  const base = { block: Number(block), pool };
  const failedBuy = buyResults.find((r) => !r.ok);
  if (failedBuy || !received) {
    return { ...base, bought: false, buyError: failedBuy?.error ?? (received === 0n ? "the swap went through but no tokens arrived; the pool may have no liquidity at the current price" : "the buy failed"), buyTax: null, sold: null, sellError: null, sellTax: null };
  }
  const buyTax = taxOf(plan.quoted(first[0]), received);

  // The same buy again (same block, so the same result), then the approvals and a sell of every token received.
  const s = plan.sell(received);
  const second = await simulate(client, block, [...plan.buy, ...s.before, s.quote, ...(s.outBefore ? [s.outBefore] : []), s.swap, s.out]);
  let i = plan.buy.length;
  const approvals = second.slice(i, i += s.before.length);
  const sellQuote = second[i++];
  const outBefore = s.outBefore ? readUint(second[i++]) : 0n;
  const swap = second[i++];
  const outAfter = readUint(second[i]);
  const failedApproval = approvals.find((r) => !r.ok);
  if (failedApproval) return { ...base, bought: true, buyError: null, buyTax, sold: false, sellError: `approve failed: ${failedApproval.error ?? "reverted"}`, sellTax: null };
  if (!swap.ok) return { ...base, bought: true, buyError: null, buyTax, sold: false, sellError: swap.error ?? "the sell reverted", sellTax: null };
  const got = outAfter !== null && outBefore !== null ? outAfter - outBefore : null;
  return { ...base, bought: true, buyError: null, buyTax, sold: true, sellError: null, sellTax: taxOf(plan.quoted(sellQuote), got) };
}
