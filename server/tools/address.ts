// Address tools: what an address is, before anyone sends to it, approves it or trusts it.
import { erc20Abi, formatEther, getAddress, parseAbi, type Hex } from "viem";
import type { ToolContext, ToolDef } from "./types";
import { ToolError } from "./types";
import { addressInput, checksum, EXAMPLE_WALLET, networkInput } from "./chain";
import { verifiedSource } from "./source";

// EIP-1967 storage slots: where a proxy keeps its implementation, admin and beacon. https://eips.ethereum.org/EIPS/eip-1967
const SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;
// The older ZeppelinOS slots, still used by Circle's USDC proxy on Base (keccak256("org.zeppelinos.proxy.implementation")
// and ("org.zeppelinos.proxy.admin")); found when USDC showed no EIP-1967 implementation.
const ZOS_SLOTS = {
  implementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  admin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
} as const;
// EIP-7702: a wallet that has delegated to code holds 0xef0100 followed by the code's address. https://eips.ethereum.org/EIPS/eip-7702
const DELEGATION_PREFIX = "0xef0100";
// ERC-165 interface ids for NFTs. https://eips.ethereum.org/EIPS/eip-721, https://eips.ethereum.org/EIPS/eip-1155
const ERC721 = "0x80ac58cd", ERC1155 = "0xd9b67a26";
const probeAbi = parseAbi([
  "function supportsInterface(bytes4) view returns (bool)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
]);

const slotAddress = (word: string | undefined) => (word && BigInt(word) ? getAddress(`0x${word.slice(-40)}`) : null);
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch { return null; }
}

export type Described = {
  address: string;
  kind: "wallet" | "delegated_wallet" | "token" | "nft" | "multisig" | "contract";
  eth: string; tx_count: number;
  delegated_to: string | null;
  proxy: { implementation: string | null; admin: string | null; beacon: string | null } | null;
  token: { symbol: string; name: string; decimals: number } | null;
  nft: "erc721" | "erc1155" | null;
  multisig: { threshold: number; owners: string[] } | null;
  source: { verified: boolean | null; name: string | null; from: string };
};

// Reads everything whats_this reports. Shared with recipient_check.
export async function describe(ctx: ToolContext, network: string, input: string): Promise<Described> {
  const client = ctx.client(network);
  const address = checksum(input) as Hex;
  const [code, wei, nonce] = await Promise.all([client.getCode({ address }), client.getBalance({ address }), client.getTransactionCount({ address })]);
  const base = { address, eth: formatEther(wei), tx_count: nonce, delegated_to: null, proxy: null, token: null, nft: null, multisig: null };
  const sourceOf = async (a: string) => {
    const s = network === "base" ? await verifiedSource(ctx, a) : null;
    return s ? { verified: s.found, name: s.name, from: s.from } : { verified: null, name: null, from: network === "base" ? "unreachable" : "not checked on this network" };
  };
  if (!code || code === "0x") return { ...base, kind: "wallet", source: { verified: null, name: null, from: "not a contract" } };
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) {
    const delegate = getAddress(`0x${code.slice(8)}`);
    return { ...base, kind: "delegated_wallet", delegated_to: delegate, source: await sourceOf(delegate) };
  }
  const read = <T,>(functionName: string, args: unknown[] = [], abi: any = probeAbi) => attempt(() => client.readContract({ address, abi, functionName, args, authorizationList: undefined } as any) as Promise<T>);
  const slot = (s: Hex) => client.getStorageAt({ address, slot: s });
  const [impl, admin, beacon, zosImpl, zosAdmin, symbol, name, decimals, is721, is1155, threshold, owners] = await Promise.all([
    slot(SLOTS.implementation), slot(SLOTS.admin), slot(SLOTS.beacon), slot(ZOS_SLOTS.implementation), slot(ZOS_SLOTS.admin),
    read<string>("symbol", [], erc20Abi), read<string>("name", [], erc20Abi), read<number>("decimals", [], erc20Abi),
    read<boolean>("supportsInterface", [ERC721]), read<boolean>("supportsInterface", [ERC1155]),
    read<bigint>("getThreshold"), read<string[]>("getOwners"),
  ]);
  const own = network === "base" ? await verifiedSource(ctx, address) : null;
  // Storage slots first; Sourcify's proxy detection covers other patterns (for example EIP-1167 clones and Safes).
  const resolved = own?.proxy?.isProxy && own.proxy.implementation ? getAddress(own.proxy.implementation) : null;
  const proxy = { implementation: slotAddress(impl) ?? slotAddress(zosImpl) ?? resolved, admin: slotAddress(admin) ?? slotAddress(zosAdmin), beacon: slotAddress(beacon) };
  const isProxy = Boolean(proxy.implementation || proxy.beacon);
  const nft = is721 ? "erc721" : is1155 ? "erc1155" : null;
  const token = !nft && symbol !== null && decimals !== null ? { symbol, name: name ?? "", decimals: Number(decimals) } : null;
  const multisig = threshold !== null && owners ? { threshold: Number(threshold), owners: owners.map((o) => getAddress(o)) } : null;
  const kind = multisig ? "multisig" : token ? "token" : nft ? "nft" : "contract";
  const source = proxy.implementation ? await sourceOf(proxy.implementation) : own ? { verified: own.found, name: own.name, from: own.from } : await sourceOf(address);
  return { ...base, kind, proxy: isProxy ? proxy : null, token, nft, multisig, source };
}

