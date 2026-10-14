// Chain facts every tool shares: the networks we serve, well-known token addresses, and address checks.
import { createPublicClient, http, isAddress, getAddress, type Chain, type PublicClient, type Transport } from "viem";
import { base, baseSepolia } from "viem/chains";
import { z } from "zod";
import { ToolError } from "./types";

// Native USDC on Base, issued by Circle (not the bridged USDbC). https://developers.circle.com/stablecoins/usdc-contract-addresses
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Wrapped ETH, the token most Base pools pair against. Predeployed by the OP Stack at this fixed address.
export const WETH = "0x4200000000000000000000000000000000000006";

// Uniswap on Base, from https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments and
// .../v2/reference/smart-contracts/v2-deployments, each confirmed on chain (the routers report these factories).
export const UNISWAP = {
  v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  v3Router: "0x2626664c2603336E57B271c5C0b26F421741e481", // SwapRouter02
  v3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // QuoterV2
} as const;

// A public, well-known wallet with real Base holdings, used for live examples.
export const EXAMPLE_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

export const NETWORKS = ["base", "base-sepolia"] as const;
export type Network = (typeof NETWORKS)[number];
export const networkInput = z.enum(NETWORKS).default("base");

// One client per network, made on first use. BASE_RPC_URL (a Secret Manager secret) replaces the slow public endpoint.
const clients = new Map<string, PublicClient<Transport, Chain>>();
export function clientFor(network: string): PublicClient<Transport, Chain> {
  if (!NETWORKS.includes(network as Network)) throw new ToolError(400, `Unsupported network "${network}".`, `Use one of: ${NETWORKS.join(", ")}.`);
  if (!clients.has(network)) {
    const chain = network === "base" ? base : baseSepolia;
    const url = network === "base" ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
    clients.set(network, createPublicClient({ chain, transport: http(url || undefined, { timeout: 10_000 }) }) as PublicClient<Transport, Chain>);
  }
  return clients.get(network)!;
}

// An address input: 0x plus 40 hex characters. Returned in checksummed form so outputs are consistent.
export const addressInput = z.string().refine((v) => isAddress(v, { strict: false }), "Not an address: expected 0x followed by 40 hex characters.");
export const checksum = (address: string) => getAddress(address);
