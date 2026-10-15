// Transaction tools: what a landed transaction did and why it failed; what an unsigned one will do; and whether it does
// exactly what was asked.
import { decodeErrorResult, formatEther, getAddress, type Hex } from "viem";
import { z } from "zod";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, UNISWAP, USDC } from "./chain";
import { describe } from "./address";
import { ethUsd } from "./reference";
import { amount, decodeLogs, nameCall, netChanges, simulateTx, tokenMeta, UNLIMITED_FROM, type Grant } from "./txlib";

const hashInput = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected a transaction hash: 0x followed by 64 hex characters.");
export const txInput = z.object({ from: addressInput, to: addressInput, data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).optional(), value: z.string().regex(/^\d+$/).optional() });
const txDocs = [
  { name: "tx", type: "object", required: true, lookingFor: "The unsigned transaction: from, to, and optionally data (0x hex) and value (wei, as digits).", whereToGet: "What your wallet, a dApp or another agent asks you to sign." },
  { name: "tx.from", type: "string", required: true, lookingFor: "The wallet that would sign and send it.", whereToGet: "Your wallet." },
];

// Uniswap's short revert codes, from its v3 contracts (UniswapV3Pool.sol, TransferHelper.sol, SwapRouter.sol, PeripheryValidation.sol).
const UNISWAP_CODES: Record<string, string> = {
  STF: "the router couldn't pull the input tokens (safeTransferFrom failed): usually a missing approval or too small a balance",
  TF: "a token transfer failed",
  SPL: "the price limit was invalid for the swap direction (sqrtPriceLimitX96)",
  AS: "the swap amount was zero",
  LOK: "the pool was locked mid-swap",
  "Too little received": "the price moved and the swap would return less than the minimum set (slippage)",
  "Too much requested": "the price moved and the swap would cost more than the maximum set (slippage)",
  "Transaction too old": "the deadline had passed before it was included",
  "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT": "the price moved and the swap would return less than the minimum set (slippage)",
  "UniswapV2Router: EXPIRED": "the deadline had passed before it was included",
  "TransferHelper: TRANSFER_FROM_FAILED": "the router couldn't pull the input tokens: usually a missing approval or too small a balance",
};
const explainCode = (text: string) => {
  const code = text.replace(/^execution reverted:?\s*/i, "").trim();
  return UNISWAP_CODES[code] ? `${code}: ${UNISWAP_CODES[code]}` : text;
};

// The revert data anywhere in a viem error chain.
const errorData = (e: any): Hex | undefined => {
  for (let x = e; x; x = x.cause) if (typeof x?.data === "string" && x.data.startsWith("0x")) return x.data as Hex;
  return undefined;
};

// The revert reason from an error or return data: Error(string), Panic(uint256), or the raw text.
function reason(data: Hex | undefined, fallback: string | null) {
  if (data && data.length >= 10) {
    try {
      const e = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "m" }] }, { type: "error", name: "Panic", inputs: [{ type: "uint256", name: "c" }] }], data });
      return e.errorName === "Error" ? explainCode(String(e.args[0])) : `panic code ${e.args[0]}`;
    } catch { /* a custom error */ }
    return `custom error ${data.slice(0, 10)}${fallback ? ` (${fallback})` : ""}`;
  }
  return fallback && !/^execution reverted\.?$/i.test(fallback.trim()) ? explainCode(fallback) : "it reverted without giving a reason";
}

const grantText = (g: Grant, meta: Map<string, { symbol: string | null; decimals: number | null }>) => {
  const sym = meta.get(g.token)?.symbol ?? g.token;
  if (g.kind === "nft_all") return g.approved ? `lets ${g.spender} move every ${sym} NFT this wallet holds` : `revokes ${g.spender}'s access to ${sym} NFTs`;
  if (g.raw === 0n) return `sets ${g.spender}'s ${sym} allowance to 0 (a revoke)`;
  const how = g.raw! >= UNLIMITED_FROM ? `an unlimited amount of ${sym}` : `${amount(g.raw!, meta.get(g.token)?.decimals ?? null)} ${sym}`;
  return `lets ${g.spender} take ${how}${g.kind === "permit2" ? " through Permit2" : ""}`;
};

