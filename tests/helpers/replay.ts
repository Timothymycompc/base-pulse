// Record real mainnet answers once, then replay them so the safety tests run offline and give the same answer every time.
// Main-node and simulation-node answers are kept apart: each node has its own latest block.
import { createPublicClient, custom, http, type Chain, type PublicClient, type Transport } from "viem";
import { base } from "viem/chains";
import { simulationClients } from "../../server/tools/chain";
import type { ToolContext } from "../../server/tools";

export type Recording = { now: number; rpc: Record<string, unknown>; sim: Record<string, unknown>; http: Record<string, unknown> };
type Stored = { result: unknown } | { error: { message: string; code?: number; data?: unknown } };

const key = (method: string, params: unknown) => `${method} ${JSON.stringify(params ?? [])}`;
const clientOver = (request: (args: { method: string; params?: unknown }) => Promise<unknown>) =>
  createPublicClient({ chain: base, transport: custom({ request }) }) as PublicClient<Transport, Chain>;

function rethrow(stored: Stored): never {
  const { message, code, data } = (stored as any).error;
  throw Object.assign(new Error(message), { code, data });
}

async function remember(map: Record<string, unknown>, k: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    map[k] = { result } satisfies Stored;
    return result;
  } catch (error: any) {
    map[k] = { error: { message: String(error?.message ?? error), code: error?.code, data: error?.data } } satisfies Stored;
    throw error;
  }
}

const fetchJson = async (url: string, timeoutMs = 8000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
};

// A context that answers from the real chain and services and writes every answer into recording.
export function recordingContext(): { ctx: ToolContext; recording: Recording } {
  const recording: Recording = { now: Date.now(), rpc: {}, sim: {}, http: {} };
  const main = http(process.env.BASE_RPC_URL || undefined, { timeout: 15_000 })({ chain: base });
  // Only the first simulation node is used, so the recording holds one node's view.
  const simNode = simulationClients()[0];
  const ctx: ToolContext = {
    now: () => recording.now,
    client: () => clientOver(({ method, params }) => remember(recording.rpc, key(method, params), () => main.request({ method, params } as any))),
    simulators: () => [clientOver(({ method, params }) => remember(recording.sim, key(method, params), () => simNode.request({ method, params } as any)))],
    fetchJson: (url, timeoutMs) => remember(recording.http, url, () => fetchJson(url, timeoutMs)) as Promise<any>,
  };
  return { ctx, recording };
}

// A context that answers only from a recording; anything not recorded is an error, so a changed tool shows up.
export function replayContext(recording: Recording): ToolContext {
  const answer = (map: Record<string, unknown>, k: string) => {
    if (!(k in map)) throw new Error(`not in the recording: ${k.slice(0, 160)}`);
    const stored = map[k] as Stored;
    return "error" in stored ? rethrow(stored) : stored.result;
  };
  return {
    now: () => recording.now,
    client: () => clientOver(async ({ method, params }) => answer(recording.rpc, key(method, params))),
    simulators: () => [clientOver(async ({ method, params }) => answer(recording.sim, key(method, params)))],
    fetchJson: async (url) => answer(recording.http, url),
  };
}
