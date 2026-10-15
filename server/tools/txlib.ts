// Shared by the transaction tools: decode what a transaction's logs moved and granted, name the function it calls,
// and simulate an unsigned transaction with every token and ETH movement traced.
import {
  decodeFunctionData, erc20Abi, formatUnits, getAddress, numberToHex, parseAbiItem, toFunctionSelector,
  type Abi, type Hex, type Log,
} from "viem";
import type { ToolContext } from "./types";
import { UNISWAP } from "./chain";
import { verifiedSource } from "./source";

// Event topics. https://eips.ethereum.org/EIPS/eip-20, -721, and Uniswap's Permit2.
export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  approvalForAll: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
  permit2Approval: "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b",
} as const;
// eth_simulateV1 with traceTransfers reports plain ETH movements as Transfer logs from this address.
export const ETH_PSEUDO = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const UNLIMITED_FROM = 2n ** 128n;

const word = (topic: Hex | undefined) => getAddress(`0x${(topic ?? "0x").slice(-40)}`);
const uint = (data: Hex) => (data && data !== "0x" ? BigInt(data.slice(0, 66)) : 0n);

export type Movement = { token: string; from: string; to: string; raw: bigint; nft_id: string | null };
export type Grant = { kind: "erc20" | "nft_all" | "permit2"; token: string; owner: string; spender: string; raw: bigint | null; approved?: boolean };

export function decodeLogs(logs: { address: string; topics: readonly Hex[] | Hex[]; data: Hex }[]) {
  const moves: Movement[] = [], grants: Grant[] = [];
  for (const l of logs) {
    const t = l.topics as Hex[];
    const address = getAddress(l.address);
    if (t[0] === TOPIC.transfer && t.length === 3) moves.push({ token: address.toLowerCase() === ETH_PSEUDO.toLowerCase() ? "ETH" : address, from: word(t[1]), to: word(t[2]), raw: uint(l.data), nft_id: null });
    else if (t[0] === TOPIC.transfer && t.length === 4) moves.push({ token: address, from: word(t[1]), to: word(t[2]), raw: 1n, nft_id: BigInt(t[3]).toString() });
    else if (t[0] === TOPIC.approval && t.length === 3) grants.push({ kind: "erc20", token: address, owner: word(t[1]), spender: word(t[2]), raw: uint(l.data) });
    else if (t[0] === TOPIC.approvalForAll && t.length === 3) grants.push({ kind: "nft_all", token: address, owner: word(t[1]), spender: word(t[2]), raw: null, approved: uint(l.data) === 1n });
    else if (t[0] === TOPIC.permit2Approval && address === UNISWAP.permit2) grants.push({ kind: "permit2", token: word(t[2]), owner: word(t[1]), spender: word(t[3]), raw: uint(l.data) });
  }
  return { moves, grants };
}

// Symbol and decimals for each token, read in one Multicall3 batch. ETH is built in.
export async function tokenMeta(ctx: ToolContext, tokens: string[], blockNumber?: bigint) {
  const list = [...new Set(tokens.filter((t) => t !== "ETH"))];
  const meta = new Map<string, { symbol: string | null; decimals: number | null }>([["ETH", { symbol: "ETH", decimals: 18 }]]);
  if (!list.length) return meta;
  const out = await ctx.client("base").multicall({ contracts: list.flatMap((t) => [{ address: t as Hex, abi: erc20Abi, functionName: "symbol" }, { address: t as Hex, abi: erc20Abi, functionName: "decimals" }]), allowFailure: true, blockNumber, authorizationList: undefined } as any);
  list.forEach((t, i) => meta.set(t, { symbol: out[i * 2].status === "success" ? String(out[i * 2].result) : null, decimals: out[i * 2 + 1].status === "success" ? Number(out[i * 2 + 1].result) : null }));
  return meta;
}
export const amount = (raw: bigint, decimals: number | null) => (decimals === null ? `${raw} raw units` : formatUnits(raw, decimals));