const explainTx: ToolDef = {
  name: "explain_tx",
  title: "What did this transaction do?",
  category: "transactions",
  benefit: { kind: "accuracy", text: "An agent that guesses why a transaction failed, or what it moved, retries the wrong thing or reports money that never arrived. This reads the receipt and says exactly what moved, what was approved, what it cost and why it failed." },
  useWhen: "Run on any Base transaction hash when someone asks what happened, whether a payment went through, where the money went, or why it failed. Use it instead of reading a block explorer.",
  description: "Reads the transaction and its receipt from Base: whether it succeeded, the function it called (named from verified code or Sourcify's signature database), every token and NFT that moved, every approval it granted, the net change for the sender, and the full fee including Base's L1 data fee. For a failed transaction it re-runs the call at the block before to get the revert reason.",
  inputs: { hash: hashInput },
  inputDocs: [{ name: "hash", type: "string", required: true, lookingFor: "The transaction hash: 0x followed by 64 hex characters. Base mainnet.", whereToGet: "Your wallet's activity, a block explorer link, or what a send returned." }],
  outputs: [
    { field: "status", type: '"success" | "failed"', is: "Whether it went through.", howWorkedOut: "The receipt's status." },
    { field: "summary", type: "string", is: "What happened, in one or two plain sentences.", howWorkedOut: "Built from the facts below." },
    { field: "from / to / block / time", type: "string / string / number / string", is: "Who sent it, what it called, and when.", howWorkedOut: "The transaction and its block." },
    { field: "function", type: "object | null", is: "The function called: name, signature, decoded arguments and where the name came from. null for a plain ETH transfer.", howWorkedOut: "The target's verified ABI (or its implementation's, for a proxy), else Sourcify's signature database." },
    { field: "eth_sent", type: "string", is: "ETH attached to the call.", howWorkedOut: "The transaction's value." },
    { field: "transfers[]", type: "array", is: "Every token and NFT movement: token, symbol, from, to, amount (or nft_id).", howWorkedOut: "Transfer events in the receipt, amounts divided by each token's decimals." },
    { field: "approvals[]", type: "array", is: "Every approval granted or removed, in plain words.", howWorkedOut: "Approval, ApprovalForAll and Permit2 Approval events in the receipt." },
    { field: "sender_changes", type: "object", is: "The sender's net gain or loss per token, and NFTs sent or received (ETH value included, fee not).", howWorkedOut: "Sum of the transfers in and out of the sender, plus eth_sent." },
    { field: "fee_eth / fee_usd", type: "string / number | null", is: "What the sender paid to have it included, failed or not.", howWorkedOut: "gasUsed × effective gas price + the receipt's L1 data fee; dollars from Chainlink ETH / USD now (not at the time)." },
    { field: "failure_reason", type: "string | null", is: "Why it failed.", howWorkedOut: "The same call re-run with eth_call at the block before; decoded from Error(string), Panic or the error's selector. Other transactions earlier in the same block can make the real reason differ." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Names each source." },
  ],
  example: async (ctx) => {
    const block = await ctx.client("base").getBlock({ includeTransactions: true });
    const tx = (block.transactions as any[]).find((t) => t.to?.toLowerCase() === USDC.toLowerCase()) ?? (block.transactions as any[])[1];
    return { hash: tx.hash };
  },
  run: async ({ hash }, ctx) => {
    const client = ctx.client("base");
    let tx: any, receipt: any;
    try {
      [tx, receipt] = await Promise.all([client.getTransaction({ hash: hash as Hex }), client.getTransactionReceipt({ hash: hash as Hex })]);
    } catch {
      throw new ToolError(404, "No transaction with that hash on Base, or it hasn't been included yet.", "Check the hash and that it's a Base mainnet transaction; a pending one appears once it's in a block.");
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const from = getAddress(tx.from), to = tx.to ? getAddress(tx.to) : null;
    const { moves, grants } = decodeLogs(receipt.logs);
    if (tx.value > 0n && to) moves.unshift({ token: "ETH", from, to, raw: tx.value, nft_id: null });
    const meta = await tokenMeta(ctx, [...moves.map((m) => m.token), ...grants.map((g) => g.token)], receipt.blockNumber);
    const toInfo = to ? await describe(ctx, "base", to) : null;
    const fn = to ? await nameCall(ctx, to, tx.input, toInfo?.proxy?.implementation ?? null) : null;
    const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? 0);
    const usd = await ethUsd(ctx);
    let failure: string | null = null;
    if (receipt.status !== "success") {
      try {
        await client.call({ account: from, to: to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber - 1n });
        failure = "It fails only in its own block's order: re-running it at the block before succeeds, so something earlier in the same block (often a price move or another transaction using the same funds) made it fail.";
      } catch (e: any) {
        failure = reason(errorData(e), String(e?.details ?? e?.shortMessage ?? "").split("\n")[0] || null);
      }
    }
    const [changes] = netChanges(moves, meta, [from]);
    const moved = moves.map((m) => ({ token: m.token, symbol: meta.get(m.token)?.symbol ?? null, from: m.from, to: m.to, ...(m.nft_id ? { nft_id: m.nft_id } : { amount: amount(m.raw, meta.get(m.token)?.decimals ?? null) }) }));
    const approvals = grants.map((g) => ({ kind: g.kind, token: g.token, symbol: meta.get(g.token)?.symbol ?? null, owner: g.owner, spender: g.spender, what: grantText(g, meta) }));
    const feeEth = formatEther(fee);
    const out = changes.tokens.filter((c) => c.change.startsWith("-")).map((c) => `${c.change.slice(1)} ${c.symbol ?? c.token}`);
    const inn = changes.tokens.filter((c) => c.change.startsWith("+")).map((c) => `${c.change.slice(1)} ${c.symbol ?? c.token}`);
    const summary = receipt.status !== "success"
      ? `Failed: ${failure!.replace(/\.$/, "")}. Nothing moved, but the sender still paid ${feeEth} ETH in fees.`
      : `${from} ${fn?.name ? `called ${fn.name} on` : "sent to"} ${to}${toInfo ? ` (${toInfo.kind.replace("_", " ")})` : ""}.${out.length ? ` It paid out ${out.join(", ")}` : ""}${inn.length ? `${out.length ? " and" : " It"} received ${inn.join(", ")}` : ""}${out.length || inn.length ? "." : " No tokens moved to or from the sender."}${approvals.length ? ` It ${approvals.map((a) => a.what).join("; ")}.` : ""} Fee: ${feeEth} ETH.`;
    return {
      hash, status: receipt.status === "success" ? "success" : "failed", summary,
      from, to, block: Number(receipt.blockNumber), time: new Date(Number(block.timestamp) * 1000).toISOString(),
      function: fn, eth_sent: formatEther(tx.value), transfers: moved, approvals, sender_changes: changes,
      fee_eth: feeEth, fee_usd: usd ? Math.round(Number(feeEth) * usd.price * 1e6) / 1e6 : null,
      failure_reason: failure,
      sources: ["Base RPC: transaction, receipt and block", fn?.source ?? "no function (plain transfer)", ...(failure ? ["eth_call at the previous block for the revert reason"] : []), usd ? "Chainlink ETH / USD (current price)" : "Chainlink ETH / USD: unavailable"],
    };
  },
};

// Who a spender or recipient is, for the warnings below: known Uniswap contract, wallet, or verified/unverified code.
async function whoIs(ctx: ToolContext, address: string) {
  const known: Record<string, string> = { [UNISWAP.permit2]: "Uniswap Permit2", [UNISWAP.universalRouter]: "Uniswap Universal Router", [UNISWAP.v2Router]: "Uniswap v2 router", [UNISWAP.v3Router]: "Uniswap SwapRouter02" };
  if (known[address]) return { address, is: known[address], kind: "contract", verified: true as boolean | null };
  const d = await describe(ctx, "base", address);
  return { address, is: d.kind === "wallet" ? "a wallet" : d.kind === "delegated_wallet" ? "a wallet run by delegated code" : `${d.source.verified ? "verified" : d.source.verified === false ? "unverified" : "unchecked"} ${d.kind}${d.source.name ? ` ${d.source.name}` : ""}`, kind: d.kind, verified: d.source.verified };
}

type Check = { name: string; result: "pass" | "info" | "warn" | "fail"; detail: string };

const checkTx: ToolDef = {
  name: "check_tx",
  title: "What will this transaction do?",
  category: "transactions",
  benefit: { kind: "money", text: "Drainers hide inside ordinary-looking transactions: a \"claim\" that grants an unlimited approval, a \"mint\" that sends your tokens away. This runs the transaction in a simulation first and says what would leave the wallet and who could take more later." },
  useWhen: "Run before signing or sending any transaction you didn't build yourself (from a dApp, a link, another agent or a chat), and before any approval. Answers what moves, what it grants and to whom, and whether it would fail.",
  description: "Simulates the unsigned transaction on top of the latest Base block (eth_simulateV1; nothing is sent), with every token, NFT and ETH movement traced. Reports the wallet's exact gains and losses, every approval it would grant and who the spender is, the function it calls, and whether it would revert and why. Flags approvals to wallets or unverified code, unlimited and approve-all grants, assets sent to a token contract, and assets that leave with nothing coming back.",
  inputs: { tx: txInput },
  inputDocs: txDocs,
  outputs: [
    { field: "verdict", type: '"SAFE" | "CAUTION" | "AVOID"', is: "AVOID: a check failed. CAUTION: something to confirm first. SAFE: none of the traps we check for.", howWorkedOut: "The worst check wins." },
    { field: "summary", type: "string", is: "What signing it would do, in plain words.", howWorkedOut: "Built from the simulation." },
    { field: "will_succeed / failure_reason", type: "boolean / string | null", is: "Whether it would go through, and why not.", howWorkedOut: "The simulated call's status and decoded revert data." },
    { field: "function", type: "object | null", is: "The function it calls.", howWorkedOut: "As in explain_tx." },
    { field: "changes", type: "array", is: "Net gain or loss per token (and NFTs) for the sender and every other address that gains or loses.", howWorkedOut: "Transfer logs from the simulation, including traced ETH." },
    { field: "approvals[]", type: "array", is: "Approvals it would grant: kind, token, spender, who the spender is, and what it allows.", howWorkedOut: "Approval, ApprovalForAll and Permit2 events from the simulation; the spender read with whats_this." },
    { field: "checks[]", type: "array", is: "Each rule: name, result, detail.", howWorkedOut: "would_fail (fail), approval_to_wallet / approval_to_unverified (fail), unlimited_approval and approve_all (warn), sent_to_token_contract (fail), nothing_back (warn: assets leave and nothing returns, on a call that isn't a plain transfer), unverified_target (warn), simulation (warn when no node could run it)." },
    { field: "block", type: "number", is: "The block it was simulated on.", howWorkedOut: "The simulation node's latest block." },
  ],
  notes: ["A simulation shows what would happen now. A contract can behave differently later (an upgrade, a price move, a check on the date), so sign soon after checking.", "Gas fees aren't included in changes; gas prices them."],
  example: async () => ({ tx: { from: EXAMPLE_WALLET, to: USDC, data: "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" } }),
  run: async ({ tx }, ctx) => {
    const from = checksum(tx.from), to = checksum(tx.to);
    const value = tx.value ? BigInt(tx.value) : 0n;
    const sim = await simulateTx(ctx, { from, to, data: tx.data as Hex | undefined, value });
    if (!sim) throw new ToolError(503, "No simulation node could run the transaction right now.", "Retry shortly.");
    const { moves, grants } = decodeLogs(sim.logs as any);
    const meta = await tokenMeta(ctx, [...moves.map((m) => m.token), ...grants.map((g) => g.token)]);
    const target = await whoIs(ctx, to);
    const fn = await nameCall(ctx, to, tx.data as Hex | undefined);
    const parties = [...new Set([from, ...moves.flatMap((m) => [m.from, m.to])])];
    const changes = netChanges(moves, meta, parties).filter((c) => c.tokens.length || c.nfts.length);
    const mine = changes.find((c) => c.address === from) ?? { tokens: [], nfts: [] };
    const checks: Check[] = [];
    const add = (name: string, result: Check["result"], detail: string) => checks.push({ name, result, detail });

    const approvals = await Promise.all(grants.filter((g) => g.owner === from && (g.kind === "nft_all" ? g.approved : g.raw !== 0n)).map(async (g) => {
      const who = await whoIs(ctx, g.spender);
      return { kind: g.kind, token: g.token, symbol: meta.get(g.token)?.symbol ?? null, spender: g.spender, spender_is: who.is, what: grantText(g, meta), unlimited: g.kind === "nft_all" || (g.raw ?? 0n) >= UNLIMITED_FROM, who };
    }));
    for (const a of approvals) {
      if (a.who.kind === "wallet" || a.who.kind === "delegated_wallet") add("approval_to_wallet", "fail", `It ${a.what}, and ${a.spender} is ${a.spender_is}. Phishing approvals go to wallets like this.`);
      else if (a.who.verified === false) add("approval_to_unverified", "fail", `It ${a.what}, and ${a.spender} is unverified code.`);
      else if (a.kind === "nft_all") add("approve_all", "warn", `It ${a.what} (${a.spender_is}). Only do this for a marketplace you trust.`);
      else if (a.unlimited) add("unlimited_approval", "warn", `It ${a.what} (${a.spender_is}), now and in the future.`);
    }
    // Any destination of the sender's assets that answers symbol() and decimals() is a token contract.
    const dests = [...new Set(moves.filter((m) => m.from === from && m.to !== from).map((m) => m.to))].slice(0, 10);
    const destMeta = await tokenMeta(ctx, dests);
    const sentToToken = moves.filter((m) => m.from === from && destMeta.get(m.to)?.decimals != null && m.to !== "0x0000000000000000000000000000000000000000");
    for (const m of sentToToken) add("sent_to_token_contract", "fail", `It sends ${meta.get(m.token)?.symbol ?? m.token} to ${m.to}, which is a token contract: funds sent there are usually lost.`);
    const out = mine.tokens.filter((c) => c.change.startsWith("-")), inn = mine.tokens.filter((c) => c.change.startsWith("+"));
    const nftOut = mine.nfts.filter((n) => n.change === "sent"), nftIn = mine.nfts.filter((n) => n.change === "received");
    const plainTransfer = !tx.data || tx.data === "0x" || ["transfer", "transferFrom", "safeTransferFrom"].includes(fn?.name ?? "");
    if ((out.length || nftOut.length) && !inn.length && !nftIn.length && !plainTransfer) add("nothing_back", "warn", `${[...out.map((c) => `${c.change.slice(1)} ${c.symbol ?? c.token}`), ...nftOut.map((n) => `${n.symbol ?? n.token} #${n.nft_id}`)].join(", ")} would leave the wallet and nothing comes back, through a ${fn?.name ?? "contract"} call rather than a plain transfer.`);
    if (target.kind !== "wallet" && target.verified === false) add("unverified_target", "warn", `It calls ${to}, whose code isn't verified, so nobody outside can read what it does.`);

    const failure = sim.ok ? null : reason(sim.returnData, sim.error);
    // A transaction that would fail is never SAFE: sending it only burns the fee. (Measured: USDC refuses transfers to
    // its own contract, so that mistake fails instead of losing funds.)
    if (failure) add("would_fail", "fail", `It would fail: ${failure.replace(/\.$/, "")}. Sending it would only cost the fee.`);
    const fails = checks.filter((c) => c.result === "fail"), warns = checks.filter((c) => c.result === "warn");
    const verdict = fails.length ? "AVOID" : warns.length ? "CAUTION" : "SAFE";
    const moving = [...out.map((c) => `${c.change.slice(1)} ${c.symbol ?? c.token}`), ...nftOut.map((n) => `${n.symbol ?? n.token} #${n.nft_id}`)];
    const getting = [...inn.map((c) => `${c.change.slice(1)} ${c.symbol ?? c.token}`), ...nftIn.map((n) => `${n.symbol ?? n.token} #${n.nft_id}`)];
    const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    const summary = !sim.ok ? `It would fail: ${failure!.replace(/\.$/, "")}.`
      : `${moving.length ? `The wallet would send ${moving.join(", ")}` : "Nothing would leave the wallet"}${getting.length ? ` and receive ${getting.join(", ")}` : ""}.${fails.length ? ` Don't sign: ${lc(fails[0].detail)}` : warns.length ? ` Check first: ${lc(warns[0].detail)}` : approvals.length ? ` It ${approvals.map((a) => a.what).join("; ")}.` : ""}`;
    return {
      verdict, summary, will_succeed: sim.ok, failure_reason: failure,
      from, to, to_is: target.is, function: fn, changes,
      approvals: approvals.map(({ who, ...a }) => a), checks, block: Number(sim.block),
      sources: ["eth_simulateV1 on a public Base node with transfers traced (nothing sent)", fn?.source ?? "plain transfer", "Base RPC for token names and spender code", "Sourcify and Basescan for verified source"],
    };
  },
};

const txMatches: ToolDef = {
  name: "tx_matches",
  title: "Does this transaction do exactly what was asked?",
  category: "transactions",
  benefit: { kind: "money", text: "An agent asked to \"send 25 USDC to Alice\" can be handed a transaction that sends 2,500, sends to someone else, sends a fake USDC, or also grants an approval. This compares what the transaction really does with what was asked, to the last unit." },
  useWhen: "Run before signing a payment someone else built (a dApp, another agent, an invoice link), with what the person actually asked for: which token, how much, to whom.",
  description: "Simulates the transaction and checks, to the smallest unit, that exactly the requested amount of the requested token leaves the sender and arrives at the requested recipient, that nothing else leaves the sender, and that it grants no approvals. Lists every difference in plain words.",
  inputs: { tx: txInput, intent: z.object({ token: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/), to: addressInput }) },
  inputDocs: [
    ...txDocs,
    { name: "intent", type: "object", required: true, lookingFor: "What was asked: token (contract address, or \"ETH\"), amount (readable, such as \"25.5\") and to (the recipient's address).", whereToGet: "The person's request. For a ticker, get the address from find_token first." },
  ],
  outputs: [
    { field: "verdict / matches", type: '"MATCH" | "MISMATCH" / boolean', is: "MATCH (matches: true) only when the transaction does exactly what was asked and nothing else.", howWorkedOut: "All the comparisons below pass." },
    { field: "summary", type: "string", is: "The answer in plain words.", howWorkedOut: "Built from the differences." },
    { field: "differences[]", type: "string[]", is: "Every way the transaction differs from the request.", howWorkedOut: "Simulated movements compared with the intent: wrong amount, wrong recipient, wrong token, extra assets leaving, approvals granted, or failure." },
    { field: "asked", type: "object", is: "The request, with the amount in raw units.", howWorkedOut: "amount × 10^decimals, exactly (decimals read on chain)." },
    { field: "actual", type: "object", is: "What the simulation shows: what leaves the sender, what the recipient gets, approvals.", howWorkedOut: "eth_simulateV1 with transfers traced." },
  ],
  example: async () => ({ tx: { from: EXAMPLE_WALLET, to: USDC, data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000002710" }, intent: { token: USDC, amount: "0.01", to: "0x000000000000000000000000000000000000dEaD" } }),
  run: async ({ tx, intent }, ctx) => {
    const from = checksum(tx.from), recipient = checksum(intent.to);
    const token = /^eth$/i.test(intent.token) ? "ETH" : addressInput.safeParse(intent.token).success ? checksum(intent.token) : null;
    if (!token) throw new ToolError(400, `intent.token "${intent.token}" is not a contract address or "ETH".`, "Use find_token to get the address for a ticker.");
    const meta0 = await tokenMeta(ctx, [token]);
    const decimals = meta0.get(token)?.decimals;
    if (decimals === null || decimals === undefined) throw new ToolError(400, `${token} doesn't answer like a token (decimals).`, "Check the token address.");
    const [whole, frac = ""] = intent.amount.split(".");
    if (frac.length > decimals) throw new ToolError(422, `${meta0.get(token)?.symbol} has ${decimals} decimals, so ${intent.amount} can't be sent exactly.`, `Use at most ${decimals} decimal places.`);
    const askedRaw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");

    const sim = await simulateTx(ctx, { from, to: checksum(tx.to), data: tx.data as Hex | undefined, value: tx.value ? BigInt(tx.value) : 0n });
    if (!sim) throw new ToolError(503, "No simulation node could run the transaction right now.", "Retry shortly.");
    const { moves, grants } = decodeLogs(sim.logs as any);
    const meta = await tokenMeta(ctx, [token, ...moves.map((m) => m.token), ...grants.map((g) => g.token)]);
    const sym = (t: string) => meta.get(t)?.symbol ?? t;
    const differences: string[] = [];
    if (!sim.ok) differences.push(`It would fail: ${reason(sim.returnData, sim.error).replace(/\.$/, "")}.`);
    const outOfSender = moves.filter((m) => m.from === from && m.to !== from);
    const toRecipient = outOfSender.filter((m) => m.token === token && m.to === recipient && !m.nft_id).reduce((s, m) => s + m.raw, 0n);
    if (sim.ok && toRecipient !== askedRaw) differences.push(`The recipient would get ${amount(toRecipient, decimals)} ${sym(token)}, not the ${intent.amount} asked for.`);
    for (const m of outOfSender) {
      if (m.token === token && m.to === recipient && !m.nft_id) continue;
      differences.push(m.nft_id ? `It also sends ${sym(m.token)} NFT #${m.nft_id} to ${m.to}.` : m.token !== token && m.to === recipient ? `It sends ${amount(m.raw, meta.get(m.token)?.decimals ?? null)} of ${sym(m.token)} (${m.token}) to the recipient: a different token from the one asked for.` : `It also sends ${amount(m.raw, meta.get(m.token)?.decimals ?? null)} ${sym(m.token)} to ${m.to}, who isn't the recipient.`);
    }
    for (const g of grants.filter((g) => g.owner === from && (g.kind === "nft_all" ? g.approved : g.raw !== 0n))) differences.push(`It also ${grantText(g, meta)}.`);
    const matches = differences.length === 0;
    return {
      verdict: matches ? "MATCH" : "MISMATCH", matches,
      summary: matches ? `It does exactly what was asked: ${intent.amount} ${sym(token)} from ${from} to ${recipient}, nothing else.` : `It doesn't match the request: ${differences[0]}${differences.length > 1 ? ` (and ${differences.length - 1} more difference(s))` : ""}`,
      differences,
      asked: { token, symbol: sym(token), amount: intent.amount, raw: askedRaw.toString(), to: recipient },
      actual: { will_succeed: sim.ok, recipient_gets: amount(toRecipient, decimals), leaving_sender: outOfSender.map((m) => ({ token: m.token, symbol: sym(m.token), to: m.to, ...(m.nft_id ? { nft_id: m.nft_id } : { amount: amount(m.raw, meta.get(m.token)?.decimals ?? null) }) })), approvals: grants.filter((g) => g.owner === from).map((g) => grantText(g, meta)) },
      sources: ["eth_simulateV1 on a public Base node with transfers traced (nothing sent)", "decimals() and symbol() on chain"],
    };
  },
};

export const TX_TOOLS: ToolDef[] = [explainTx, checkTx, txMatches];
