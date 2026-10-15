// check_signature: what an off-chain signature request (EIP-712 typed data) would let someone take. Permit and Permit2
// signatures move tokens without the owner sending any transaction, and a Seaport order can give NFTs away for nothing,
// which is why signature phishing doesn't need a single on-chain approval from the victim.
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { ToolContext, ToolDef } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, UNISWAP, USDC } from "./chain";
import { describe } from "./address";
import { amount, tokenMeta, UNLIMITED_FROM } from "./txlib";

// Seaport 1.5 and 1.6 on Base (same addresses on every chain). https://github.com/ProjectOpenSea/seaport#deployments
const SEAPORT = new Set(["0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC", "0x0000000000000068F116a894984e2DB1123eB395"]);
// A signature that stays usable longer than this gets a warning: most legitimate permits expire within minutes or days.
const LONG_DAYS = 30;
const ITEM = ["ETH", "ERC-20", "ERC-721", "ERC-1155", "ERC-721 (any id)", "ERC-1155 (any id)"];

type Check = { name: string; result: "pass" | "info" | "warn" | "fail"; detail: string };
type Grant = { token: string; symbol: string | null; amount: string; unlimited: boolean; spender: string; spender_is: string; until: string | null; how: string };

const big = (v: unknown) => { try { return BigInt(v as any); } catch { return null; } };
const date = (seconds: bigint | null) => (seconds === null ? null : seconds >= 2n ** 40n ? "never" : new Date(Number(seconds) * 1000).toISOString());

async function who(ctx: ToolContext, address: string) {
  if (getAddress(address) === UNISWAP.universalRouter) return { is: "Uniswap Universal Router", risky: false as boolean | null };
  const d = await describe(ctx, "base", address);
  if (d.kind === "wallet" || d.kind === "delegated_wallet") return { is: d.kind === "wallet" ? "a wallet (no code)" : "a wallet run by delegated code", risky: true as boolean | null };
  if (d.source.verified === false) return { is: `unverified ${d.kind}`, risky: true as boolean | null };
  return { is: `${d.source.verified ? "verified " : ""}${d.kind}${d.source.name ? ` ${d.source.name}` : ""}`, risky: d.source.verified === null ? null : false };
}

