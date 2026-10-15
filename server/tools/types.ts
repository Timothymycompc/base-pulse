import type { Chain, PublicClient, Transport } from "viem";
import type { z } from "zod";
import type { SanctionsList } from "../ofac";

// Documentation for one input, in plain words: what it is looking for and where to get it.
export type InputDoc = {
  name: string;
  type: string;
  required: boolean;
  lookingFor: string;
  whereToGet: string;
};

// Documentation for one output field, in plain words: what the value is and how the gateway works it out.
// Nested fields use dot and [] paths, e.g. "balance_changes[].change".
export type OutputDoc = {
  field: string;
  type: string;
  is: string;
  howWorkedOut: string;
};

export type ToolContext = {
  // A read-only client for the chain the call asked for (Base mainnet unless the tool says otherwise).
  client: (network: string) => PublicClient<Transport, Chain>;
  fetchJson: (url: string, timeoutMs?: number) => Promise<any>;
  // Nodes that answer eth_simulateV1, tried in order (see simulationClients). Defaults to client("base").
  simulators?: () => PublicClient<Transport, Chain>[];
  // Etherscan API key for Basescan's verified source. Defaults to the ETHERSCAN_API_KEY secret; "" means none.
  etherscanKey?: string;
  // The current time in ms. Tests replaying recorded data pass the recording time, so age checks give the same answer.
  now?: () => number;
  // POST a JSON body and read JSON back. Optional so contexts that never need it can omit it.
  postJson?: (url: string, body: unknown, timeoutMs?: number) => Promise<any>;
  // Coinbase's SQL API over indexed Base history (see cdpSql in server/cdp.ts). Absent when no CDP key is configured.
  sql?: (query: string) => Promise<Record<string, any>[]>;
  // OFAC's sanctioned EVM addresses. Defaults to the server's copy (bundled, refreshed every 12 hours).
  sanctions?: () => Promise<SanctionsList>;
};

export type ToolCategory = "transactions" | "tokens" | "wallets" | "network" | "reference";

export interface ToolDef {
  name: string;
  title: string;
  category: ToolCategory;
  // A concrete example of the money or the hallucination this tool prevents.
  benefit: { kind: "money" | "accuracy"; text: string };
  // One line telling an agent when to call this tool. Most paid listings lack this; ours always have it.
  useWhen: string;
  description: string;
  inputs: z.ZodRawShape;
  inputDocs: InputDoc[];
  outputs: OutputDoc[];
  notes?: string[];
  // Builds arguments from live mainnet data, so the playground runs a real request with no edits.
  example: (ctx: ToolContext) => Promise<Record<string, unknown>>;
  run: (args: any, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

// A failure the caller can fix; carries an HTTP status and a hint.
export class ToolError extends Error {
  constructor(public status: number, message: string, public fix?: string) {
    super(message);
  }
}
