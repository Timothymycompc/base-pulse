// Verified source code from Sourcify (https://docs.sourcify.dev, free, no key). Contracts verified only on Basescan are
// not here; for those the answer is "not found on Sourcify", never "unverified".
import type { Abi } from "viem";
import type { ToolContext } from "./types";

export type Verified = {
  found: boolean;
  match: string | null;     // "exact_match" or "match"
  name: string | null;      // contract name
  abi: Abi | null;
  proxy: { isProxy: boolean; type: string | null; implementation: string | null } | null;
};

const NOT_FOUND: Verified = { found: false, match: null, name: null, abi: null, proxy: null };

export async function sourcifyFor(ctx: ToolContext, address: string): Promise<Verified | null> {
  try {
    const d = await ctx.fetchJson(`https://sourcify.dev/server/v2/contract/8453/${address}?fields=abi,proxyResolution,compilation`);
    const impl = d?.proxyResolution?.implementations?.[0]?.address ?? null;
    return {
      found: Boolean(d?.match), match: d?.match ?? null, name: d?.compilation?.name ?? null,
      abi: Array.isArray(d?.abi) ? d.abi : null,
      proxy: d?.proxyResolution ? { isProxy: Boolean(d.proxyResolution.isProxy), type: d.proxyResolution.proxyType ?? null, implementation: impl } : null,
    };
  } catch (error: any) {
    // Sourcify answers 404 for a contract it has no source for.
    if (/HTTP 404/.test(String(error?.message))) return NOT_FOUND;
    return null; // unreachable: the caller reports "unknown"
  }
}

// Basescan's verified source through the Etherscan v2 API, when an ETHERSCAN_API_KEY secret is set (free key at
// https://etherscan.io/apis). Covers contracts verified only on Basescan, which Sourcify doesn't have.
export async function etherscanFor(ctx: ToolContext, address: string): Promise<Verified | null> {
  const key = ctx.etherscanKey ?? process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  try {
    const d = await ctx.fetchJson(`https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getsourcecode&address=${address}&apikey=${key}`);
    const r = Array.isArray(d?.result) ? d.result[0] : null;
    if (!r) return null;
    if (!r.SourceCode) return { ...NOT_FOUND };
    let abi: Abi | null = null;
    try { abi = JSON.parse(r.ABI); } catch { /* no ABI */ }
    return {
      found: true, match: "verified", name: r.ContractName || null, abi,
      proxy: r.Proxy === "1" ? { isProxy: true, type: "proxy", implementation: r.Implementation || null } : { isProxy: false, type: null, implementation: null },
    };
  } catch {
    return null;
  }
}

// Sourcify first (free), then Basescan when a key is set. null means neither could be reached.
export async function verifiedSource(ctx: ToolContext, address: string): Promise<(Verified & { from: "sourcify" | "basescan" | "none" }) | null> {
  const s = await sourcifyFor(ctx, address);
  if (s?.found) return { ...s, from: "sourcify" };
  const e = await etherscanFor(ctx, address);
  if (e?.found) return { ...e, from: "basescan" };
  if (s || e) return { ...NOT_FOUND, from: "none" };
  return null;
}