const checkSignature: ToolDef = {
  name: "check_signature",
  title: "What does this signature let someone take?",
  category: "transactions",
  benefit: { kind: "money", text: "A signature costs nothing and sends nothing, so it feels safe, but a signed Permit or Permit2 lets the spender take the tokens later, and a signed Seaport order can sell NFTs for nothing. Signature phishing drains wallets without the owner ever sending a transaction." },
  useWhen: "Run before signing any typed-data request (eth_signTypedData_v4), especially one from a website, an airdrop claim, a marketplace listing or another agent. Answers what it allows, to whom, how much and until when.",
  description: "Reads EIP-712 typed data and says what signing it grants: EIP-2612 and DAI-style Permits, Uniswap Permit2 (allowance and one-time transfer, single and batch, with witness), and Seaport orders (what you give and what you get back). Looks up each token and who the spender is on Base, and flags permits to wallets or unverified code, unlimited or long-lived permits, orders that give assets away for little or nothing, and signatures meant for another chain.",
  inputs: { typed_data: z.object({ domain: z.record(z.string(), z.any()), types: z.record(z.string(), z.any()).optional(), primaryType: z.string(), message: z.record(z.string(), z.any()) }), signer: addressInput.optional() },
  inputDocs: [
    { name: "typed_data", type: "object", required: true, lookingFor: "The EIP-712 request exactly as the wallet received it: domain, types, primaryType and message.", whereToGet: "The params of the eth_signTypedData_v4 request (the second parameter, parsed from JSON)." },
    { name: "signer", type: "string", required: false, lookingFor: "The wallet being asked to sign. Used to check the permit's owner and a Seaport order's offerer are really you.", whereToGet: "Your wallet." },
  ],
  outputs: [
    { field: "kind", type: "string", is: 'What the request is: "permit", "dai_permit", "permit2_allowance", "permit2_transfer", "seaport_order" or "unknown".', howWorkedOut: "From primaryType, the message's fields and the verifying contract." },
    { field: "verdict", type: '"SAFE" | "CAUTION" | "AVOID"', is: "AVOID: a check failed. CAUTION: something to confirm, including any request we can't read. SAFE: none of the traps we check for.", howWorkedOut: "The worst check wins." },
    { field: "summary", type: "string", is: "What signing would allow, in plain words.", howWorkedOut: "Built from the grants and checks." },
    { field: "grants[]", type: "array", is: "For permits: token, symbol, amount (or unlimited), spender, who the spender is, until when, and how it can be used.", howWorkedOut: "The message's fields; token names read on chain; the spender read with whats_this." },
    { field: "order", type: "object | null", is: "For a Seaport order: what you give (offer) and what comes back to you (consideration to the offerer), each item with token, kind and amount.", howWorkedOut: "The order's offer and consideration items." },
    { field: "checks[]", type: "array", is: "Each rule: name, result, detail.", howWorkedOut: "spender_wallet / spender_unverified (fail), giveaway (fail: a Seaport order returning nothing, or nothing of the same kind, to the offerer), not_signer (fail: the permit's owner or the order's offerer isn't the signer), unlimited (warn), long_lived (warn: usable for more than 30 days), other_chain (warn), unknown_kind (warn)." },
    { field: "chain_id", type: "number | null", is: "The chain the signature is for.", howWorkedOut: "domain.chainId." },
  ],
  notes: ["Only typed-data requests are read. A raw eth_sign of a hash can authorize anything and can't be decoded: never sign one.", "Seaport orders are judged on whether anything comes back to you, not on whether the price is fair: no price data is used."],
  example: async () => ({ typed_data: { domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC }, primaryType: "Permit", message: { owner: EXAMPLE_WALLET, spender: "0x1111111111111111111111111111111111111111", value: "115792089237316195423570985008687907853269984665640564039457584007913129639935", nonce: "0", deadline: "115792089237316195423570985008687907853269984665640564039457584007913129639935" } } }),
  run: async ({ typed_data, signer }, ctx) => {
    const { domain, primaryType, message } = typed_data as any;
    const me = signer ? checksum(signer) : null;
    const verifying = isAddress(String(domain.verifyingContract ?? ""), { strict: false }) ? getAddress(domain.verifyingContract) : null;
    const chainId = domain.chainId === undefined ? null : Number(domain.chainId);
    const now = BigInt(Math.floor((ctx.now ?? Date.now)() / 1000));
    const checks: Check[] = [];
    const add = (name: string, result: Check["result"], detail: string) => checks.push({ name, result, detail });
    const grants: Grant[] = [];
    let order: { offer: unknown[]; to_you: unknown[] } | null = null;
    let kind = "unknown";

    const grant = async (token: string, raw: bigint | null, spender: string, until: bigint | null, how: string) => {
      const t = getAddress(token), s = getAddress(spender);
      const [meta, w] = await Promise.all([tokenMeta(ctx, [t]), who(ctx, s)]);
      const m = meta.get(t)!;
      const unlimited = raw === null || raw >= UNLIMITED_FROM;
      grants.push({ token: t, symbol: m.symbol, amount: unlimited ? "unlimited" : amount(raw!, m.decimals), unlimited, spender: s, spender_is: w.is, until: date(until), how });
      const what = `${unlimited ? "an unlimited amount of" : amount(raw!, m.decimals)} ${m.symbol ?? t}`;
      if (w.risky === true) add(w.is.includes("wallet") ? "spender_wallet" : "spender_unverified", "fail", `It lets ${s} (${w.is}) take ${what}. Signature phishing sends permits to addresses like this.`);
      if (unlimited) add("unlimited", "warn", `The amount is unlimited: ${s} could take all of your ${m.symbol ?? "tokens"}, now and later.`);
      if (until !== null && until > now + BigInt(LONG_DAYS * 86400)) add("long_lived", "warn", `It stays usable ${until >= 2n ** 40n ? "forever" : `until ${date(until)!.slice(0, 10)}`}.`);
    };
    const owner = (a: unknown, what: string) => { if (me && isAddress(String(a), { strict: false }) && getAddress(String(a)) !== me) add("not_signer", "fail", `The ${what} in the message is ${getAddress(String(a))}, not the signer ${me}.`); };

    if (verifying === UNISWAP.permit2 && message.details && message.spender) {
      kind = "permit2_allowance";
      for (const d of Array.isArray(message.details) ? message.details : [message.details]) await grant(d.token, big(d.amount), message.spender, big(d.expiration), "an allowance through Permit2, usable many times until it expires");
    } else if (verifying === UNISWAP.permit2 && message.permitted && message.spender) {
      kind = "permit2_transfer";
      for (const p of Array.isArray(message.permitted) ? message.permitted : [message.permitted]) await grant(p.token, big(p.amount), message.spender, big(message.deadline), "a one-time transfer through Permit2");
    } else if (primaryType === "Permit" && message.spender && message.value !== undefined && verifying) {
      kind = "permit";
      owner(message.owner, "owner");
      await grant(verifying, big(message.value), message.spender, big(message.deadline), "an EIP-2612 permit: sets the allowance without a transaction");
    } else if (primaryType === "Permit" && message.spender && message.allowed !== undefined && verifying) {
      kind = "dai_permit";
      owner(message.holder, "holder");
      if (message.allowed === true || message.allowed === "true") await grant(verifying, null, message.spender, big(message.expiry) || 2n ** 64n, "a DAI-style permit: unlimited allowance");
    } else if ((primaryType === "OrderComponents" || SEAPORT.has(verifying ?? "")) && Array.isArray(message.offer)) {
      kind = "seaport_order";
      owner(message.offerer, "offerer");
      const offerer = isAddress(String(message.offerer), { strict: false }) ? getAddress(message.offerer) : null;
      const items = [...message.offer, ...(message.consideration ?? [])];
      const meta = await tokenMeta(ctx, items.filter((i: any) => Number(i.itemType) >= 1).map((i: any) => getAddress(i.token)));
      const show = (i: any) => {
        const type = Number(i.itemType);
        const token = type === 0 ? "ETH" : getAddress(i.token);
        const m = meta.get(token);
        return { kind: ITEM[type] ?? `item type ${type}`, token, symbol: m?.symbol ?? null, amount: type === 0 || type === 1 ? amount(big(i.startAmount) ?? 0n, type === 0 ? 18 : m?.decimals ?? null) : String(i.startAmount), ...(type >= 2 ? { id: String(i.identifierOrCriteria) } : {}) };
      };
      const toYou = (message.consideration ?? []).filter((c: any) => offerer && isAddress(String(c.recipient), { strict: false }) && getAddress(c.recipient) === offerer);
      order = { offer: message.offer.map(show), to_you: toYou.map(show) };
      const valuable = (i: any) => Number(i.itemType) >= 2 || (big(i.startAmount) ?? 0n) > 0n;
      if (message.offer.some(valuable) && !toYou.some(valuable)) add("giveaway", "fail", "Nothing comes back to you: anyone could fill this order and take what you offer.");
      else add("order", "info", `You give ${order.offer.length} item(s) and get ${toYou.length} back. Check the price yourself: this tool doesn't price NFTs.`);
    } else {
      add("unknown_kind", "warn", `This is a "${primaryType}" request for ${domain.name ?? "an unnamed app"}${verifying ? ` (${verifying})` : ""}, which isn't a permit or order this tool can read. Only sign it if you know exactly what that app does with it.`);
    }
    if (chainId !== null && chainId !== 8453) add("other_chain", "warn", `It is for chain ${chainId}, not Base (8453). Tokens and spenders above were looked up on Base, so they may not be what it means there.`);

    const fails = checks.filter((c) => c.result === "fail"), warns = checks.filter((c) => c.result === "warn");
    const verdict = fails.length ? "AVOID" : warns.length ? "CAUTION" : "SAFE";
    const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    const item = (o: any) => (o.id ? `${o.symbol ?? o.kind} #${o.id}` : `${o.amount} ${o.symbol ?? o.token}`);
    const lead = grants.length ? `Signing lets ${grants.map((g) => `${g.spender} take ${g.unlimited ? "an unlimited amount of" : g.amount} ${g.symbol ?? g.token}${g.until ? (g.until === "never" ? " with no expiry" : ` until ${g.until.slice(0, 10)}`) : ""}`).join("; ")}.` : order ? `Signing lists a Seaport order: you give ${order.offer.map(item).join(", ")} and get ${order.to_you.length ? order.to_you.map(item).join(", ") : "nothing"} back.` : "";
    const summary = `${lead}${fails.length ? ` Don't sign: ${lc(fails[0].detail)}` : warns.length ? ` Check first: ${lc(warns[0].detail)}` : ""}`.trim();
    return { kind, verdict, summary, grants, order, checks, chain_id: chainId, verifying_contract: verifying, sources: ["The typed data itself", "Base RPC for token names and the spender's code", "Sourcify and Basescan for verified source"] };
  },
};

export const SIGNATURE_TOOLS: ToolDef[] = [checkSignature];
