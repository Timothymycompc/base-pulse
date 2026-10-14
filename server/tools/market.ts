// Market data for a token on Base: every pool DexScreener knows, with liquidity, age and which DEX it is on.
// https://docs.dexscreener.com/api/reference (token-pairs/v1, no key, 300 requests a minute). It lists at most 30 pools.
import type { ToolContext } from "./types";

export type Pool = {
  dex: string;            // dexId, e.g. "uniswap" or "aerodrome"
  version: string | null; // "v2", "v3", "v4" from DexScreener's labels, when given
  address: string;        // pair (v2) or pool (v3) contract; for v4, the pool id
  base: string;           // the token's side
  quote: string;          // the token it trades against
  quoteSymbol: string;
  liquidityUsd: number | null;
  createdAt: number | null; // ms since epoch
};

export type Market = { ok: true; pools: Pool[]; symbol: string | null; name: string | null; priceUsd: number | null } | { ok: false; error: string };

export async function marketFor(ctx: ToolContext, token: string): Promise<Market> {
  let pairs: any;
  try {
    pairs = await ctx.fetchJson(`https://api.dexscreener.com/token-pairs/v1/base/${token}`);
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  if (!Array.isArray(pairs)) return { ok: false, error: "unexpected answer from DexScreener" };
  const lower = token.toLowerCase();
  // DexScreener lists a pair under both of its tokens; keep the token as the base side so "quote" is the other one.
  const pools: Pool[] = pairs.filter((p: any) => p?.chainId === "base").map((p: any) => {
    const flipped = String(p.baseToken?.address ?? "").toLowerCase() !== lower;
    const other = flipped ? p.baseToken : p.quoteToken;
    return {
      dex: String(p.dexId ?? "unknown"),
      version: Array.isArray(p.labels) ? (p.labels.find((l: string) => /^v\d$/.test(l)) ?? null) : null,
      address: String(p.pairAddress ?? ""),
      base: token,
      quote: String(other?.address ?? ""),
      quoteSymbol: String(other?.symbol ?? ""),
      liquidityUsd: typeof p.liquidity?.usd === "number" ? p.liquidity.usd : null,
      createdAt: typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null,
    };
  });
  const own = pairs.find((p: any) => String(p.baseToken?.address ?? "").toLowerCase() === lower);
  return {
    ok: true, pools,
    symbol: own?.baseToken?.symbol ?? null, name: own?.baseToken?.name ?? null,
    priceUsd: own?.priceUsd ? Number(own.priceUsd) : null,
  };
}
