// Token checks: a reasoned safety verdict for an ERC-20 on Base. Each rule matches a way people have really been robbed
// with a token; "SAFE" means none of the traps below were found, never that the token is a good buy.
import { erc20Abi, getAddress, parseAbi, type Abi, type Hex } from "viem";
import type { ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum } from "./chain";
import { marketFor } from "./market";
import { verifiedSource } from "./source";
import { BUY_ETH, pickTradePool, tradeTest } from "./simulate";

// Established tokens whose issuer powers are there by design (a regulated issuer that must be able to freeze stolen
// funds, or a wrapped asset), so mint, pause, blacklist and upgrade powers are reported as information, not warnings.
// Each address was checked on chain (symbol) and against the issuer's own list.
export const ESTABLISHED: Record<string, string> = {
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "USDC, issued by Circle",
  "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42": "EURC, issued by Circle",
  "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": "USDbC, Coinbase's bridged USDC",
  "0x4200000000000000000000000000000000000006": "WETH, the OP Stack's wrapped ETH",
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": "cbBTC, issued by Coinbase",
  "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22": "cbETH, issued by Coinbase",
};

// Thresholds, each with its reason.
// Liquidity under $10,000: one sale moves the price a lot and the pool can be emptied cheaply.
export const MIN_LIQUIDITY_USD = 10_000;
// Liquidity under $1,000: there is almost nothing to sell into. This is what a pool looks like after its liquidity has
// been pulled (measured 2026-10-14: AMZN and POOLS on Base, both $0, where 20+ buyers were left holding).
export const EMPTY_LIQUIDITY_USD = 1_000;
// Pools under a day old: most rug pulls happen within hours of launch.
export const MIN_AGE_HOURS = 24;
// Tax: above 10% is a warning (most honest tokens charge 0-5%); above 50% is a trap (you lose most of every sale).
export const TAX_WARN = 0.1;
export const TAX_FAIL = 0.5;

// Owner powers read from the verified ABI. A power only matters while someone holds it (see ownerActive).
// mint also covers launchpad variants such as mintInflation and updateMintRate (Doppler's DERC20), found when measuring.
export const POWERS = [
  { key: "mint", re: /^(mint\w*|issue|\w*MintRate)$/i, what: "create new tokens", why: "new supply can be created and sold into the pool, crashing the price for holders" },
  { key: "blacklist", re: /(blacklist|blocklist|denylist|addBots?$|setBots?$|blockAddress|setBlocked|setSniper)/i, what: "block wallets", why: "a blocked wallet can buy but never sell" },
  { key: "fees", re: /^(set|update|change)\w*(fee|tax)/i, what: "change the trading fee", why: "the sell fee can be raised to 100% after people buy" },
  { key: "pause", re: /^(pause|setPaused|setPause|disableTrading|stopTrading)$/i, what: "stop transfers", why: "trading can be frozen while the owner exits" },
  { key: "max_tx", re: /^(set|update)\w*(maxTx|maxTransaction|maxWallet|maxSell)/i, what: "cap how much a wallet can sell", why: "a sell limit can be set so low that holders can't get out" },
] as const;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation
const ownerAbi = parseAbi(["function owner() view returns (address)", "function getOwner() view returns (address)"]);
const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

