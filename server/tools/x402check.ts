// x402_check: before an agent pays an x402 endpoint, read the payment request it got back (HTTP 402) and say what it
// would really pay, in what, to whom, and whether that matches what it was told.
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { ToolDef } from "./types";
import { ToolError } from "./types";
import { checksum, USDC } from "./chain";
import { describe } from "./address";
import { amount as fmt, tokenMeta } from "./txlib";
import { sanctionsList } from "../ofac";

// Measured 2026-10-15 on 36,823 Base USDC listings in Coinbase's x402 Bazaar: 99.5% cost $1 or less per call (79.7% a
// cent or less). A price above this is unusual enough to confirm first.
const UNUSUAL_USD = 1;
// Prices within this of the expected price count as matching (USDC has 6 decimals).
const TOLERANCE_USD = 0.000001;
const BASE_NETWORKS = new Set(["base", "eip155:8453"]);

type Check = { name: string; result: "pass" | "info" | "warn" | "fail"; detail: string };

const x402Check: ToolDef = {
  name: "x402_check",
  title: "Is this x402 payment request safe to pay?",
  category: "transactions",
  benefit: { kind: "money", text: "An agent that pays every 402 it gets will pay whatever the server asks. Measured on Coinbase's Bazaar, 99.5% of Base x402 endpoints charge $1 or less, yet some ask $10 for a text rewrite; amounts are in raw units, so a wrong decimal means paying 1,000,000 times too much." },
  useWhen: "Run when an x402 endpoint answers 402 Payment Required, before signing the payment, with the 402 body and, if you know it, the price you were told.",
  description: "Reads each payment option in the 402 response (x402 v1 and v2): converts the amount to dollars using the asset's real decimals, checks the asset is Circle's USDC on Base (and what it is if not), checks who gets paid (a wallet, a contract, a token contract that would lose the money, or a sanctioned address), compares the price with what you expected and with what Base x402 endpoints usually charge, and flags schemes that can charge more than one fixed amount. Picks the cheapest option that passes.",
  inputs: { payment_required: z.union([z.object({ accepts: z.array(z.record(z.string(), z.any())) }).passthrough(), z.record(z.string(), z.any())]), expected_price_usd: z.number().nonnegative().optional(), url: z.string().url().optional() },
  inputDocs: [
    { name: "payment_required", type: "object", required: true, lookingFor: "The body of the 402 response (with its accepts list), or a single payment option from it.", whereToGet: "The JSON body (or the decoded PAYMENT-REQUIRED header) the endpoint returned with status 402." },
    { name: "expected_price_usd", type: "number", required: false, lookingFor: "What you were told one call costs, in US dollars, such as 0.01.", whereToGet: "The service's docs, its Bazaar listing, or what the user agreed to pay." },
    { name: "url", type: "string", required: false, lookingFor: "The URL you called, to check the payment is for that same site.", whereToGet: "The request you made." },
  ],
  outputs: [
    { field: "verdict", type: '"SAFE" | "CAUTION" | "AVOID"', is: "For the best option: AVOID if a check failed, CAUTION if something needs confirming, SAFE if none of the traps we check for.", howWorkedOut: "The worst check of the recommended option; AVOID when every option fails." },
    { field: "summary", type: "string", is: "What paying would cost and to whom, in plain words.", howWorkedOut: "Built from the recommended option." },
    { field: "recommended", type: "number | null", is: "Index in options[] of the cheapest option with no failed check.", howWorkedOut: "Among options without a fail, the lowest dollar price (USDC on Base counted at $1), then the fewest warnings." },
    { field: "options[]", type: "array", is: "Each option: scheme, network, asset and its symbol, amount (readable), price_usd (null when not USDC), pay_to and what it is, and its checks.", howWorkedOut: "The option's fields; decimals and symbol read on chain; pay_to read with whats_this and screened against OFAC's SDN list." },
    { field: "options[].checks[]", type: "array", is: "Each rule: name, result, detail.", howWorkedOut: "not_base (info: other networks aren't checked), asset (fail: claims to be USDC but isn't Circle's; info: another token), price (fail: above expected_price_usd; warn: above $1 when no price was given), pay_to (fail: a token contract or sanctioned address; info: wallet or contract), scheme (warn: \"upto\" or unknown schemes can charge up to the amount rather than exactly it), resource (warn: payment is for a different site than url)." },
  ],
  notes: ["Prices are converted only for Circle's USDC on Base (counted at $1). Other tokens are shown in their own units.", "This reads the request; it doesn't check that the service delivers what it promises."],
  example: async () => ({ payment_required: { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: "0x7284D41b5b852F2bd4c99bDf95043D84452d299C", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] }, expected_price_usd: 0.01 }),
  run: async ({ payment_required, expected_price_usd, url }, ctx) => {
    const raw: any[] = Array.isArray((payment_required as any).accepts) ? (payment_required as any).accepts : [payment_required];
    if (!raw.length) throw new ToolError(400, "The 402 body has no payment options (accepts is empty).", "Pass the whole 402 body, or one option from its accepts list.");
    const list = ctx.sanctions ? await ctx.sanctions() : sanctionsList();
    const host = url ? new URL(url).host : null;
    const assets = raw.filter((o) => BASE_NETWORKS.has(String(o.network)) && isAddress(String(o.asset), { strict: false })).map((o) => getAddress(o.asset));
    const meta = await tokenMeta(ctx, assets);

    const options = await Promise.all(raw.map(async (o) => {
      const checks: Check[] = [];
      const add = (name: string, result: Check["result"], detail: string) => checks.push({ name, result, detail });
      const network = String(o.network ?? "");
      const units = String(o.amount ?? o.maxAmountRequired ?? "");
      const base = { scheme: String(o.scheme ?? ""), network, asset: o.asset ?? null, symbol: null as string | null, amount: null as string | null, price_usd: null as number | null, pay_to: o.payTo ?? null, pay_to_is: null as string | null };
      if (!BASE_NETWORKS.has(network)) {
        add("not_base", "info", `This option is on ${network || "an unnamed network"}; only Base options are checked.`);
        return { ...base, checks };
      }
      if (!isAddress(String(o.asset), { strict: false }) || !isAddress(String(o.payTo), { strict: false }) || !/^\d+$/.test(units)) {
        add("malformed", "fail", "The option is missing a valid asset, payTo or amount, so what it charges can't be known.");
        return { ...base, checks };
      }
      const asset = getAddress(o.asset), payTo = checksum(o.payTo);
      const m = meta.get(asset) ?? { symbol: null, decimals: null };
      const isUsdc = asset === USDC;
      const price = isUsdc ? Number(BigInt(units)) / 1e6 : null;
      Object.assign(base, { asset, symbol: m.symbol, amount: fmt(BigInt(units), m.decimals), price_usd: price, pay_to: payTo });

      if (!isUsdc && /usd\s*c/i.test(m.symbol ?? "")) add("asset", "fail", `The asset calls itself ${m.symbol} but isn't Circle's USDC (${USDC}). A copycat token is worthless, or the amount means something else.`);
      else if (!isUsdc) add("asset", "info", `Paid in ${m.symbol ?? "an unknown token"} (${asset}), not USDC: ${base.amount} ${m.symbol ?? "units"}. No dollar price is worked out for it.`);

      if (price !== null) {
        if (expected_price_usd !== undefined && price > expected_price_usd + TOLERANCE_USD) add("price", "fail", `It asks $${price} per call; you expected $${expected_price_usd}.`);
        else if (expected_price_usd === undefined && price > UNUSUAL_USD) add("price", "warn", `It asks $${price} per call. 99.5% of Base x402 endpoints in Coinbase's Bazaar charge $1 or less: confirm this price is what you agreed to.`);
        else add("price", "pass", `$${price} per call${expected_price_usd !== undefined ? `, as expected` : ""}.`);
      }

      const [d, payToMeta] = await Promise.all([describe(ctx, "base", payTo), tokenMeta(ctx, [payTo])]);
      base.pay_to_is = d.kind.replace("_", " ");
      const listing = list.addresses[payTo];
      if (listing) add("pay_to", "fail", `The payee ${payTo} is on OFAC's sanctions list as ${listing.name}.`);
      else if (d.kind === "token" || payToMeta.get(payTo)?.decimals != null) add("pay_to", "fail", `The payee ${payTo} is a token contract: a payment sent there is lost.`);
      else add("pay_to", "info", `Paid to ${payTo}, a ${base.pay_to_is}.`);

      if (base.scheme !== "exact") add("scheme", "warn", `The scheme is "${base.scheme}", not "exact": it can charge up to ${base.amount} ${m.symbol ?? ""} rather than exactly that. Sign only if that maximum is acceptable.`);
      const resource = typeof o.resource === "string" ? o.resource : typeof (payment_required as any).resource?.url === "string" ? (payment_required as any).resource.url : null;
      if (host && resource) {
        try { if (new URL(resource).host !== host) add("resource", "warn", `The payment is for ${new URL(resource).host}, but you called ${host}.`); } catch { /* not a URL */ }
      }
      return { ...base, checks };
    }));

    const usable = options.map((o, i) => ({ o, i })).filter(({ o }) => BASE_NETWORKS.has(o.network) && !o.checks.some((c) => c.result === "fail"));
    // Cheapest first; at the same price, the option with fewer warnings (an "exact" option beats an "upto" one).
    const warnings = (o: (typeof options)[number]) => o.checks.filter((c) => c.result === "warn").length;
    usable.sort((a, b) => (a.o.price_usd ?? Infinity) - (b.o.price_usd ?? Infinity) || warnings(a.o) - warnings(b.o));
    const best = usable[0] ?? null;
    const worst = (o: (typeof options)[number]) => (o.checks.some((c) => c.result === "fail") ? "AVOID" : o.checks.some((c) => c.result === "warn") ? "CAUTION" : "SAFE");
    const verdict = best ? worst(best.o) : "AVOID";
    const lead = best ? `Paying sends ${best.o.amount} ${best.o.symbol ?? "units"}${best.o.price_usd !== null ? ` ($${best.o.price_usd})` : ""} to ${best.o.pay_to} on Base.` : "No Base option is safe to pay.";
    const firstIssue = best ? best.o.checks.find((c) => c.result === "warn") : options.flatMap((o) => o.checks).find((c) => c.result === "fail");
    return {
      verdict, summary: `${lead}${firstIssue ? ` ${verdict === "AVOID" ? "Don't pay" : "Check first"}: ${firstIssue.detail}` : ""}`,
      recommended: best?.i ?? null, options,
      sources: ["The 402 payment request", "decimals() and symbol() on Base", "Base RPC for the payee's code", `OFAC SDN list, published ${list.published}`, "Coinbase x402 Bazaar prices, measured 2026-10-15"],
    };
  },
};

export const X402_TOOLS: ToolDef[] = [x402Check];
