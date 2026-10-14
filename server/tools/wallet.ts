// Wallet reads.
import { erc20Abi, formatEther, formatUnits } from "viem";
import type { ToolDef } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, networkInput, USDC } from "./chain";

const balance: ToolDef = {
  name: "balance",
  title: "ETH and USDC balance",
  category: "wallets",
  benefit: { kind: "money", text: "An agent that trusts a balance it remembers can send a payment that fails, or pay gas from a wallet that can't cover it." },
  useWhen: "Run before sending ETH or USDC or paying gas, to confirm the wallet really has enough. Never trust a balance remembered from earlier in a chat.",
  description: "Reads a wallet's ETH and native USDC balance on Base directly from the chain, at one block.",
  inputs: { wallet: addressInput, network: networkInput },
  inputDocs: [
    { name: "wallet", type: "string", required: true, lookingFor: "The wallet address to check: 0x followed by 40 hex characters.", whereToGet: "The user, your own wallet, or the 'from' of a transaction." },
    { name: "network", type: "string", required: false, lookingFor: '"base" (default) or "base-sepolia" for the test network.', whereToGet: "Leave it out for real funds." },
  ],
  outputs: [
    { field: "wallet", type: "string", is: "The wallet, in checksummed form.", howWorkedOut: "The input address, checksummed." },
    { field: "network", type: "string", is: "The network read.", howWorkedOut: "The input, or base." },
    { field: "block", type: "number", is: "The block both balances were read at.", howWorkedOut: "The latest block number from the RPC, then both reads pinned to it." },
    { field: "eth", type: "string", is: "ETH balance in ETH (18 decimals).", howWorkedOut: "eth_getBalance at that block, divided by 10^18." },
    { field: "eth_wei", type: "string", is: "ETH balance in wei, the raw unit.", howWorkedOut: "eth_getBalance at that block." },
    { field: "usdc", type: "string | null", is: "Native USDC balance (6 decimals). null on base-sepolia, where we don't track a USDC address.", howWorkedOut: "balanceOf on Circle's USDC contract at that block, divided by 10^6." },
    { field: "source", type: "string", is: "Where the numbers came from.", howWorkedOut: "Names the RPC calls and block." },
  ],
  example: async () => ({ wallet: EXAMPLE_WALLET }),
  run: async ({ wallet, network }, ctx) => {
    const client = ctx.client(network);
    const address = checksum(wallet);
    const block = await client.getBlockNumber();
    const [wei, usdcRaw] = await Promise.all([
      client.getBalance({ address, blockNumber: block }),
      network === "base" ? client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: block, authorizationList: undefined }) : Promise.resolve(null),
    ]);
    return {
      wallet: address, network, block: Number(block),
      eth: formatEther(wei), eth_wei: wei.toString(),
      usdc: usdcRaw === null ? null : formatUnits(usdcRaw, 6),
      source: `Base RPC: eth_getBalance and USDC balanceOf at block ${block}`,
    };
  },
};

export const WALLET_TOOLS: ToolDef[] = [balance];
