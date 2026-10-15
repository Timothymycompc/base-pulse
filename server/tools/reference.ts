// Reference tools: exact unit conversion and what a transaction will cost on Base.
import { erc20Abi, formatEther, formatGwei, formatUnits, parseAbi, type Hex } from "viem";
import { publicActionsL2 } from "viem/op-stack";
import { z } from "zod";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, networkInput, USDC } from "./chain";

// Chainlink's ETH / USD feed on Base (description() answers "ETH / USD", 8 decimals; checked on chain 2026-10-15).
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
// A Chainlink answer older than this is reported as stale instead of used: the feed updates at least daily.
const FEED_MAX_AGE_S = 26 * 3600;
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

// ETH's price in dollars from Chainlink, or null when the feed is unreachable or stale (never a guess).
export async function ethUsd(ctx: ToolContext): Promise<{ price: number; updatedAt: number } | null> {
  try {
    const [, answer, , updatedAt] = await ctx.client("base").readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData", authorizationList: undefined });
    const now = (ctx.now ?? Date.now)() / 1000;
    if (answer <= 0n || now - Number(updatedAt) > FEED_MAX_AGE_S) return null;
    return { price: Number(answer) / 1e8, updatedAt: Number(updatedAt) };
  } catch {
    return null;
  }
}

// A decimal string with no sign, exponent or thousands separators: "1", "0.5", "1250.000001".
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

const convert: ToolDef = {
  name: "convert",
  title: "Exact token amount conversion",
  category: "reference",
  benefit: { kind: "money", text: "USDC has 6 decimals and ETH has 18. Guessing wrong sends a million times too much or too little. This uses the token's real decimals and never rounds." },
  useWhen: "Run before building any transfer or approval, to turn an amount a person said (\"25.5 USDC\") into the raw number a transaction needs, or a raw number from a transaction back into a readable amount.",
  description: "Reads the token's decimals from its contract on Base and converts exactly in either direction. If an amount has more decimal places than the token supports, it refuses instead of rounding, because a rounded amount isn't the amount that was asked for.",
  inputs: { token: z.string(), amount: z.string().optional(), raw: z.string().optional(), network: networkInput },
  inputDocs: [
    { name: "token", type: "string", required: true, lookingFor: 'The token\'s contract address, or "ETH" for native ether.', whereToGet: "find_token for a ticker, or the token field of a transaction. Never guess an address from a name." },
    { name: "amount", type: "string", required: false, lookingFor: 'A readable amount such as "25.5". Give this or raw, not both. Plain digits and one dot only: no commas or minus sign.', whereToGet: "What the person asked to send or approve." },
    { name: "raw", type: "string", required: false, lookingFor: 'The amount in the token\'s smallest unit, as whole digits, such as "25500000" for 25.5 USDC.', whereToGet: "The value or amount field of a transaction, event or contract call." },
    { name: "network", type: "string", required: false, lookingFor: '"base" (default) or "base-sepolia".', whereToGet: "Leave it out for real funds." },
  ],
  outputs: [
    { field: "token", type: "string", is: 'The token, checksummed, or "ETH".', howWorkedOut: "The input." },
    { field: "symbol", type: "string", is: "What the contract calls itself.", howWorkedOut: "symbol() on the contract; ETH for native ether. Anyone can pick any symbol, so it proves nothing." },
    { field: "decimals", type: "number", is: "How many decimal places the token uses.", howWorkedOut: "decimals() on the contract; 18 for ETH." },
    { field: "amount", type: "string", is: "The readable amount.", howWorkedOut: "raw divided by 10^decimals, exactly (no rounding)." },
    { field: "raw", type: "string", is: "The amount in the smallest unit, for a transaction.", howWorkedOut: "amount times 10^decimals, exactly." },
    { field: "source", type: "string", is: "Where the decimals came from.", howWorkedOut: "Names the contract read." },
  ],
  example: async () => ({ token: USDC, amount: "25.5" }),
  run: async ({ token, amount, raw, network }, ctx) => {
    if ((amount === undefined) === (raw === undefined)) throw new ToolError(400, "Give exactly one of amount or raw.", 'amount is readable ("25.5"); raw is the smallest unit ("25500000" for USDC).');
    let address: string | "ETH", symbol: string, decimals: number, source: string;
    if (/^eth$/i.test(token)) {
      [address, symbol, decimals, source] = ["ETH", "ETH", 18, "ETH has 18 decimals by definition (1 ETH = 10^18 wei)."];
    } else {
      if (!addressInput.safeParse(token).success) throw new ToolError(400, `"${token}" is not a token address or "ETH".`, "Use find_token to get the contract address for a ticker.");
      address = checksum(token);
      const client = ctx.client(network);
      try {
        [symbol, decimals] = await Promise.all([
          client.readContract({ address: address as Hex, abi: erc20Abi, functionName: "symbol", authorizationList: undefined }),
          client.readContract({ address: address as Hex, abi: erc20Abi, functionName: "decimals", authorizationList: undefined }),
        ]);
      } catch {
        throw new ToolError(400, `${address} doesn't answer like an ERC-20 token on ${network} (symbol and decimals).`, "Check it is the token's own contract, on the right network. whats_this shows what an address is.");
      }
      source = `decimals() and symbol() on ${address}, ${network}`;
    }
    if (amount !== undefined) {
      const m = amount.trim().match(DECIMAL);
      if (!m) throw new ToolError(400, `"${amount}" is not a plain amount.`, 'Use digits and at most one dot, like "1250.5". No commas, signs or exponents.');
      const fraction = m[2] ?? "";
      if (fraction.length > decimals) throw new ToolError(422, `${symbol} has ${decimals} decimals, so ${amount} can't be sent exactly; it would have to be rounded.`, `Use at most ${decimals} decimal places.`);
      raw = (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString();
    } else {
      if (!/^\d+$/.test(raw!.trim())) throw new ToolError(400, `"${raw}" is not a whole number of the smallest unit.`, "raw must be digits only.");
      raw = BigInt(raw!.trim()).toString();
    }
    return { token: address, symbol, decimals, amount: formatUnits(BigInt(raw), decimals), raw, source };
  },
};

const txInput = z.object({ from: addressInput.optional(), to: addressInput, data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).optional(), value: z.string().regex(/^\d+$/).optional() });

