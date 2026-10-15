// Screening tools: is this address sanctioned, and has it dealt directly with sanctioned addresses on Base.
import { getAddress } from "viem";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, networkInput } from "./chain";
import { describe } from "./address";
import { sanctionsList, type SanctionsList } from "../ofac";

// A list older than this gets a note: OFAC adds crypto addresses a few times a month.
const STALE_DAYS = 14;
const listOf = (ctx: ToolContext) => (ctx.sanctions ? ctx.sanctions() : Promise.resolve(sanctionsList()));
const publishedMs = (list: SanctionsList) => {
  const [m, d, y] = list.published.split("/").map(Number);
  return y ? Date.UTC(y, m - 1, d) : NaN;
};

// Direct transfers between the wallet and any sanctioned address on Base, from Coinbase's SQL API (base.transfers).
// A transfer counts only when the sending side signed the transaction (transaction_from). Any token contract can emit a
// Transfer event naming any sender: measured 2026-10-15, spam tokens had forged "transfers" from vitalik.eth to two
// sanctioned people, and from a sanctioned address to another wallet, each signed by an unrelated third party.
// Those are counted as forged and never decide the verdict. Returns null when the history couldn't be read.
export async function directExposure(ctx: ToolContext, wallet: string, list: SanctionsList) {
  if (!ctx.sql) return null;
  const listed = Object.keys(list.addresses).map((a) => `'${a.toLowerCase()}'`).join(", ");
  const w = wallet.toLowerCase();
  const cols = "count() AS transfers, min(block_timestamp) AS first, max(block_timestamp) AS last";
  try {
    const [incoming, outgoing] = await Promise.all([
      ctx.sql(`SELECT from_address AS counterparty, transaction_from = from_address AS signed, ${cols} FROM base.transfers WHERE from_address IN (${listed}) AND to_address = '${w}' AND action = 'added' GROUP BY counterparty, signed`),
      ctx.sql(`SELECT to_address AS counterparty, transaction_from = from_address AS signed, ${cols} FROM base.transfers WHERE from_address = '${w}' AND to_address IN (${listed}) AND action = 'added' GROUP BY counterparty, signed`),
    ]);
    const genuine = (r: Record<string, any>) => r.signed === true || r.signed === 1 || r.signed === "1" || r.signed === "true";
    const shape = (direction: "received_from" | "sent_to") => (r: Record<string, any>) => {
      const a = getAddress(r.counterparty);
      return { direction, counterparty: a, entity: list.addresses[a]?.name ?? null, transfers: Number(r.transfers), first: String(r.first).slice(0, 10), last: String(r.last).slice(0, 10) };
    };
    const rows = [...incoming.map((r) => ({ r, d: "received_from" as const })), ...outgoing.map((r) => ({ r, d: "sent_to" as const }))];
    return {
      direct: rows.filter((x) => genuine(x.r)).map((x) => shape(x.d)(x.r)).sort((a, b) => b.transfers - a.transfers),
      forged: rows.filter((x) => !genuine(x.r)).reduce((n, x) => n + Number(x.r.transfers), 0),
    };
  } catch {
    return null;
  }
}