type Check = { name: string; result: "pass" | "warn" | "fail" | "info"; detail: string; source: string };
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const tokenSafety: ToolDef = {
  name: "token_safety",
  title: "Token safety verdict",
  category: "tokens",
  benefit: { kind: "money", text: "A honeypot lets you buy and never sell; a 99% sell tax takes almost everything. This catches both before you pay." },
  useWhen: "Run before buying, accepting or recommending a token on Base. Answers SAFE, CAUTION or AVOID with the exact reasons, from a simulated buy and sell, the contract's verified code and market data.",
  description: "Simulates buying 0.01 ETH of the token and selling it straight back (catches honeypots and hidden taxes), reads what the owner can still do (mint, block wallets, change fees, pause, cap sells), checks whether the code can be swapped (upgradeable proxy), whether the source is verified, and liquidity and pool age. SAFE means none of these known traps were found, not that the token will hold its value.",
  inputs: { token: addressInput },
  inputDocs: [
    { name: "token", type: "string", required: true, lookingFor: "The token's contract address on Base: 0x followed by 40 hex characters.", whereToGet: "The token page on a DEX or explorer, or find_token. Never a ticker or a name: copycats reuse those." },
  ],
  outputs: [
    { field: "token", type: "string", is: "The token's contract, checksummed.", howWorkedOut: "The input." },
    { field: "symbol / name / decimals", type: "string / string / number", is: "What the contract calls itself.", howWorkedOut: "symbol(), name() and decimals() on the contract. Anyone can pick any name, so these prove nothing." },
    { field: "verdict", type: '"SAFE" | "CAUTION" | "AVOID"', is: "The answer. AVOID: at least one check failed. CAUTION: at least one warning, or something that couldn't be checked. SAFE: no warnings.", howWorkedOut: "The worst check wins." },
    { field: "summary", type: "string", is: "One sentence explaining the verdict.", howWorkedOut: "Built from the failed and warning checks." },
    { field: "checks[]", type: "array", is: "Every check: name, result (pass, warn, fail, info), detail in plain words, and source.", howWorkedOut: "One entry per rule; see the tool notes for the rules." },
    { field: "trade_test", type: "object | null", is: "The simulated buy and sell: pool, block, whether each worked, buy_tax and sell_tax as fractions.", howWorkedOut: "eth_simulateV1 at the latest block: a made-up wallet buys 0.01 ETH of the token on its deepest Uniswap v2, v3 or v4 pool against ETH or WETH, then sells everything back (v4 through the Universal Router and Permit2, as a real wallet would). Taxes compare what arrived with the pool's own quote. null when no such pool exists." },
    { field: "liquidity_usd", type: "number | null", is: "Total liquidity across the pools DexScreener lists, in US dollars.", howWorkedOut: "Sum of DexScreener's liquidity for each pool it lists (at most 30, so a widely traded token may have more). null when DexScreener couldn't be reached." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Each data source used." },
  ],
  notes: [
    "Not checked yet: how concentrated the holders are, and whether liquidity is locked. Both need data we don't have a free, reliable source for on Base.",
    "The trade test covers Uniswap v2, v3 and v4 pools against ETH or WETH. A token that trades only elsewhere (for example Aerodrome, or against another token) gets a warning that selling wasn't tested.",
    "Verified source comes from Sourcify, and from Basescan when an Etherscan key is configured. A contract with no source found gets a warning: its owner powers can't be read.",
  ],
  example: async () => ({ token: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" }),
  run: async ({ token }, ctx) => {
    const client = ctx.client("base");
    const address = checksum(token) as Hex;
    const checks: Check[] = [];
    const add = (name: string, result: Check["result"], detail: string, source: string) => checks.push({ name, result, detail, source });

    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new ToolError(400, "That address has no contract code on Base, so it isn't a token.", "Check you have the token's contract address, not a wallet, and that it's on Base.");
    let symbol: string, name: string, decimals: number;
    try {
      [symbol, name, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol", authorizationList: undefined }),
        client.readContract({ address, abi: erc20Abi, functionName: "name", authorizationList: undefined }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals", authorizationList: undefined }),
      ]);
    } catch {
      throw new ToolError(400, "That contract doesn't answer like an ERC-20 token (symbol, name and decimals).", "Check the address is the token itself, not a pool, router or NFT.");
    }
    const established = ESTABLISHED[address];
    if (established) add("established", "info", `${established}. Issuer powers below are there by design and reported as information.`, "Base Pulse list, checked on chain");

    const [market, source, implSlot] = await Promise.all([
      marketFor(ctx, address),
      verifiedSource(ctx, address),
      client.getStorageAt({ address, slot: IMPL_SLOT }),
    ]);

    // Trade test: the honeypot and tax check.
    let trade: Awaited<ReturnType<typeof tradeTest>> | null = null;
    if (market.ok) {
      const pool = await pickTradePool(ctx, market.pools);
      if (pool) {
        trade = await tradeTest(ctx, address, pool);
        const where = `Uniswap ${pool.kind} pool ${pool.address}, block ${trade.block}`;
        if (!trade.bought) add("buy", "warn", `A simulated buy of ${Number(BUY_ETH) / 1e18} ETH failed (${trade.buyError}). Trading may be switched off, or only allowed for some wallets.`, `eth_simulateV1, ${where}`);
        else if (!trade.sold) add("sell", "fail", `Honeypot: a simulated buy worked, but selling the tokens straight back failed (${trade.sellError}).`, `eth_simulateV1, ${where}`);
        else {
          add("sell", "pass", "A simulated buy and sell back both worked.", `eth_simulateV1, ${where}`);
          for (const [side, tax] of [["buy", trade.buyTax], ["sell", trade.sellTax]] as const) {
            if (tax === null) add(`${side}_tax`, "warn", `The ${side} tax couldn't be measured: the pool's quote didn't answer.`, `eth_simulateV1, ${where}`);
            else if (tax > TAX_FAIL) add(`${side}_tax`, "fail", `${pct(tax)} of each ${side} is taken. You would lose most of what you put in.`, `eth_simulateV1, ${where}`);
            else if (tax > TAX_WARN) add(`${side}_tax`, "warn", `${pct(tax)} of each ${side} is taken, more than honest tokens usually charge.`, `eth_simulateV1, ${where}`);
            else if (tax > 0.01) add(`${side}_tax`, "info", `${pct(tax)} of each ${side} is taken.`, `eth_simulateV1, ${where}`);
          }
        }
      } else {
        add("sell", established ? "info" : "warn", market.pools.length
          ? `Selling wasn't tested: none of the ${market.pools.length} pool(s) DexScreener lists is a Uniswap v2, v3 or v4 pool against ETH or WETH, which is what the test covers so far.`
          : "Selling wasn't tested: no pool for this token was found on Base.", "DexScreener");
      }
    } else add("market", "warn", `Market data is unavailable right now (${"error" in market ? market.error : "no answer"}), so the trade test, liquidity and age weren't checked. Retry for a full verdict.`, "DexScreener");

    // Liquidity and age.
    // Pools DexScreener gives no liquidity figure for count as unknown, never as $0.
    const priced = market.ok ? market.pools.filter((p) => p.liquidityUsd !== null) : [];
    if (market.ok && market.pools.length && !priced.length) add("liquidity", established ? "info" : "warn", "Liquidity is unknown: DexScreener gives no figure for this token's pools.", "DexScreener");
    if (market.ok && priced.length) {
      const liquidity = priced.reduce((sum, p) => sum + p.liquidityUsd!, 0);
      if (liquidity < EMPTY_LIQUIDITY_USD && !established) add("liquidity", "fail", `Only ${usd(liquidity)} of liquidity across the ${priced.length} pool(s) DexScreener lists: there is almost nothing to sell into, which is how a pool looks after its liquidity is pulled.`, "DexScreener");
      else if (liquidity < MIN_LIQUIDITY_USD) add("liquidity", established ? "info" : "warn", `Only ${usd(liquidity)} of liquidity across the ${priced.length} pool(s) DexScreener lists. One sale can move the price a lot, and the pool is cheap to drain.`, "DexScreener");
      else add("liquidity", "pass", `${usd(liquidity)} of liquidity across the ${priced.length} pool(s) DexScreener lists${priced.length >= 30 ? " (its maximum, so there may be more)" : ""}.`, "DexScreener");
    }
    if (market.ok && market.pools.length) {
      const oldest = Math.min(...market.pools.map((p) => p.createdAt ?? Infinity));
      if (Number.isFinite(oldest)) {
        const hours = ((ctx.now ?? Date.now)() - oldest) / 3_600_000;
        if (hours < MIN_AGE_HOURS) add("age", "warn", `Its oldest pool is ${hours < 1 ? "under an hour" : `${Math.floor(hours)} hours`} old. Most rug pulls happen within the first day.`, "DexScreener");
        else add("age", "pass", `Its oldest pool is ${Math.floor(hours / 24)} days old.`, "DexScreener");
      }
    }

    // Upgradeable code: an EIP-1967 proxy can have its code replaced by whoever controls the upgrade.
    const impl = BigInt(implSlot ?? "0x0") ? getAddress(`0x${(implSlot as string).slice(-40)}`) : (source?.proxy?.isProxy ? source.proxy.implementation : null);
    if (impl) add("upgradeable", established ? "info" : "warn", `The contract is an upgradeable proxy (code at ${impl}). Whoever controls upgrades can change what the token does, after you buy.`, "EIP-1967 storage slot, read on chain");

    // Source and owner powers. A proxy's powers live in its implementation's code.
    let abi: Abi | null = source?.abi ?? null;
    let sourceFrom = source?.from ?? "unreachable";
    if (impl) {
      const implSource = await verifiedSource(ctx, impl);
      if (implSource?.found) { abi = implSource.abi; sourceFrom = implSource.from; }
      else abi = null;
    }
    if (!source) add("source", "warn", "The verified-source service couldn't be reached, so what the owner can do wasn't checked. Retry for a full verdict.", "Sourcify");
    else if (!abi) {
      const basescan = Boolean(ctx.etherscanKey ?? process.env.ETHERSCAN_API_KEY);
      add("source", established ? "info" : "warn", `No verified source code was found (${basescan ? "Sourcify and Basescan" : "Sourcify"}), so what the owner can do couldn't be read.`, basescan ? "Sourcify, Basescan" : "Sourcify");
    }
    else {
      add("source", "pass", `Source code is verified${source.name ? ` (${source.name})` : ""}.`, sourceFrom === "basescan" ? "Basescan" : "Sourcify");
      let owner: string | null = null;
      for (const fn of ["owner", "getOwner"] as const) {
        try { owner = await client.readContract({ address, abi: ownerAbi, functionName: fn, authorizationList: undefined }); break; } catch { /* no such function */ }
      }
      const renounced = owner !== null && DEAD.has(owner.toLowerCase());
      const roleBased = abi.some((f: any) => f.type === "function" && f.name === "hasRole");
      const writes = abi.filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure").map((f: any) => String(f.name));
      const controller = renounced ? null : owner ? `The owner (${owner})` : roleBased ? "Wallets granted admin roles" : "A privileged address";
      for (const power of POWERS) {
        const fns = writes.filter((n) => power.re.test(n));
        if (!fns.length) continue;
        if (renounced) add(power.key, "info", `It has ${fns.join(", ")}, but ownership is renounced, so no one can use it.`, "verified ABI, owner() on chain");
        else add(power.key, established ? "info" : "warn", `${controller} can ${power.what} (${fns.join(", ")}): ${power.why}.`, "verified ABI, owner() on chain");
      }
      // ERC-7802 cross-chain tokens (Clanker's among them) mint only when Optimism's Superchain token bridge moves tokens
      // in from another chain, matched by a burn there. Checked in Clanker's verified source, 2026-10-14.
      if (writes.includes("crosschainMint")) add("crosschain_mint", "info", "It has crosschainMint (ERC-7802): only Optimism's Superchain token bridge (0x4200000000000000000000000000000000000028) may call it, to bring tokens over from another chain where the same amount is burned. It isn't owner minting.", "verified ABI");
      if (renounced) add("owner", "pass", "Ownership is renounced: the owner address is empty.", "owner() on chain");
    }

    const fails = checks.filter((c) => c.result === "fail");
    const warns = checks.filter((c) => c.result === "warn");
    const verdict = fails.length ? "AVOID" : warns.length ? "CAUTION" : "SAFE";
    const summary = verdict === "AVOID" ? `Avoid: ${fails.map((c) => c.detail.split(":")[0].replace(/\.$/, "")).join("; ")}.`
      : verdict === "CAUTION" ? `Caution: ${warns.length} warning${warns.length > 1 ? "s" : ""}, starting with: ${warns[0].detail}`
      : "None of the traps we check for were found. That doesn't make it a good buy.";
    const sources = [...new Set(checks.map((c) => c.source))];
    return {
      token: address, symbol, name, decimals, verdict, summary, checks,
      trade_test: trade && { pool: trade.pool.address, pool_kind: `uniswap ${trade.pool.kind}`, block: trade.block, bought: trade.bought, sold: trade.sold, buy_tax: trade.buyTax, sell_tax: trade.sellTax, buy_error: trade.buyError, sell_error: trade.sellError },
      liquidity_usd: priced.length ? Math.round(priced.reduce((s, p) => s + p.liquidityUsd!, 0)) : null,
      sources,
    };
  },
};

export const TOKEN_TOOLS: ToolDef[] = [tokenSafety];