const gas: ToolDef = {
  name: "gas",
  title: "Transaction cost on Base",
  category: "network",
  benefit: { kind: "accuracy", text: "Base charges two fees: the L2 execution fee and an L1 data fee for posting to Ethereum. Quoting only the first understates the cost, and a wallet left without enough ETH can't move anything." },
  useWhen: "Run before sending a transaction, or when someone asks what a transfer, swap or contract call costs on Base right now. Leave tx out for a plain ETH transfer.",
  description: "Estimates the gas the transaction uses, prices it at the current base fee plus tip, adds Base's L1 data fee from the chain's own GasPriceOracle, and converts to dollars with Chainlink's ETH / USD feed. Also gives the most it could cost if fees rise before it lands.",
  inputs: { tx: txInput.optional(), network: networkInput },
  inputDocs: [
    { name: "tx", type: "object", required: false, lookingFor: "The transaction to price: to (required), and optionally from, data (0x hex) and value (in wei). Leave tx out to price a plain ETH transfer.", whereToGet: "The transaction your wallet or a dApp is about to send." },
    { name: "tx.from", type: "string", required: false, lookingFor: "The sender. Matters for calls whose cost depends on the sender (for example a token transfer from a wallet that holds the tokens).", whereToGet: "Your wallet address." },
    { name: "network", type: "string", required: false, lookingFor: '"base" (default) or "base-sepolia".', whereToGet: "Leave it out for real funds." },
  ],
  outputs: [
    { field: "gas_limit", type: "number", is: "Gas the transaction is expected to use.", howWorkedOut: "eth_estimateGas on the transaction. A plain ETH transfer to a wallet with no code is 21,000; a recipient that is a contract or a wallet with an EIP-7702 delegation runs code and costs more." },
    { field: "base_fee_gwei / priority_fee_gwei", type: "string", is: "The current price per unit of gas, and the usual tip.", howWorkedOut: "The latest block's base fee, and eth_maxPriorityFeePerGas." },
    { field: "l2_fee_eth", type: "string", is: "The execution fee at today's prices.", howWorkedOut: "gas_limit × (base fee + tip)." },
    { field: "l1_data_fee_eth", type: "string", is: "Base's fee for posting the transaction's data to Ethereum.", howWorkedOut: "getL1Fee on Base's GasPriceOracle (0x420000000000000000000000000000000000000F) with the signed-size transaction." },
    { field: "total_eth / total_usd", type: "string / number | null", is: "What it should cost now, in ETH and dollars.", howWorkedOut: "l2_fee_eth + l1_data_fee_eth; dollars from Chainlink's ETH / USD feed on Base. total_usd is null when the feed is stale or unreachable." },
    { field: "max_total_eth", type: "string", is: "The most it could cost if fees spike before it lands; keep at least this much ETH in the wallet.", howWorkedOut: "gas_limit × max fee per gas (twice the base fee plus the tip, as wallets set it) + l1_data_fee_eth." },
    { field: "eth_usd", type: "number | null", is: "The ETH price used.", howWorkedOut: "Chainlink ETH / USD latestRoundData on Base." },
    { field: "block", type: "number", is: "The block the fees were read at.", howWorkedOut: "The latest block." },
    { field: "sources", type: "string[]", is: "Where each number came from.", howWorkedOut: "Names each read." },
  ],
  notes: ["Fees change every block (about every 2 seconds), so this is a quote for now, not a promise.", "If the transaction would fail, the gas estimate fails too, and the tool says why instead of guessing a cost. check_tx shows what it would do."],
  example: async () => ({}),
  run: async ({ tx, network }, ctx) => {
    const client = ctx.client(network).extend(publicActionsL2());
    const request = tx ? { account: (tx.from ? checksum(tx.from) : EXAMPLE_WALLET) as Hex, to: checksum(tx.to) as Hex, data: tx.data as Hex | undefined, value: tx.value ? BigInt(tx.value) : 0n }
      // A plain transfer goes to an address with no code (the usual burn address): sending to a contract, or to a wallet
      // with an EIP-7702 delegation (EXAMPLE_WALLET has one on Base), runs code and costs more than 21,000 gas.
      : { account: EXAMPLE_WALLET as Hex, to: "0x000000000000000000000000000000000000dEaD" as Hex, value: 0n };
    const block = await client.getBlock();
    let gasLimit: bigint;
    try {
      gasLimit = await client.estimateGas({ ...request, blockNumber: block.number });
    } catch (error: any) {
      const reason = String(error?.shortMessage ?? error?.message ?? error).split("\n")[0];
      throw new ToolError(422, `The transaction would fail, so it has no cost to quote: ${reason}`, "check_tx shows what the transaction does and why it fails.");
    }
    const [tip, l1Fee, usd] = await Promise.all([
      client.estimateMaxPriorityFeePerGas(),
      client.estimateL1Fee({ ...request, gas: gasLimit, chain: client.chain }),
      ethUsd(ctx),
    ]);
    const baseFee = block.baseFeePerGas ?? 0n;
    const l2 = gasLimit * (baseFee + tip);
    const max = gasLimit * (baseFee * 2n + tip) + l1Fee;
    const total = l2 + l1Fee;
    return {
      gas_limit: Number(gasLimit),
      base_fee_gwei: formatGwei(baseFee), priority_fee_gwei: formatGwei(tip),
      l2_fee_eth: formatEther(l2), l1_data_fee_eth: formatEther(l1Fee),
      total_eth: formatEther(total), total_usd: usd ? Math.round(Number(formatEther(total)) * usd.price * 1e6) / 1e6 : null,
      max_total_eth: formatEther(max),
      eth_usd: usd?.price ?? null, block: Number(block.number),
      sources: [`eth_estimateGas and block ${block.number}'s base fee`, "eth_maxPriorityFeePerGas", "GasPriceOracle getL1Fee (0x420000000000000000000000000000000000000F)", usd ? `Chainlink ETH / USD (${ETH_USD_FEED})` : "Chainlink ETH / USD: stale or unreachable, so no dollar figure"],
    };
  },
};

export const REFERENCE_TOOLS: ToolDef[] = [convert, gas];