const sanctionsCheck: ToolDef = {
  name: "sanctions_check",
  title: "Sanctions screen (OFAC)",
  category: "wallets",
  benefit: { kind: "money", text: "Paying or accepting funds from a sanctioned address can get funds frozen and break the law in the US and many other places. The US Treasury lists the addresses; most agents never look." },
  useWhen: "Run before paying, accepting a payment from, or onboarding an address. Answers whether it is on the US Treasury's sanctions list (OFAC SDN) and whether it has sent to or received from a listed address on Base.",
  description: "Checks the address against every Ethereum-style address on OFAC's SDN list (Treasury's official XML, refreshed every 12 hours), and searches its whole Base transfer history for direct transfers to or from any listed address. Says which sanctioned entity and program each match belongs to.",
  inputs: { address: addressInput },
  inputDocs: [
    { name: "address", type: "string", required: true, lookingFor: "The address to screen: 0x followed by 40 hex characters.", whereToGet: "The payer, payee or counterparty." },
  ],
  outputs: [
    { field: "address", type: "string", is: "The address, checksummed.", howWorkedOut: "The input." },
    { field: "verdict", type: '"SANCTIONED" | "DIRECT_EXPOSURE" | "CLEAR" | "NOT_LISTED"', is: "SANCTIONED: the address is on the list. DIRECT_EXPOSURE: not listed, but it has sent to or received from a listed address on Base. CLEAR: not listed and no direct transfers found. NOT_LISTED: not listed, but its history couldn't be searched, so exposure is unknown.", howWorkedOut: "From listing and exposure below." },
    { field: "summary", type: "string", is: "One sentence explaining the verdict.", howWorkedOut: "Built from the facts below." },
    { field: "listing", type: "object | null", is: "When listed: the sanctioned entity's name, its OFAC entry id (uid), the sanctions programs, and which chains OFAC tagged the address on.", howWorkedOut: "The address's \"Digital Currency Address\" entry in the SDN XML. The same key controls an address on every EVM chain, so an address OFAC tagged on Ethereum is the same holder on Base." },
    { field: "exposure", type: "array | null", is: "Direct transfers with listed addresses on Base: direction, counterparty, entity, number of transfers, first and last date. null when history couldn't be searched.", howWorkedOut: "Coinbase's SQL API over every Base token transfer (base.transfers), counting a transfer only when the sending side signed the transaction. Only direct transfers: funds that passed through other wallets first aren't traced, and tokens moved by an approved spender (transferFrom) aren't counted." },
    { field: "forged_events_ignored", type: "number | null", is: "Transfer events naming this address and a listed one that neither side signed: fakes emitted by spam tokens. Ignored for the verdict.", howWorkedOut: "Transfers whose transaction wasn't sent by the sending side (transaction_from differs from the sender)." },
    { field: "list", type: "object", is: "Which list was used: its publish date, how many EVM addresses it holds, and when it was fetched.", howWorkedOut: "Treasury's SDN XML; the server refreshes it every 12 hours." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Names each source." },
  ],
  notes: [
    "This is a screen against one official list, not legal advice. Other countries keep their own lists, and OFAC also sanctions people whose addresses it hasn't published.",
    "Exposure counts only direct transfers on Base. Funds routed through other wallets, bridges or mixers first are not traced.",
  ],
  example: async () => ({ address: EXAMPLE_WALLET }),
  run: async ({ address }, ctx) => {
    const wallet = checksum(address);
    const list = await listOf(ctx);
    if (!Object.keys(list.addresses).length) throw new ToolError(503, "The sanctions list isn't loaded.", "Retry shortly.");
    const listing = list.addresses[wallet] ?? null;
    const found = await directExposure(ctx, wallet, list);
    const exposure = found?.direct ?? null;
    const verdict = listing ? "SANCTIONED" : exposure === null ? "NOT_LISTED" : exposure.length ? "DIRECT_EXPOSURE" : "CLEAR";
    const top = exposure?.[0];
    const summary = listing ? `On OFAC's SDN list as ${listing.name} (${listing.programs.join(", ")}). Don't send to it or accept funds from it.`
      : verdict === "DIRECT_EXPOSURE" ? `Not on the list itself, but it has ${top!.direction === "sent_to" ? "sent to" : "received from"} ${top!.entity ?? "a listed address"} (${top!.counterparty}) on Base${exposure!.length > 1 ? `, and ${exposure!.length - 1} more listed address(es)` : ""}.`
      : verdict === "CLEAR" ? `Not on OFAC's SDN list, and no direct transfers with listed addresses on Base.${found!.forged ? ` ${found!.forged} forged transfer event(s) name it next to a listed address, emitted by spam tokens in transactions neither side signed; they are ignored.` : ""}`
      : "Not on OFAC's SDN list. Its Base history couldn't be searched, so direct exposure is unknown.";
    const age = ((ctx.now ?? Date.now)() - publishedMs(list)) / 86_400_000;
    return {
      address: wallet, verdict, summary, listing, exposure, forged_events_ignored: found?.forged ?? null,
      list: { published: list.published, evm_addresses: Object.keys(list.addresses).length, fetched_at: list.fetchedAt, ...(age > STALE_DAYS ? { note: `This copy of the list is ${Math.floor(age)} days old; newer listings may be missing.` } : {}) },
      sources: [`OFAC SDN list (US Treasury), published ${list.published}`, exposure === null ? "Base transfer history: unavailable" : "Coinbase SQL API (base.transfers) for direct transfers on Base"],
    };
  },
};

// Wallet apps shorten addresses to their first and last few characters (0x3075…7d31), so poisoners grind addresses that
// match those. 4 + 4 is what the poisoned addresses found on 2026-10-15 matched.
const LOOK = 4;
const ends = (a: string) => `${a.slice(2, 2 + LOOK)}…${a.slice(-LOOK)}`.toLowerCase();

// Who the wallet has really paid, and which addresses only appear through transfers it never signed.
async function sendHistory(ctx: ToolContext, wallet: string) {
  if (!ctx.sql) return null;
  try {
    const rows = await ctx.sql(`SELECT to_address, transaction_from = from_address AS signed, value = '0' AS zero, count() AS n, max(block_timestamp) AS last FROM base.transfers WHERE from_address = '${wallet.toLowerCase()}' AND action = 'added' GROUP BY to_address, signed, zero ORDER BY n DESC LIMIT 5000`);
    const yes = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
    const paid = new Map<string, { n: number; last: string }>(), planted = new Map<string, number>();
    for (const r of rows) {
      const to = getAddress(r.to_address);
      if (yes(r.signed) && !yes(r.zero)) {
        const p = paid.get(to);
        paid.set(to, { n: (p?.n ?? 0) + Number(r.n), last: [p?.last ?? "", String(r.last).slice(0, 10)].sort().at(-1)! });
      } else planted.set(to, (planted.get(to) ?? 0) + Number(r.n));
    }
    return { paid, planted, complete: rows.length < 5000 };
  } catch {
    return null;
  }
}

type Check = { name: string; result: "pass" | "info" | "warn" | "fail"; detail: string; source: string };

const recipientCheck: ToolDef = {
  name: "recipient_check",
  title: "Is this the right address to send to?",
  category: "wallets",
  benefit: { kind: "money", text: "Address poisoning plants a look-alike of someone you pay (same first and last characters) in your history, hoping you copy it next time. On 2026-10-15 one Base wallet that paid 0x307576dd…7d31 had three look-alikes planted through hundreds of fake transfers. Sending to a token contract or a sanctioned address loses the money too." },
  useWhen: "Run right before sending funds, with the sender's wallet and the address you're about to send to, especially when the address was copied from transaction history, a chat or an email.",
  description: "Checks the recipient against the sender's own Base history: whether the sender has really paid it before, whether it is a look-alike (same first and last 4 characters) of someone the sender has paid, and whether it only appears through transfers the sender never signed (zero-value or fake-token transfers, how poisoners plant addresses). Also reads what the recipient is (a token contract or unverified code loses funds) and screens it against OFAC's sanctions list.",
  inputs: { from: addressInput, to: addressInput, network: networkInput },
  inputDocs: [
    { name: "from", type: "string", required: true, lookingFor: "The wallet that will send.", whereToGet: "Your wallet, or the user's." },
    { name: "to", type: "string", required: true, lookingFor: "The address you're about to send to.", whereToGet: "The full address you were given or copied. Paste it whole, never retype it from its first and last characters." },
    { name: "network", type: "string", required: false, lookingFor: '"base" (default). History checks need Base mainnet.', whereToGet: "Leave it out." },
  ],
  outputs: [
    { field: "verdict", type: '"SAFE" | "CAUTION" | "AVOID"', is: "AVOID: a check failed (look-alike, planted address, token contract, sanctioned). CAUTION: something to confirm first. SAFE: none of the traps we check for.", howWorkedOut: "The worst check wins." },
    { field: "summary", type: "string", is: "One sentence explaining the verdict.", howWorkedOut: "Built from the checks." },
    { field: "checks[]", type: "array", is: "Each check: name (history, lookalike, planted, recipient_kind, sanctions), result, detail and source.", howWorkedOut: "History from Coinbase's SQL API (base.transfers): a past payment counts only when the sender signed it and it moved a non-zero amount. Look-alike: same first and last 4 hex characters as an address the sender has paid, but different. Planted: appears in the sender's history only through transfers it didn't sign or that moved nothing. Kind from the recipient's code (whats_this). Sanctions from OFAC's SDN list." },
    { field: "lookalike_of", type: "string | null", is: "The address the recipient imitates, when it is a look-alike.", howWorkedOut: "The paid address with the same first and last 4 characters." },
    { field: "times_paid_before", type: "number", is: "How many real transfers the sender has made to this exact address on Base.", howWorkedOut: "Signed, non-zero transfers in base.transfers." },
    { field: "recipient", type: "object", is: "What the recipient is: kind, delegated_to, verified source.", howWorkedOut: "The same reads as whats_this." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Names each source." },
  ],
  notes: ["A first payment to a new address is normal and isn't flagged by itself; the look-alike and planted checks are what catch poisoning.", "History covers token transfers on Base (base.transfers). A wallet with more than 5,000 distinct recipients is only partly checked, and the output says so."],
  example: async () => ({ from: EXAMPLE_WALLET, to: "0x000000000000000000000000000000000000dEaD" }),
  run: async ({ from, to, network }, ctx) => {
    const sender = checksum(from), recipient = checksum(to);
    if (sender === recipient) throw new ToolError(400, "from and to are the same address.", "Pass the sender's wallet as from and the recipient as to.");
    const [d, list, history] = await Promise.all([describe(ctx, network, recipient), listOf(ctx), network === "base" ? sendHistory(ctx, sender) : Promise.resolve(null)]);
    const checks: Check[] = [];
    const add = (name: string, result: Check["result"], detail: string, source: string) => checks.push({ name, result, detail, source });

    const listing = list.addresses[recipient];
    if (listing) add("sanctions", "fail", `The recipient is on OFAC's sanctions list as ${listing.name} (${listing.programs.join(", ")}).`, `OFAC SDN list, published ${list.published}`);
    else add("sanctions", "pass", "Not on OFAC's sanctions list.", `OFAC SDN list, published ${list.published}`);

    if (d.kind === "token") add("recipient_kind", "fail", `The recipient is a token contract (${d.token?.symbol}). Tokens sent to a token's own contract are almost always lost.`, "eth_getCode and the contract's answers");
    else if (d.kind === "delegated_wallet" && d.source.verified !== true) add("recipient_kind", "warn", `The recipient is a wallet run by code at ${d.delegated_to} whose source ${d.source.verified === false ? "isn't verified" : "couldn't be checked"}.`, "EIP-7702 delegation in the recipient's code");
    else if (d.kind === "contract" || d.kind === "nft") add("recipient_kind", "warn", `The recipient is a contract${d.source.name ? ` (${d.source.name})` : ""}, not a wallet. Make sure it is meant to receive this token, or the funds may be stuck.`, "eth_getCode");
    else add("recipient_kind", "pass", d.kind === "multisig" ? "The recipient is a Safe multisig wallet." : "The recipient is a wallet.", "eth_getCode");

    const paidBefore = history?.paid.get(recipient);
    let lookalikeOf: string | null = null;
    if (!history) add("history", "warn", "The sender's history couldn't be searched, so look-alike and planted-address checks didn't run.", "Coinbase SQL API (base.transfers)");
    else {
      const twin = [...history.paid.entries()].filter(([a]) => a !== recipient && ends(a) === ends(recipient)).sort((a, b) => b[1].n - a[1].n)[0];
      if (twin) {
        lookalikeOf = twin[0];
        add("lookalike", "fail", `Address poisoning: ${recipient} looks like ${twin[0]} (both ${ends(recipient)}), which this wallet has really paid ${twin[1].n} time(s), last on ${twin[1].last}. They are different addresses.`, "Coinbase SQL API (base.transfers)");
      }
      const planted = history.planted.get(recipient);
      if (planted && !paidBefore) add("planted", "fail", `This address appears in the sender's history only through ${planted} transfer(s) the sender never signed or that moved nothing: that is how poisoners plant addresses to be copied.`, "Coinbase SQL API (base.transfers)");
      if (paidBefore) add("history", "pass", `The sender has paid this exact address ${paidBefore.n} time(s) before, last on ${paidBefore.last}.`, "Coinbase SQL API (base.transfers)");
      else add("history", "info", `The sender has never paid this address on Base${history.complete ? "" : " (among the 5,000 recipients checked)"}. A first payment is normal; confirm the full address with the person you're paying.`, "Coinbase SQL API (base.transfers)");
    }

    const fails = checks.filter((c) => c.result === "fail"), warns = checks.filter((c) => c.result === "warn");
    const verdict = fails.length ? "AVOID" : warns.length ? "CAUTION" : "SAFE";
    const summary = verdict === "AVOID" ? `Don't send: ${fails[0].detail}` : verdict === "CAUTION" ? `Check first: ${warns[0].detail}` : paidBefore ? `Sent to this exact address ${paidBefore.n} time(s) before, and none of the traps we check for were found.` : "None of the traps we check for were found.";
    return {
      from: sender, to: recipient, verdict, summary, checks, lookalike_of: lookalikeOf, times_paid_before: paidBefore?.n ?? 0,
      recipient: { kind: d.kind, delegated_to: d.delegated_to, source: d.source },
      sources: [...new Set(checks.map((c) => c.source))],
    };
  },
};

export const SCREEN_TOOLS: ToolDef[] = [sanctionsCheck, recipientCheck];
