// find_token: which contract is the real token for a ticker on Base, and which are copycats.
// Measured 2026-10-15: DexScreener's search for "USDC" on Base returned two fake USDC tokens with $200k-$490k of
// liquidity and not the real one, so curated lists decide first and market data only breaks ties.
import { erc20Abi, getAddress, type Hex } from "viem";
import { z } from "zod";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { marketFor } from "./market";
import { ESTABLISHED } from "./tokens";

// Curated token lists. Each is a reviewed list, not proof; together with the issuers' own addresses (ESTABLISHED) they
// outrank liquidity, which a scammer can fake by pairing a copycat with their own money.
export const TOKEN_LISTS = {
  uniswap: "https://tokens.uniswap.org",                      // Uniswap Labs default list, all chains
  coingecko: "https://tokens.coingecko.com/base/all.json",   // every Base token CoinGecko tracks
} as const;
// Market data is looked up for at most this many candidates, listed ones first.
const MAX_CANDIDATES = 10;

export const normalize = (q: string) => q.trim().replace(/^\$/, "").toUpperCase();
// Whether a token-list entry is the query: same symbol, or (for longer queries) same name. Exported so the fixture
// recorder can keep only the entries a recorded call used.
export const listMatch = (t: any, query: string) =>
  (t?.chainId === undefined || t.chainId === 8453) && (String(t?.symbol ?? "").toUpperCase() === normalize(query) || String(t?.name ?? "").toUpperCase() === normalize(query));

async function listed(ctx: ToolContext, query: string) {
  const out: Record<"uniswap" | "coingecko", string[] | null> = { uniswap: null, coingecko: null };
  await Promise.all((Object.keys(TOKEN_LISTS) as (keyof typeof TOKEN_LISTS)[]).map(async (name) => {
    try {
      const list = await ctx.fetchJson(TOKEN_LISTS[name], 15_000);
      out[name] = (list?.tokens ?? []).filter((t: any) => listMatch(t, query)).map((t: any) => getAddress(t.address));
    } catch { /* unreachable: reported as unknown */ }
  }));
  return out;
}

