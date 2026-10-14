// Client for the owner dashboard (GET /api/owner/overview, owner key in x-api-key) and the site's page-view counter.

export type Kind = 'you' | 'bot' | 'ai_app' | 'script' | 'browser' | 'other' | 'unknown';

export type ToolStats = {
  tool: string; known: boolean; price: string | null;
  runs: number; http: number; mcp: number; errors: number; freeCalls: number; ownerCalls: number; paymentAsked: number;
  byKind: Record<Kind, number>; callers: number; lastRunAt: string | null;
  payments: number; revenueUsdc: number; paymentsWindow: number; revenueWindowUsdc: number; revenueOthersUsdc: number; otherPayers: number;
};

export type CallerRef = { id: string; kind: Kind; name: string; network: string | null };

export type CallerStats = CallerRef & {
  clientKind: Kind; homepage: string | null; userAgent: string | null; mcpClient: string | null;
  runs: number; pings: number; reads: number; errors: number; paidCalls: number; paidUsdc: number;
  tools: { tool: string; runs: number }[]; firstSeen: string; lastSeen: string;
};

export type Visitors = {
  liveNow: number; last30Minutes: number; visitors24h: number; views24h: number;
  visitors: number; views: number; botViews: number; ownViews: number; mobile: number; desktop: number;
  bucket: 'hour' | 'day';
  series: { start: string; views: number; visitors: number }[];
  pages: { path: string; views: number; visitors: number }[];
  referrers: { host: string; views: number }[];
  devices: { name: string; visitors: number }[];
  recent: { at: string; path: string; referrer: string | null; device: string; visitor: string | null }[];
};

export type OwnerOverview = {
  generatedAt: string; days: number; kindLabels: Record<Kind, string>;
  revenue: {
    allTimeUsdc: number; windowUsdc: number; last24hUsdc: number; fromOthersUsdc: number; fromOthersWindowUsdc: number;
    payments: number; paymentsWindow: number; payers: number; otherPayers: number;
  };
  tools: ToolStats[];
  kinds: Record<Kind, { label: string; callers: number; runs: number; requests: number }>;
  callers: CallerStats[]; callerCount: number;
  recentRuns: { at: string; tool: string; transport: 'http' | 'mcp'; status: number; outcome: string; caller: CallerRef; input: unknown; output: unknown }[];
  payers: { payer: string; mine: boolean; payments: number; usdc: number; tools: number; firstAt: string; lastAt: string }[];
  recentPayments: { at: string; tool: string; amountUsdc: number; payer: string; mine: boolean; txSignature: string; caller: CallerRef | null }[];
  visitors: Visitors;
};

export class OwnerKeyError extends Error {}

export async function loadOwnerOverview(key: string, days: number): Promise<OwnerOverview> {
  const r = await fetch(`/api/owner/overview?days=${days}`, { headers: { 'x-api-key': key }, cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) throw new OwnerKeyError(body.error || 'That key was not accepted.');
  if (!r.ok) throw new Error(body.error || `The dashboard could not load (HTTP ${r.status}).`);
  return body;
}


// The owner key is kept for this tab only, unless the owner asks to stay signed in on this device.
const KEY_NAME = 'base-pulse-owner-key';
export const ownerKeyStore = {
  get(): string {
    try { return sessionStorage.getItem(KEY_NAME) || localStorage.getItem(KEY_NAME) || ''; } catch { return ''; }
  },
  set(key: string, remember: boolean) {
    try { sessionStorage.setItem(KEY_NAME, key); if (remember) localStorage.setItem(KEY_NAME, key); } catch { /* storage blocked */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY_NAME); localStorage.removeItem(KEY_NAME); } catch { /* storage blocked */ }
  },
};

// One page view per load and per in-site navigation: the path, plus the referring site on the first view only.
let firstView = true;
export function recordPageView(path: string) {
  const body = JSON.stringify({ path, referrer: firstView ? document.referrer : '' });
  firstView = false;
  try {
    if (navigator.sendBeacon?.('/api/analytics/view', new Blob([body], { type: 'application/json' }))) return;
  } catch { /* fall through to fetch */ }
  void fetch('/api/analytics/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
