// Client for the gateway's tool registry API. Everything the playground and docs show comes from here.

export type InputDoc = { name: string; type: string; required: boolean; lookingFor: string; whereToGet: string };
export type OutputDoc = { field: string; type: string; is: string; howWorkedOut: string };
export type JsonSchema = {
  type?: string; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  properties?: Record<string, JsonSchema>; required?: string[]; anyOf?: JsonSchema[]; const?: unknown;
};
export type ToolDoc = {
  name: string; title: string; category: "transactions" | "tokens" | "wallets" | "network" | "reference";
  useWhen: string; description: string; benefit: { kind: "money" | "accuracy"; text: string };
  price: string | null; priceText: string;
  http: { method: string; path: string }; inputs: InputDoc[]; outputs: OutputDoc[]; notes: string[]; inputSchema: JsonSchema;
};
export type ToolsIndex = { freeCallsPerTool: number; payments: { network: string; asset: string; payTo: string }; tools: ToolDoc[] };

let indexPromise: Promise<ToolsIndex> | null = null;
export function loadTools(): Promise<ToolsIndex> {
  indexPromise ??= fetch('/api/tools').then((r) => {
    if (!r.ok) throw new Error(`Could not load tools (HTTP ${r.status})`);
    return r.json();
  }).catch((error) => { indexPromise = null; throw error; });
  return indexPromise;
}

export async function loadExample(tool: string): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/tools/${tool}/example`, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Could not load a live example (HTTP ${r.status})`);
  return body.arguments ?? {};
}

export type RunResult = {
  status: number; latencyMs: number; body: unknown; headers: Record<string, string>;
  payment?: { amount: string; asset: string; network: string; payTo: string } | null;
  freeCallsRemaining: number | null;
};

const decodePaymentRequired = (header: string | null) => {
  if (!header) return null;
  try {
    const parsed = JSON.parse(atob(header));
    const offer = parsed.accepts?.[0];
    return offer ? { amount: String(offer.amount), asset: String(offer.asset), network: String(offer.network), payTo: String(offer.payTo) } : null;
  } catch { return null; }
};

export async function runTool(tool: string, args: Record<string, unknown>, transport: 'http' | 'mcp'): Promise<RunResult> {
  const started = performance.now();
  if (transport === 'http') {
    const r = await fetch(`/api/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* plain text body */ }
    const remaining = r.headers.get('x-free-calls-remaining');
    return {
      status: r.status, latencyMs: Math.round(performance.now() - started), body, headers: Object.fromEntries(r.headers.entries()),
      payment: decodePaymentRequired(r.headers.get('payment-required')), freeCallsRemaining: remaining === null ? null : Number(remaining),
    };
  }
  const r = await fetch('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const rpc = await r.json().catch(() => null);
  const result = rpc?.result;
  let body: unknown = result?.structuredContent ?? result ?? rpc;
  if (!result?.structuredContent && result?.content?.[0]?.text) {
    try { body = JSON.parse(result.content[0].text); } catch { body = result.content[0].text; }
  }
  const paymentRequired = result?.isError && (body as any)?.x402Version ? (body as any).accepts?.[0] : null;
  return {
    status: result?.isError ? (paymentRequired ? 402 : 400) : r.status, latencyMs: Math.round(performance.now() - started), body,
    headers: Object.fromEntries(r.headers.entries()),
    payment: paymentRequired ? { amount: String(paymentRequired.amount), asset: String(paymentRequired.asset), network: String(paymentRequired.network), payTo: String(paymentRequired.payTo) } : null,
    freeCallsRemaining: typeof result?._meta?.freeCallsRemaining === 'number' ? result._meta.freeCallsRemaining : null,
  };
}

// The same request as a cURL command (HTTP) or a JSON-RPC body (MCP), for copying.
export function snippetFor(origin: string, tool: string, args: Record<string, unknown>, transport: 'http' | 'mcp'): string {
  return transport === 'http'
    ? `curl -X POST '${origin}/api/tools/${tool}' \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(args)}'`
    : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }, null, 2);
}

export async function loadFreeCallsUsed(): Promise<Record<string, number>> {
  const r = await fetch('/api/trial/status', { cache: 'no-store' });
  if (!r.ok) return {};
  return (await r.json()).freeCallsUsedByTool ?? {};
}

export const CATEGORY_LABELS: Record<ToolDoc['category'], string> = {
  transactions: 'Transactions', tokens: 'Tokens', wallets: 'Wallets', network: 'Network', reference: 'Reference',
};
