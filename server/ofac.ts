// OFAC's sanctions list (the SDN list, published by the US Treasury), reduced to its EVM addresses.
// The XML is the complete source: the CSV export cuts long remarks short and, measured 2026-10-15, missed 33 of the
// 124 EVM addresses. A copy ships in server/data/ofac-evm.json (scripts/update-ofac.ts); the server refreshes it from
// Treasury every 12 hours and keeps the copy if Treasury can't be reached.
import { getAddress } from "viem";
import bundled from "./data/ofac-evm.json";

export const OFAC_SDN_XML = "https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml";
export type SanctionedEntry = { uid: number; name: string; programs: string[]; tags: string[] };
export type SanctionsList = { published: string; fetchedAt: string; source: string; addresses: Record<string, SanctionedEntry> };

const REFRESH_MS = 12 * 3600_000;
let current: SanctionsList | null = null;

const text = (block: string, tag: string) => [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1].trim());

// Every 0x address listed as a "Digital Currency Address" (ETH, USDT, USDC, ARB, BSC, ETC...). The same key controls
// an address on every EVM chain, so each one is treated as sanctioned on Base too.
export function parseSdnXml(xml: string, fetchedAt = new Date().toISOString()): SanctionsList {
  if (!xml.trimEnd().endsWith("</sdnList>")) throw new Error("SDN XML is incomplete (download cut off)");
  const published = text(xml, "Publish_Date")[0] ?? "unknown";
  const addresses: Record<string, SanctionedEntry> = {};
  for (const entry of xml.split("<sdnEntry>").slice(1)) {
    const ids = [...entry.matchAll(/<idType>Digital Currency Address - ([A-Z0-9]+)<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g)];
    const evm = ids.filter(([, , n]) => /^0x[0-9a-fA-F]{40}$/.test(n.trim()));
    if (!evm.length) continue;
    const head = entry.split("<idList>")[0];
    const name = [text(head, "firstName")[0], text(head, "lastName")[0]].filter(Boolean).join(" ");
    const uid = Number(text(head, "uid")[0]);
    const programs = text(entry.split("</programList>")[0], "program");
    for (const [, tag, n] of evm) {
      const a = getAddress(n.trim().toLowerCase());
      const e = (addresses[a] ??= { uid, name, programs, tags: [] });
      if (!e.tags.includes(tag)) e.tags.push(tag);
    }
  }
  if (Object.keys(addresses).length < 50) throw new Error(`SDN XML parsed to only ${Object.keys(addresses).length} EVM addresses; refusing it`);
  return { published, fetchedAt, source: OFAC_SDN_XML, addresses };
}

export function sanctionsList(): SanctionsList {
  return (current ??= bundled as SanctionsList);
}

async function refresh() {
  try {
    const res = await fetch(OFAC_SDN_XML, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    current = parseSdnXml(await res.text());
    console.log(`OFAC list refreshed: published ${current.published}, ${Object.keys(current.addresses).length} EVM addresses`);
  } catch (error: any) {
    console.error("OFAC refresh failed, keeping the copy published", sanctionsList().published, "-", error?.message ?? error);
  }
}

export function startOfacRefresh() {
  void refresh();
  setInterval(refresh, REFRESH_MS).unref();
}