// Net change per token for each address that moved something: what each side gained or lost.
export function netChanges(moves: Movement[], meta: Map<string, { symbol: string | null; decimals: number | null }>, who: string[]) {
  return who.map((address) => {
    const per = new Map<string, bigint>();
    for (const m of moves.filter((m) => !m.nft_id)) {
      if (m.from === address) per.set(m.token, (per.get(m.token) ?? 0n) - m.raw);
      if (m.to === address) per.set(m.token, (per.get(m.token) ?? 0n) + m.raw);
    }
    const nfts = moves.filter((m) => m.nft_id && (m.from === address || m.to === address)).map((m) => ({ token: m.token, symbol: meta.get(m.token)?.symbol ?? null, nft_id: m.nft_id, change: m.to === address ? "received" : "sent" }));
    return {
      address,
      tokens: [...per.entries()].filter(([, v]) => v !== 0n).map(([token, v]) => ({ token, symbol: meta.get(token)?.symbol ?? null, change: `${v > 0n ? "+" : "-"}${amount(v < 0n ? -v : v, meta.get(token)?.decimals ?? null)}` })),
      nfts,
    };
  });
}

// The function a call runs: decoded with the target's verified ABI (its implementation's, for a proxy), else named from
// Sourcify's signature database, preferring names that match verified code. null for a plain transfer (no data).
export async function nameCall(ctx: ToolContext, to: string, data: Hex | undefined, implementation?: string | null) {
  if (!data || data === "0x") return null;
  const selector = data.slice(0, 10) as Hex;
  for (const target of [implementation, to].filter(Boolean) as string[]) {
    const source = await verifiedSource(ctx, target);
    if (!source?.abi) continue;
    try {
      const d = decodeFunctionData({ abi: source.abi as Abi, data });
      const item: any = (source.abi as any[]).find((f) => f.type === "function" && f.name === d.functionName && toFunctionSelector(f) === selector);
      return { name: d.functionName, signature: item ? `${d.functionName}(${item.inputs.map((i: any) => i.type).join(",")})` : d.functionName, args: stringify(d.args ?? []), source: `verified ABI (${source.from})` };
    } catch { /* selector not in this ABI */ }
  }
  try {
    const r = await ctx.fetchJson(`https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${selector}&filter=true`);
    const options: any[] = r?.result?.function?.[selector] ?? [];
    const best = options.find((o) => o.hasVerifiedContract) ?? options[0];
    if (best) {
      let args: unknown[] | null = null;
      try { args = stringify(decodeFunctionData({ abi: [parseAbiItem(`function ${best.name}`)] as Abi, data }).args ?? []); } catch { /* the name doesn't fit the data */ }
      return { name: String(best.name).split("(")[0], signature: best.name, args, source: `Sourcify signature database${best.hasVerifiedContract ? "" : " (no verified contract uses this name; it may be wrong)"}` };
    }
  } catch { /* unreachable */ }
  return { name: null, signature: selector, args: null, source: "unknown function: not verified and not in the signature database" };
}
const stringify = (v: unknown): any => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(stringify) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stringify(x)])) : v);

// Runs an unsigned transaction on top of the latest block (eth_simulateV1, nothing is sent) with ETH transfers traced.
// Tries each simulation node in turn; null when none answers.
export async function simulateTx(ctx: ToolContext, tx: { from: string; to: string; data?: Hex; value?: bigint }) {
  for (const node of (ctx.simulators?.() ?? [ctx.client("base")])) {
    try {
      const block = await node.getBlockNumber();
      const result: any = await node.request({
        method: "eth_simulateV1" as any,
        params: [{ blockStateCalls: [{ calls: [{ from: tx.from, to: tx.to, ...(tx.data ? { data: tx.data } : {}), ...(tx.value ? { value: numberToHex(tx.value) } : {}) }] }], traceTransfers: true, validation: false }, numberToHex(block)] as any,
      });
      const c = result?.[0]?.calls?.[0];
      if (!c) continue;
      return { block, ok: c.status === "0x1", logs: (c.logs ?? []) as Log[], gasUsed: BigInt(c.gasUsed ?? 0), error: c.error ? String(c.error.message ?? "reverted") : null, returnData: (c.returnData ?? "0x") as Hex };
    } catch { /* try the next node */ }
  }
  return null;
}
