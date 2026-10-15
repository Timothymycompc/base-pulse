// approvals: who can move a wallet's tokens right now. History comes from Coinbase's SQL API (it finds every approval
// the wallet ever gave); whether each one is still live, and for how much, is then read from the chain.
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, maxUint160, parseAbi, type Hex } from "viem";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, UNISWAP } from "./chain";
import { verifiedSource } from "./source";

// Base's first block was mined in June 2023; history is searched from here in quarters, because Coinbase's SQL API
// refuses one query that scans more than ~93 GB, and a busy year of Base events is larger than that.
const HISTORY_START = Date.UTC(2023, 5, 1);
const CHUNK_MS = 91 * 86_400_000;
const MIN_CHUNK_MS = 7 * 86_400_000;
// The approvals we look for, as Coinbase's SQL API names their event signatures.
const SIGS = {
  erc20: "Approval(address,address,uint256)",                       // ERC-20 approve (ERC-721 single-token approvals share it; those carry no spender)
  forAll: "ApprovalForAll(address,address,bool)",                    // NFT collections: one operator may move every NFT
  permit2: "Approval(address,address,address,uint160,uint48)",       // Uniswap Permit2 allowance
  permit2Sig: "Permit(address,address,address,uint160,uint48,uint48)", // Permit2 allowance set by a signature
};
// An allowance this large never runs out in practice; wallets and dApps ask for 2^256-1 (or 2^160-1 on Permit2).
const UNLIMITED_FROM = 2n ** 128n;
// At most this many approvals are re-read on chain per call, newest first; the output says when more were found.
const MAX_CHECKED = 400;

const permit2Abi = parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)", "function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const forAllAbi = parseAbi(["function isApprovedForAll(address owner, address operator) view returns (bool)", "function setApprovalForAll(address operator, bool approved)", "function name() view returns (string)"]);

// Well-known spenders on Base, each confirmed on chain (see chain.ts). Anything else is described from its code.
const KNOWN_SPENDERS: Record<string, string> = {
  [UNISWAP.permit2]: "Uniswap Permit2",
  [UNISWAP.v2Router]: "Uniswap v2 router",
  [UNISWAP.v3Router]: "Uniswap SwapRouter02",
  [UNISWAP.universalRouter]: "Uniswap Universal Router",
};

type Found = { kind: "erc20" | "permit2" | "nft_all"; token: string; spender: string; last_block: number };