const KIND_TEXT: Record<Described["kind"], string> = {
  wallet: "A wallet (no code): a person or app holds its key.",
  delegated_wallet: "A wallet that has handed control to code with an EIP-7702 delegation: the code below decides what the wallet does.",
  token: "A token contract.",
  nft: "An NFT collection contract.",
  multisig: "A multisig wallet (Safe): moving funds needs several owners to sign.",
  contract: "A contract that isn't a token, NFT or multisig (for example a pool, router, vault or app).",
};

const whatsThis: ToolDef = {
  name: "whats_this",
  title: "What is this address?",
  category: "reference",
  benefit: { kind: "money", text: "Tokens sent to a contract that can't handle them are lost for good, and a wallet delegated to unknown code can be emptied by that code. This tells you what an address really is before you send or trust." },
  useWhen: "Run on any address you're about to send to, approve, sign for or trust, when you don't already know what it is. Also answers \"is this a wallet or a contract?\" and \"is this contract verified?\"",
  description: "Reads the address on Base: whether it has code, an EIP-7702 delegation (a wallet run by code), an upgradeable proxy (EIP-1967), and whether it answers as a token, an NFT collection or a Safe multisig. Adds its ETH balance, how many transactions it has sent and whether its source code is verified.",
  inputs: { address: addressInput, network: networkInput },
  inputDocs: [
    { name: "address", type: "string", required: true, lookingFor: "Any address: 0x followed by 40 hex characters.", whereToGet: "The recipient, spender or contract you've been given." },
    { name: "network", type: "string", required: false, lookingFor: '"base" (default) or "base-sepolia".', whereToGet: "Leave it out for real funds." },
  ],
  outputs: [
    { field: "address", type: "string", is: "The address, checksummed.", howWorkedOut: "The input." },
    { field: "kind", type: '"wallet" | "delegated_wallet" | "token" | "nft" | "multisig" | "contract"', is: "What it is.", howWorkedOut: "No code: wallet. Code of 0xef0100 + address: delegated_wallet (EIP-7702). Otherwise a contract, called multisig if getThreshold() and getOwners() answer (Safe), nft if supportsInterface says ERC-721 or ERC-1155, token if symbol() and decimals() answer." },
    { field: "what_it_is", type: "string", is: "kind in plain words.", howWorkedOut: "A fixed sentence per kind." },
    { field: "eth / tx_count", type: "string / number", is: "Its ETH balance, and how many transactions it has sent.", howWorkedOut: "eth_getBalance and eth_getTransactionCount. A contract's count is the number of contracts it has created." },
    { field: "delegated_to", type: "string | null", is: "For a delegated wallet, the code that controls it.", howWorkedOut: "The address after 0xef0100 in the wallet's code." },
    { field: "proxy", type: "object | null", is: "For an upgradeable proxy: implementation (the code that runs), admin (who can replace it) and beacon.", howWorkedOut: "The EIP-1967 storage slots, then the older ZeppelinOS slots (USDC uses these), then Sourcify's proxy detection. null when it isn't a proxy." },
    { field: "token / nft / multisig", type: "object | string | null", is: "Token symbol, name and decimals; the NFT standard; the multisig's threshold and owners.", howWorkedOut: "The contract's own answers. Names prove nothing: anyone can call a token USDC." },
    { field: "source", type: "object", is: "verified (true, false or null for unknown), the contract name, and where it was checked. For a proxy or delegated wallet, this is the code it runs.", howWorkedOut: "Sourcify, then Basescan when a key is set." },
    { field: "warnings", type: "string[]", is: "Things to know before sending or trusting, each with its reason.", howWorkedOut: "Unverified code controlling a wallet; an upgradeable contract; a contract with unverified code; tokens sent to a token contract." },
    { field: "sources", type: "string[]", is: "Where the facts came from.", howWorkedOut: "Names each read." },
  ],
  notes: ["When the contract was created and by whom is not reported yet: the free explorer APIs for Base don't provide it."],
  example: async () => ({ address: EXAMPLE_WALLET }),
  run: async ({ address, network }, ctx) => {
    const d = await describe(ctx, network, address);
    const warnings: string[] = [];
    if (d.kind === "delegated_wallet") {
      if (d.source.verified === false) warnings.push(`This wallet is run by code at ${d.delegated_to} whose source isn't verified. Sweeper scams use exactly this: once delegated, the code can move everything the wallet holds.`);
      else if (d.source.verified === null) warnings.push(`This wallet is run by code at ${d.delegated_to}; whether that code is verified couldn't be checked.`);
    }
    // A Safe is a proxy too, but only its own owners, signing together, can change its code.
    if (d.proxy && d.kind !== "multisig") warnings.push(`Upgradeable: ${d.proxy.admin ? `the admin ${d.proxy.admin}` : "whoever controls upgrades"} can replace the code that runs, at any time.`);
    if (d.kind !== "wallet" && d.kind !== "delegated_wallet" && d.source.verified === false) warnings.push("Its source code isn't verified, so nobody outside can read what it does.");
    if (d.kind === "token") warnings.push("This is a token's own contract. Tokens sent to it are usually lost: send to a wallet instead.");
    return {
      ...d, what_it_is: KIND_TEXT[d.kind], warnings,
      sources: ["Base RPC: eth_getCode, eth_getBalance, eth_getTransactionCount, EIP-1967 storage slots, and the contract's own answers", d.source.from === "sourcify" ? "Sourcify" : d.source.from === "basescan" ? "Basescan" : `verified source: ${d.source.from}`],
    };
  },
};

export const ADDRESS_TOOLS: ToolDef[] = [whatsThis];
