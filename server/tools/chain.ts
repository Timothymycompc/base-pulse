// Chain facts every tool shares: the networks we serve, well-known token addresses, and address checks.
import { createPublicClient, http, isAddress, getAddress, type Chain, type PublicClient, type Transport } from "viem";
import { base, baseSepolia } from "viem/chains";
import { z } from "zod";
import { ToolError } from "./types";

// Native USDC on Base, issued by Circle (not the bridged USDbC). https://developers.circle.com/stablecoins/usdc-contract-addresses
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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