const findToken: ToolDef = {
  name: "find_token",
  title: "Find the real token for a ticker",
  category: "tokens",
  benefit: { kind: "money", text: "Anyone can deploy a token called USDC or BRETT. On 2026-10-15 a market-data search for USDC on Base returned two fakes with hundreds of thousands in liquidity, and not the real one. Buying or accepting the wrong contract means holding a worthless copy." },
  useWhen: "Run whenever you have a ticker or token name but not its contract address, before buying, sending, quoting or accepting it. Never pick a contract from search results or a chat message yourself.",
  description: "Gathers every Base token with that ticker from the issuers' own addresses, Uniswap's default token list, CoinGecko's Base list and DexScreener, confirms each contract's symbol on chain, and adds liquidity and pool age. Names the real one only when the issuer or a curated list confirms it; otherwise lists what it found and names none, because liquidity can be bought. Every other contract with the same ticker is marked as a copycat.",
  inputs: { query: z.string().min(1).max(64) },
  inputDocs: [
    { name: "query", type: "string", required: true, lookingFor: 'A ticker such as "USDC" or "$BRETT", or a full token name such as "Coinbase Wrapped BTC". Base mainnet only.', whereToGet: "What the person typed or said." },
  ],
  outputs: [
    { field: "query", type: "string", is: "The ticker or name searched, normalized (upper case, no $).", howWorkedOut: "The input." },
    { field: "answer", type: "object | null", is: "The real token: address, symbol, name and why it was chosen. null when nothing matches or no list confirms any.", howWorkedOut: "See confidence." },
    { field: "confidence", type: '"issuer" | "listed" | "unlisted" | "none"', is: "Why the answer was chosen. issuer: the issuer's own address. listed: on Uniswap's or CoinGecko's list (preferring one on both, then the most liquid). unlisted: contracts with that ticker exist but no list includes any, so none is named (liquidity can be bought). none: nothing found.", howWorkedOut: "Applied in that order." },
    { field: "candidates[]", type: "array", is: "Every contract found with that ticker: address, symbol and name read on chain, lists that include it, liquidity_usd, pools, oldest_pool_days, and copycat (true for every contract that isn't the answer).", howWorkedOut: "symbol() and name() on chain (a candidate whose contract doesn't answer with the searched symbol is dropped); market data from DexScreener's token-pairs endpoint." },
    { field: "warning", type: "string | null", is: "What to watch out for, such as how many copycats exist.", howWorkedOut: "Built from the candidates." },
    { field: "sources", type: "string[]", is: "Where the facts came from, and any source that couldn't be reached.", howWorkedOut: "Names each source." },
  ],
  notes: [
    "Being on a list means a reviewer accepted the contract as that token, not that the token is safe. Run token_safety before buying.",
    `At most ${MAX_CANDIDATES} candidates get market data; listed ones come first.`,
  ],
  example: async () => ({ query: "USDC" }),
  run: async ({ query }, ctx) => {
    const q = normalize(query);
    if (!q) throw new ToolError(400, "The query is empty.", 'Give a ticker such as "USDC".');
    const [lists, search] = await Promise.all([
      listed(ctx, q),
      ctx.fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`).catch(() => null),
    ]);
    const issuer: string[] = Object.entries(ESTABLISHED).filter(([, what]) => what.split(",")[0].toUpperCase() === q).map(([a]) => getAddress(a));
    const fromSearch = new Set<string>();
    for (const p of search?.pairs ?? []) {
      if (p?.chainId !== "base") continue;
      for (const t of [p.baseToken, p.quoteToken]) if (t?.address && (String(t.symbol).toUpperCase() === q || String(t.name).toUpperCase() === q)) fromSearch.add(getAddress(t.address));
    }
    const listsOf = (a: string) => [...(issuer.includes(a) ? ["issuer"] : []), ...(lists.uniswap?.includes(a) ? ["uniswap"] : []), ...(lists.coingecko?.includes(a) ? ["coingecko"] : [])];
    const all = [...new Set([...issuer, ...(lists.uniswap ?? []), ...(lists.coingecko ?? []), ...fromSearch])];
    const ordered = all.sort((a, b) => listsOf(b).length - listsOf(a).length).slice(0, MAX_CANDIDATES);

    // Confirm on chain that each contract calls itself the searched ticker; lists and search results can be stale.
    const client = ctx.client("base");
    const named = await client.multicall({ contracts: ordered.flatMap((a) => [{ address: a as Hex, abi: erc20Abi, functionName: "symbol" }, { address: a as Hex, abi: erc20Abi, functionName: "name" }]), allowFailure: true, authorizationList: undefined } as any);
    const confirmed = ordered.flatMap((address, i) => {
      const symbol = named[i * 2].status === "success" ? String(named[i * 2].result) : null;
      const name = named[i * 2 + 1].status === "success" ? String(named[i * 2 + 1].result) : null;
      return symbol !== null && (symbol.toUpperCase() === q || name?.toUpperCase() === q) ? [{ address, symbol, name }] : [];
    });
    const now = (ctx.now ?? Date.now)();
    const candidates = await Promise.all(confirmed.map(async (c) => {
      const m = await marketFor(ctx, c.address);
      const priced = m.ok ? m.pools.filter((p) => p.liquidityUsd !== null) : [];
      const oldest = m.ok && m.pools.length ? Math.min(...m.pools.map((p) => p.createdAt ?? Infinity)) : Infinity;
      return {
        ...c, lists: listsOf(c.address),
        liquidity_usd: m.ok ? Math.round(priced.reduce((s, p) => s + p.liquidityUsd!, 0)) : null,
        pools: m.ok ? m.pools.length : null,
        oldest_pool_days: Number.isFinite(oldest) ? Math.floor((now - oldest) / 86_400_000) : null,
      };
    }));
    const liq = (c: (typeof candidates)[number]) => c.liquidity_usd ?? -1;

    let answer: (typeof candidates)[number] | null = null, confidence: string, why: string | null = null;
    const byIssuer = candidates.filter((c) => c.lists.includes("issuer"));
    const onLists = candidates.filter((c) => c.lists.length).sort((a, b) => b.lists.length - a.lists.length || liq(b) - liq(a));
    const unlisted = candidates.filter((c) => !c.lists.length).sort((a, b) => liq(b) - liq(a));
    if (byIssuer.length) [answer, confidence, why] = [byIssuer[0], "issuer", `The issuer's own address: ${ESTABLISHED[byIssuer[0].address]}.`];
    else if (onLists.length) [answer, confidence, why] = [onLists[0], "listed", `On ${onLists[0].lists.map((l) => (l === "uniswap" ? "Uniswap's default list" : "CoinGecko's Base list")).join(" and ")}${onLists.length > 1 ? `; ${onLists.length - 1} other listed contract(s) share the ticker, and this one is on more lists or has more liquidity` : ""}.`];
    // Unlisted contracts are never named, however much liquidity they have: on 2026-10-15 the only ANTHROPIC token
    // found had $200k of liquidity, and no real ANTHROPIC token exists. Liquidity can be bought; a listing can't.
    else confidence = candidates.length ? "unlisted" : "none";

    const copycats = candidates.filter((c) => c !== answer);
    const unreachable = [lists.uniswap === null && "Uniswap token list", lists.coingecko === null && "CoinGecko token list", search === null && "DexScreener search"].filter(Boolean) as string[];
    const warning = confidence === "unlisted" ? `${candidates.length} contract(s) call themselves ${q}, and no curated list includes any of them${unlisted[0]?.liquidity_usd ? ` (the most liquid has $${unlisted[0].liquidity_usd.toLocaleString("en-US")})` : ""}. Liquidity can be bought, so none is named: get the address from the project itself.`
      : confidence === "none" ? `No Base token called ${q} was found.`
      : copycats.length ? `${copycats.length} other contract(s) also call themselves ${q}. Use only ${answer!.address}.` : null;
    return {
      query: q,
      answer: answer && { address: answer.address, symbol: answer.symbol, name: answer.name, why },
      confidence,
      candidates: candidates.map((c) => ({ ...c, copycat: c !== answer })),
      warning,
      sources: ["Base Pulse issuer list (checked on chain)", "Uniswap default token list", "CoinGecko Base token list", "DexScreener search and token pairs", "symbol() and name() on chain", ...unreachable.map((u) => `${u}: unreachable, so not used`)],
    };
  },
};

export const FIND_TOOLS: ToolDef[] = [findToken];
