// Measures token_safety on real tokens and records every answer as a test fixture.
//   BASE_RPC_URL=... npx tsx scripts/measure-token-safety.ts [newCount=40]
// Sample: tokens that got a new Uniswap pool against ETH or WETH in the last ~100 minutes (where scams appear), plus
// well-known tokens (where a false alarm would show). Each fixture keeps our result next to two independent checkers,
// GoPlus and honeypot.is, so agreement can be counted. Writes tests/fixtures/token-safety/*.json and ACCURACY.md.
import fs from "fs";
import path from "path";
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { base } from "viem/chains";
import { NATIVE, UNISWAP, WETH } from "../server/tools/chain";
import { TOKEN_TOOLS } from "../server/tools/tokens";
import { recordingContext } from "../tests/helpers/replay";
import { summarize, type Fixture } from "../tests/helpers/accuracy";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tests", "fixtures", "token-safety");
const WELL_KNOWN = [
  "0x532f27101965dd16442E59d40670FaF5eBB142E4", // BRETT
  "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN
  "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", // TOSHI
  "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
  "0x9a26F5433671751C3276a065f57e5a02D2817973", // KEYCAT
  "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d", // MIGGLES
  "0x768BE13e1680b5ebE0024C42c896E3dB59ec0149", // SKI
];

// Cases found while measuring, kept so they are always re-checked, with what the chain showed.
const KNOWN_CASES: { token: string; note: string }[] = [
  { token: "0x9eba351a2648d0893d8e26232bf11caaa214335e", note: "AMZN: GoPlus said honeypot; on chain 5 different wallets sold (4 had bought), so selling works; liquidity was pulled to $0." },
  { token: "0xc0e6971f9b1271777b490a273d745ce1b222f67f", note: "POOLS: same pattern as AMZN, same day: sellable, liquidity pulled to $0." },
];

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined, { timeout: 20_000 }) });
const ethSide = (a: string) => [WETH.toLowerCase(), NATIVE].includes(a.toLowerCase());

async function newTokens(limit: number): Promise<string[]> {
  const head = await client.getBlockNumber();
  const found = new Set<string>();
  const events = [
    { address: UNISWAP.v4PoolManager, event: parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)") },
    { address: UNISWAP.v3Factory, event: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)") },
    { address: UNISWAP.v2Factory, event: parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)") },
  ];
  // Pools at least 30 minutes old, so DexScreener has indexed them.
  for (let to = head - 900n; to > head - 3900n; to -= 1000n) {
    for (const e of events) {
      const logs = await client.getLogs({ address: e.address as Hex, event: e.event as any, fromBlock: to - 999n, toBlock: to });
      for (const l of logs as any[]) {
        const a0 = l.args.currency0 ?? l.args.token0, a1 = l.args.currency1 ?? l.args.token1;
        if (!a0 || !a1) continue;
        if (ethSide(a0) && !ethSide(a1)) found.add(a1);
        else if (ethSide(a1) && !ethSide(a0)) found.add(a0);
      }
    }
    if (found.size >= limit) break;
  }
  return [...found].slice(0, limit);
}

async function labels(token: string) {
  const get = async (url: string) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const gp: any = await get(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${token}`);
  const g = gp?.result ? Object.values(gp.result)[0] as any : null;
  const hp: any = await get(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=8453`);
  const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));
  return {
    goplus: g ? { is_honeypot: num(g.is_honeypot), buy_tax: num(g.buy_tax), sell_tax: num(g.sell_tax), cannot_sell_all: num(g.cannot_sell_all), is_mintable: num(g.is_mintable), is_proxy: num(g.is_proxy), is_open_source: num(g.is_open_source), owner_address: g.owner_address ?? null } : null,
    honeypot_is: hp?.honeypotResult ? { is_honeypot: Boolean(hp.honeypotResult.isHoneypot), buy_tax: hp.simulationResult?.buyTax ?? null, sell_tax: hp.simulationResult?.sellTax ?? null, pair: hp.pair?.pair?.type ?? null } : null,
  };
}

const newCount = Number(process.argv[2] ?? 40);
fs.mkdirSync(DIR, { recursive: true });
const sample: { token: string; group: Fixture["group"]; note?: string }[] = [
  ...WELL_KNOWN.map((t) => ({ token: t, group: "well_known" as const })),
  ...KNOWN_CASES.map((c) => ({ token: c.token, group: "case" as const, note: c.note })),
  ...(await newTokens(newCount)).map((t) => ({ token: t, group: "new" as const })),
];
console.log(`Sample: ${sample.length} tokens (${WELL_KNOWN.length} well known)`);
const fixtures: Fixture[] = [];
for (const { token, group, note } of sample) {
  const { ctx, recording } = recordingContext();
  let result: Record<string, unknown> | null = null, error: string | null = null;
  try { result = await TOKEN_TOOLS[0].run({ token }, ctx); } catch (e: any) { error = String(e?.message ?? e); }
  const fixture: Fixture = { token, group, ...(note ? { note } : {}), recordedAt: new Date(recording.now).toISOString(), result, error, labels: await labels(token), recording };
  fixtures.push(fixture);
  const name = `${String(result?.symbol ?? "unknown").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "token"}-${token.slice(2, 10).toLowerCase()}.json`;
  fs.writeFileSync(path.join(DIR, name), JSON.stringify(fixture));
  console.log(`${group.padEnd(10)} ${String(result?.symbol ?? "?").slice(0, 12).padEnd(12)} ${String(result?.verdict ?? `ERROR ${error?.slice(0, 60)}`)}`);
  await new Promise((r) => setTimeout(r, 1500)); // stay well inside the free services' limits
}
const report = summarize(fixtures);
fs.writeFileSync(path.join(DIR, "ACCURACY.md"), report);
console.log(`\n${report}`);