// Up to three retries for a dropped connection, a timeout or Coinbase's rate limit (429), waiting longer each time.
// A query that is simply too big is not retried: the caller splits it.
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error: any) {
      if (attempt >= 3 || /scanned more data/i.test(String(error?.message))) throw error;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// Every approval-type event the wallet emitted between from and to; a range too big for one query is split in two.
async function search(sql: NonNullable<ToolContext["sql"]>, owner: string, from: number, to: number, gaps: string[]): Promise<Found[]> {
  const query = `SELECT address, event_signature, parameters['spender'] AS spender, parameters['operator'] AS operator, parameters['token'] AS token, max(block_number) AS last_block FROM base.events WHERE event_signature IN ('${Object.values(SIGS).join("', '")}') AND parameters['owner'] = '${owner}' AND block_timestamp >= '${iso(from)}' AND block_timestamp < '${iso(to)}' AND action = 'added' GROUP BY address, event_signature, spender, operator, token`;
  let rows: Record<string, any>[];
  try {
    rows = await withRetry(() => sql(query));
  } catch (error: any) {
    if (to - from > MIN_CHUNK_MS && /scanned more data/i.test(String(error?.message))) {
      const mid = from + Math.floor((to - from) / 2);
      return [...(await search(sql, owner, from, mid, gaps)), ...(await search(sql, owner, mid, to, gaps))];
    }
    gaps.push(`${iso(from).slice(0, 10)} to ${iso(to).slice(0, 10)}`);
    return [];
  }
  return rows.flatMap((r): Found[] => {
    const last_block = Number(r.last_block);
    if (r.event_signature === SIGS.erc20 && r.spender) return [{ kind: "erc20", token: r.address, spender: r.spender, last_block }];
    if (r.event_signature === SIGS.forAll && r.operator) return [{ kind: "nft_all", token: r.address, spender: r.operator, last_block }];
    if ((r.event_signature === SIGS.permit2 || r.event_signature === SIGS.permit2Sig) && r.token && r.spender && r.address.toLowerCase() === UNISWAP.permit2.toLowerCase()) return [{ kind: "permit2", token: r.token, spender: r.spender, last_block }];
    return [];
  });
}

const approvals: ToolDef = {
  name: "approvals",
  title: "Who can move this wallet's tokens",
  category: "wallets",
  benefit: { kind: "money", text: "Most wallet drains don't steal a key: they use an approval the owner signed once, often months earlier, and forgot. This lists every approval still live, flags the dangerous ones and gives the transaction that revokes each." },
  useWhen: "Run when someone asks whether their wallet is safe, after they've signed something suspicious, after a drain, or before putting more money into a wallet. Also before you approve a new spender, to see what's already allowed.",
  description: "Finds every approval the wallet has given on Base (ERC-20 approvals, Uniswap Permit2 allowances and NFT approve-all), then reads from the chain which are still live and for how much. Each live approval says who the spender is (a wallet, a verified contract or unverified code), what's at risk, and includes the ready-to-send transaction that revokes it.",
  inputs: { wallet: addressInput },
  inputDocs: [
    { name: "wallet", type: "string", required: true, lookingFor: "The wallet to check: 0x followed by 40 hex characters. Base mainnet only.", whereToGet: "The user's wallet, or your own." },
  ],
  outputs: [
    { field: "wallet", type: "string", is: "The wallet, checksummed.", howWorkedOut: "The input." },
    { field: "verdict", type: '"CLEAR" | "REVIEW" | "DANGER"', is: "DANGER: at least one live approval to a plain wallet or to unverified code. REVIEW: live unlimited approvals to verified contracts, or history that couldn't be fully searched. CLEAR: no live approvals that put funds at risk.", howWorkedOut: "The worst approval wins." },
    { field: "summary", type: "string", is: "One sentence explaining the verdict.", howWorkedOut: "Built from the live approvals." },
    { field: "live[]", type: "array", is: "Approvals still in force, most dangerous first.", howWorkedOut: "Each found approval re-read on chain at one block: allowance() for ERC-20, Permit2's allowance() (with its expiry) and isApprovedForAll() for NFTs. Zero, expired or revoked ones are dropped." },
    { field: "live[].kind", type: '"erc20" | "permit2" | "nft_all"', is: "The type of approval.", howWorkedOut: "From the event that created it." },
    { field: "live[].token / symbol", type: "string / string | null", is: "The token or NFT collection.", howWorkedOut: "The approving contract; symbol() or name() read on chain." },
    { field: "live[].spender / spender_is", type: "string / string", is: "Who can move the tokens, and what that address is.", howWorkedOut: "A known Uniswap contract, a wallet (no code), or a contract named by its verified source (Sourcify or Basescan), or \"unverified contract\"." },
    { field: "live[].allowance / unlimited", type: "string | null / boolean", is: "How much the spender may take, in whole tokens (null for NFT approve-all, which covers every NFT), and whether it's effectively unlimited.", howWorkedOut: "The on-chain allowance divided by 10^decimals; unlimited above 2^128 raw units." },
    { field: "live[].balance", type: "string | null", is: "How much of the token the wallet holds now: what the spender could take today.", howWorkedOut: "balanceOf at the same block." },
    { field: "live[].expires", type: "string | null", is: "When a Permit2 allowance stops working.", howWorkedOut: "Permit2's expiration, as a date." },
    { field: "live[].risk / why", type: '"high" | "medium" | "low" / string', is: "How worried to be, and the reason.", howWorkedOut: "high: the spender is a plain wallet (phishing approvals usually go to one) or unverified code. medium: unlimited approval to a verified contract. low: a limited approval to a verified or well-known contract." },
    { field: "live[].revoke", type: "object", is: "The transaction that removes this approval: to, data, value \"0\".", howWorkedOut: "approve(spender, 0) on the token; for Permit2, approve(token, spender, 0, 0) on Permit2; for NFTs, setApprovalForAll(operator, false)." },
    { field: "found / checked", type: "number / number", is: "How many past approvals were found, and how many were re-read on chain.", howWorkedOut: `Distinct token and spender pairs in the history. At most ${MAX_CHECKED} are re-read, newest first.` },
    { field: "history", type: "object", is: "The time span searched and any gaps.", howWorkedOut: "Coinbase's SQL API, from June 2023 (Base's launch) to now, in quarters. gaps lists ranges that couldn't be searched: approvals made then aren't shown." },
    { field: "block", type: "number", is: "The block the live state was read at.", howWorkedOut: "The latest block." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Names each source." },
  ],
  notes: [
    "Approvals by signature that were never used (an off-chain Permit or Permit2 signature nobody submitted) leave no trace on chain until someone submits them, so no tool can list them.",
    "Base mainnet only: Coinbase's SQL API indexes Base mainnet.",
  ],
  example: async () => ({ wallet: EXAMPLE_WALLET }),
  run: async ({ wallet }, ctx) => {
    if (!ctx.sql) throw new ToolError(503, "The approval history source (Coinbase's SQL API) isn't configured on this server.", "Retry later.");
    const owner = checksum(wallet) as Hex;
    const now = (ctx.now ?? Date.now)();
    const gaps: string[] = [];
    const chunks: [number, number][] = [];
    for (let from = HISTORY_START; from < now; from += CHUNK_MS) chunks.push([from, Math.min(from + CHUNK_MS, now)]);
    // Four queries at a time: more at once made Coinbase drop connections.
    const found: Found[] = [];
    for (let i = 0; i < chunks.length; i += 4) found.push(...(await Promise.all(chunks.slice(i, i + 4).map(([a, b]) => search(ctx.sql!, owner.toLowerCase(), a, b, gaps)))).flat());
    // One entry per (kind, token, spender), newest first.
    const latest = new Map<string, Found>();
    for (const f of found) {
      const k = `${f.kind} ${f.token.toLowerCase()} ${f.spender.toLowerCase()}`;
      if ((latest.get(k)?.last_block ?? -1) < f.last_block) latest.set(k, f);
    }
    const pairs = [...latest.values()].sort((a, b) => b.last_block - a.last_block);
    const toCheck = pairs.slice(0, MAX_CHECKED);

    const client = ctx.client("base");
    const block = await client.getBlockNumber();
    // Reads go through Multicall3 in a few batched calls; a single failing call comes back as null, not an error.
    const many = async (calls: { address: string; abi: any; functionName: string; args?: unknown[] }[]) => {
      if (!calls.length) return [];
      const out = await client.multicall({ contracts: calls.map((c) => ({ ...c, address: c.address as Hex })) as any, blockNumber: block, allowFailure: true, authorizationList: undefined } as any);
      return out.map((r: any) => (r.status === "success" ? r.result : null));
    };
    const states = await many(toCheck.map((f) => f.kind === "erc20" ? { address: f.token, abi: erc20Abi, functionName: "allowance", args: [owner, f.spender] }
      : f.kind === "permit2" ? { address: UNISWAP.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, f.token, f.spender] }
      : { address: f.token, abi: forAllAbi, functionName: "isApprovedForAll", args: [owner, f.spender] }));
    const open = toCheck.flatMap((f, i) => {
      const s = states[i];
      if (s === null) return [];
      const raw: bigint = f.kind === "erc20" ? s : f.kind === "permit2" ? (Number(s[1]) * 1000 > now ? BigInt(s[0]) : 0n) : s ? maxUint160 : 0n;
      return raw > 0n ? [{ ...f, token: getAddress(f.token), spender: getAddress(f.spender), raw, expires: f.kind === "permit2" ? new Date(Number(s[1]) * 1000).toISOString() : null }] : [];
    });

    // What each live token is and how much the wallet holds; who each live spender is.
    const tokens = [...new Set(open.map((o) => o.token))];
    const info = await many(tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol" }, { address: t, abi: forAllAbi, functionName: "name" },
      { address: t, abi: erc20Abi, functionName: "decimals" }, { address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
    ]));
    const tokenInfo = new Map(tokens.map((t, i) => [t, { symbol: (info[i * 4] ?? info[i * 4 + 1] ?? null) as string | null, decimals: info[i * 4 + 2] === null ? null : Number(info[i * 4 + 2]), balance: info[i * 4 + 3] as bigint | null }]));
    const spenders = [...new Set(open.map((o) => o.spender))];
    const who = new Map(await Promise.all(spenders.map(async (spender): Promise<[string, { is: string; risky: boolean | null }]> => {
      if (KNOWN_SPENDERS[spender]) return [spender, { is: KNOWN_SPENDERS[spender], risky: false }];
      const code = await client.getCode({ address: spender as Hex, blockNumber: block });
      if (!code || code === "0x") return [spender, { is: "a wallet (no code)", risky: true }];
      if (code.toLowerCase().startsWith("0xef0100")) return [spender, { is: "a wallet run by delegated code (EIP-7702)", risky: true }];
      const source = await verifiedSource(ctx, spender);
      if (!source) return [spender, { is: "a contract (verification couldn't be checked)", risky: null }];
      return [spender, source.found ? { is: `verified contract ${source.name ?? ""}`.trim(), risky: false } : { is: "unverified contract", risky: true }];
    })));

    const live = open.map((o) => {
      const t = tokenInfo.get(o.token)!, w = who.get(o.spender)!;
      const unlimited = o.kind === "nft_all" || o.raw >= UNLIMITED_FROM;
      const risk = w.risky !== false ? "high" : unlimited ? "medium" : "low";
      const why = w.risky === true ? `The spender is ${w.is}. Phishing approvals go to wallets and unverified contracts like this; it can take ${unlimited ? "everything" : "up to the allowance"} at any time.`
        : w.risky === null ? "Whether the spender's code is verified couldn't be checked, so it's treated as unknown."
        : unlimited ? `${w.is} can take all of this token, now and in the future. Fine if you still use it; revoke it if not.`
        : `A limited approval to ${w.is}.`;
      const revoke = o.kind === "erc20" ? encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [o.spender as Hex, 0n] })
        : o.kind === "permit2" ? encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [o.token as Hex, o.spender as Hex, 0n, 0] })
        : encodeFunctionData({ abi: forAllAbi, functionName: "setApprovalForAll", args: [o.spender as Hex, false] });
      return {
        kind: o.kind, token: o.token, symbol: t.symbol, spender: o.spender, spender_is: w.is,
        allowance: o.kind === "nft_all" ? null : t.decimals === null ? o.raw.toString() : formatUnits(o.raw, t.decimals), unlimited,
        balance: o.kind === "nft_all" || t.balance === null || t.decimals === null ? null : formatUnits(t.balance, t.decimals),
        expires: o.expires, risk, why,
        revoke: { to: o.kind === "permit2" ? UNISWAP.permit2 : o.token, data: revoke, value: "0" },
      };
    });
    const order = { high: 0, medium: 1, low: 2 } as const;
    live.sort((a, b) => order[a.risk as keyof typeof order] - order[b.risk as keyof typeof order]);

    const high = live.filter((l) => l.risk === "high"), medium = live.filter((l) => l.risk === "medium");
    const incomplete = gaps.length > 0 || pairs.length > MAX_CHECKED;
    const verdict = high.length ? "DANGER" : medium.length || incomplete ? "REVIEW" : "CLEAR";
    const summary = high.length ? `${high.length} live approval${high.length > 1 ? "s" : ""} to a wallet or unverified code, starting with ${high[0].symbol ?? high[0].token} to ${high[0].spender}. Revoke ${high.length > 1 ? "them" : "it"} unless you know exactly who that is.`
      : medium.length ? `${medium.length} unlimited approval${medium.length > 1 ? "s" : ""} to verified contracts. Revoke any you no longer use.`
      : incomplete ? `No risky live approvals among those checked, but ${gaps.length ? `history for ${gaps.join(", ")} couldn't be searched` : `only the newest ${MAX_CHECKED} of ${pairs.length} were checked`}.`
      : live.length ? "Only limited approvals to verified contracts are live." : "No live approvals: nothing can move this wallet's tokens without a new signature.";
    return {
      wallet: owner, verdict, summary, live,
      found: pairs.length, checked: toCheck.length,
      history: { from: "2023-06-01", to: new Date(now).toISOString().slice(0, 10), gaps: gaps.sort() },
      block: Number(block),
      sources: ["Coinbase SQL API (base.events) for approval history", `Base RPC at block ${block}: allowance, Permit2 allowance, isApprovedForAll, balanceOf`, "Sourcify and Basescan for spender source"],
    };
  },
};

export const APPROVAL_TOOLS: ToolDef[] = [approvals];
