// Owner dashboard data: revenue per tool, who calls each tool (directory bots, AI apps, scripts, people) and site
// visitors. Served only with the owner key, by GET /api/owner/overview in index.ts.
import { pool, TOOL_RUN_SQL } from "./db";
import { classifyClient, isMobile, KIND_LABELS, type CallerKind } from "./callers";
import { TOOLS, TOOLS_BY_NAME } from "./tools";
import { priceOf } from "./pricing";

export type Kind = CallerKind | "you";
const KINDS: Kind[] = ["you", "bot", "ai_app", "script", "browser", "other", "unknown"];
const emptyKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
const usdc = (v: unknown) => Number(v ?? 0) / 1e6;
const shortId = (hash: string | null) => (hash ? hash.slice(0, 6) : null);
const iso = (v: unknown) => new Date(v as string).toISOString();
const ms = (v: unknown) => new Date(v as string).getTime();

// "/api/tools/token_safety" or "/mcp/tools/token%5Fsafety" → "token_safety"
function toolOf(endpoint: string): string {
  const raw = endpoint.replace(/^\/(api|mcp)\/tools\//, "");
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// The owner's own wallets (test payments), comma-separated in OWNER_WALLETS; by default the wallet the 14 test
// payments of October 2026 came from. Payments from a network the dashboard was opened from also count as the owner's.
const TEST_PAYER = "HGKYVGfQGvWdd9Y7uEm7NyHHPjmf5KMFAkfeYMvk5nVV";
export const ownerWallets = () => (process.env.OWNER_WALLETS ?? TEST_PAYER).split(",").map((w) => w.trim()).filter(Boolean).join(",");

const PAYMENTS_CTE = `
  WITH p AS (
    SELECT p.tx_signature, p.tool, p.payer, p.amount_base_units, p.created_at, u.caller_hash, u.client,
      (COALESCE(p.payer = ANY(string_to_array($1, ',')), FALSE)
        OR COALESCE(u.caller_hash IN (SELECT caller_hash FROM owner_networks), FALSE)) AS mine
    FROM x402_payments p
    LEFT JOIN LATERAL (SELECT s.caller_hash, s.client FROM service_usage s WHERE s.payment_tx = p.tx_signature LIMIT 1) u ON TRUE
  )`;

type Caller = {
  id: string; kind: Kind; clientKind: CallerKind; name: string; homepage: string | null;
  network: string | null; userAgent: string | null; mcpClient: string | null;
  runs: number; pings: number; reads: number; errors: number; paidCalls: number; paidUsdc: number;
  tools: Record<string, number>; firstSeen: number; lastSeen: number;
};

export async function ownerOverview(o: { days: number }) {
  const days = o.days;
  const [owners, runRows, trafficRows, payTools, payers, recentPays, viewRows] = await Promise.all([
    pool.query(`SELECT caller_hash FROM owner_networks`),
    pool.query(`
      SELECT s.id, s.endpoint, s.caller_hash, s.client, s.via, s.status, s.payment_tx, s.created_at, p.amount_base_units AS paid
      FROM service_usage s LEFT JOIN x402_payments p ON p.tx_signature = s.payment_tx
      WHERE ${TOOL_RUN_SQL} AND s.created_at >= NOW() - make_interval(days => $1::int)
      ORDER BY s.created_at DESC LIMIT 50000`, [days]),
    pool.query(`
      SELECT caller_hash, client, MAX(mcp_client) AS mcp_client,
        COUNT(*) FILTER (WHERE endpoint LIKE '/mcp%')::bigint AS pings,
        COUNT(*) FILTER (WHERE endpoint NOT LIKE '/mcp%')::bigint AS reads,
        COUNT(*) FILTER (WHERE status >= 400)::bigint AS errors,
        MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM service_usage WHERE NOT ${TOOL_RUN_SQL} AND created_at >= NOW() - make_interval(days => $1::int)
      GROUP BY caller_hash, client`, [days]),
    pool.query(`${PAYMENTS_CTE}
      SELECT tool, COUNT(*)::bigint AS payments, SUM(amount_base_units)::bigint AS total,
        COUNT(*) FILTER (WHERE created_at >= NOW() - make_interval(days => $2::int))::bigint AS payments_window,
        COALESCE(SUM(amount_base_units) FILTER (WHERE created_at >= NOW() - make_interval(days => $2::int)), 0)::bigint AS total_window,
        COALESCE(SUM(amount_base_units) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::bigint AS total_24h,
        COALESCE(SUM(amount_base_units) FILTER (WHERE NOT mine), 0)::bigint AS total_others,
        COALESCE(SUM(amount_base_units) FILTER (WHERE NOT mine AND created_at >= NOW() - make_interval(days => $2::int)), 0)::bigint AS total_others_window,
        COUNT(DISTINCT payer) FILTER (WHERE NOT mine)::bigint AS other_payers
      FROM p GROUP BY tool`, [ownerWallets(), days]),
    pool.query(`${PAYMENTS_CTE}
      SELECT payer, BOOL_OR(mine) AS mine, COUNT(*)::bigint AS payments, SUM(amount_base_units)::bigint AS total,
        MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(DISTINCT tool)::bigint AS tools
      FROM p GROUP BY payer ORDER BY SUM(amount_base_units) DESC LIMIT 50`, [ownerWallets()]),
    pool.query(`${PAYMENTS_CTE}
      SELECT tx_signature, tool, payer, amount_base_units, created_at, caller_hash, client, mine
      FROM p ORDER BY created_at DESC LIMIT 50`, [ownerWallets()]),
    pool.query(`
      SELECT path, referrer_host, caller_hash, client, created_at FROM page_views
      WHERE created_at >= NOW() - make_interval(days => $1::int) ORDER BY created_at DESC LIMIT 50000`, [days]),
  ]);

  const ownerNets = new Set<string>(owners.rows.map((r: any) => r.caller_hash));
  const mcpClientOf = new Map<string, string>();
  for (const r of trafficRows.rows) if (r.mcp_client) mcpClientOf.set(`${r.caller_hash}|${r.client}`, r.mcp_client);

  // Bots are grouped by name across networks (one directory probes from many IPs); everyone else by network and client.
  const callers = new Map<string, Caller>();
  const callerFor = (hash: string | null, client: string | null, firstAt: unknown, lastAt = firstAt): Caller => {
    const mcpClient = mcpClientOf.get(`${hash}|${client}`) ?? null;
    const info = classifyClient(client, mcpClient);
    const key = info.kind === "bot" ? `bot:${info.name}` : `net:${hash}|${info.name}`;
    let c = callers.get(key);
    if (!c) {
      c = {
        id: key, kind: info.kind, clientKind: info.kind, name: info.name, homepage: info.homepage,
        network: info.kind === "bot" ? null : shortId(hash), userAgent: client, mcpClient,
        runs: 0, pings: 0, reads: 0, errors: 0, paidCalls: 0, paidUsdc: 0, tools: {}, firstSeen: ms(firstAt), lastSeen: ms(lastAt),
      };
      callers.set(key, c);
    }
    if (info.kind !== "bot" && hash && ownerNets.has(hash)) c.kind = "you";
    c.firstSeen = Math.min(c.firstSeen, ms(firstAt));
    c.lastSeen = Math.max(c.lastSeen, ms(lastAt));
    return c;
  };

  for (const r of trafficRows.rows) {
    const c = callerFor(r.caller_hash, r.client, r.first_at, r.last_at);
    c.pings += Number(r.pings);
    c.reads += Number(r.reads);
    c.errors += Number(r.errors);
  }

  const runs = runRows.rows.map((r: any) => {
    const caller = callerFor(r.caller_hash, r.client, r.created_at);
    if (r.via === "owner" && caller.clientKind !== "bot") caller.kind = "you";
    const tool = toolOf(r.endpoint);
    caller.runs++;
    caller.tools[tool] = (caller.tools[tool] ?? 0) + 1;
    const failed = r.status >= 400 && r.status !== 402;
    if (failed) caller.errors++;
    if (r.payment_tx) { caller.paidCalls++; caller.paidUsdc += usdc(r.paid); }
    return { r, caller, tool, failed };
  });

  // Per tool: every registered tool, plus any unknown names callers tried (typos, names from before 2026-10).
  // Calls and payments made under a tool's pre-rename name count toward the tool's current name.
  const toolStats = new Map<string, any>();
  const statsFor = (name: string) => {
    const tool = TOOLS_BY_NAME.get(name)?.name ?? name;
    let t = toolStats.get(tool);
    if (!t) {
      const known = TOOLS_BY_NAME.has(tool);
      t = {
        tool, known, price: known ? priceOf(tool) : null, runs: 0, http: 0, mcp: 0, errors: 0,
        freeCalls: 0, ownerCalls: 0, paymentAsked: 0, byKind: emptyKinds(), callers: new Set<string>(), lastRunAt: 0,
        payments: 0, revenueUsdc: 0, paymentsWindow: 0, revenueWindowUsdc: 0, revenueOthersUsdc: 0, otherPayers: 0,
      };
      toolStats.set(tool, t);
    }
    return t;
  };
  for (const t of TOOLS) statsFor(t.name);
  for (const { r, caller, tool, failed } of runs) {
    const t = statsFor(tool);
    t.runs++;
    if (r.endpoint.startsWith("/mcp")) t.mcp++; else t.http++;
    if (failed) t.errors++;
    if (r.via === "free_call") t.freeCalls++;
    if (r.via === "owner") t.ownerCalls++;
    if (r.status === 402 || (r.via === "x402" && !r.payment_tx)) t.paymentAsked++;
    t.byKind[caller.kind]++;
    t.callers.add(caller.id);
    t.lastRunAt = Math.max(t.lastRunAt, ms(r.created_at));
  }
  const revenue = { allTimeUsdc: 0, windowUsdc: 0, last24hUsdc: 0, fromOthersUsdc: 0, fromOthersWindowUsdc: 0, payments: 0, paymentsWindow: 0 };
  for (const p of payTools.rows) {
    const t = statsFor(p.tool);
    t.payments += Number(p.payments); t.revenueUsdc += usdc(p.total);
    t.paymentsWindow += Number(p.payments_window); t.revenueWindowUsdc += usdc(p.total_window);
    t.revenueOthersUsdc += usdc(p.total_others); t.otherPayers += Number(p.other_payers);
    revenue.allTimeUsdc += usdc(p.total); revenue.windowUsdc += usdc(p.total_window); revenue.last24hUsdc += usdc(p.total_24h);
    revenue.fromOthersUsdc += usdc(p.total_others); revenue.fromOthersWindowUsdc += usdc(p.total_others_window);
    revenue.payments += Number(p.payments); revenue.paymentsWindow += Number(p.payments_window);
  }

  const kinds = Object.fromEntries(KINDS.map((k) => [k, { label: KIND_LABELS[k], callers: 0, runs: 0, requests: 0 }]));
  for (const c of callers.values()) {
    const k = kinds[c.kind];
    k.callers++; k.runs += c.runs; k.requests += c.runs + c.pings + c.reads;
  }

  const callerList = [...callers.values()]
    .sort((a, b) => b.runs - a.runs || (b.pings + b.reads) - (a.pings + a.reads))
    .slice(0, 150)
    .map((c) => ({
      ...c, firstSeen: new Date(c.firstSeen).toISOString(), lastSeen: new Date(c.lastSeen).toISOString(),
      tools: Object.entries(c.tools).sort((a, b) => b[1] - a[1]).map(([tool, n]) => ({ tool, runs: n })),
    }));

  // Inputs and outputs only for the runs shown, so the 50,000-row scan above stays small.
  const latest = runs.slice(0, 40);
  const ioRows = await pool.query(`SELECT id, input, output FROM service_usage WHERE id = ANY($1::bigint[])`, [latest.map(({ r }) => r.id)]);
  const ioById = new Map(ioRows.rows.map((row: any) => [String(row.id), row]));
  const recentRuns = latest.map(({ r, caller, tool, failed }) => ({
    at: iso(r.created_at), tool, transport: r.endpoint.startsWith("/mcp") ? "mcp" : "http", status: r.status,
    outcome: r.payment_tx ? "paid" : r.status === 402 || r.via === "x402" ? "payment_asked" : failed ? "error"
      : r.via === "free_call" ? "free_call" : r.via === "owner" ? "owner_key" : "ok",
    caller: { id: caller.id, kind: caller.kind, name: caller.name, network: caller.network },
    input: ioById.get(String(r.id))?.input ?? null, output: ioById.get(String(r.id))?.output ?? null,
  }));

  const payCaller = (hash: string | null, client: string | null) => {
    if (!hash && !client) return null;
    const info = classifyClient(client, mcpClientOf.get(`${hash}|${client}`) ?? null);
    const kind: Kind = info.kind !== "bot" && hash && ownerNets.has(hash) ? "you" : info.kind;
    return { id: info.kind === "bot" ? `bot:${info.name}` : `net:${hash}|${info.name}`, kind, name: info.name, network: info.kind === "bot" ? null : shortId(hash) };
  };

  return {
    generatedAt: new Date().toISOString(),
    days,
    kindLabels: KIND_LABELS,
    revenue: { ...revenue, payers: payers.rows.length, otherPayers: payers.rows.filter((p: any) => !p.mine).length },
    tools: [...toolStats.values()]
      .map((t) => ({ ...t, callers: t.callers.size, lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null }))
      .sort((a, b) => b.revenueUsdc - a.revenueUsdc || b.runs - a.runs || a.tool.localeCompare(b.tool)),
    kinds,
    callers: callerList,
    callerCount: callers.size,
    recentRuns,
    payers: payers.rows.map((p: any) => ({
      payer: p.payer, mine: Boolean(p.mine), payments: Number(p.payments), usdc: usdc(p.total),
      tools: Number(p.tools), firstAt: iso(p.first_at), lastAt: iso(p.last_at),
    })),
    recentPayments: recentPays.rows.map((p: any) => ({
      at: iso(p.created_at), tool: TOOLS_BY_NAME.get(p.tool)?.name ?? p.tool, amountUsdc: usdc(p.amount_base_units), payer: p.payer, mine: Boolean(p.mine),
      txSignature: p.tx_signature, caller: payCaller(p.caller_hash, p.client),
    })),
    visitors: visitorStats(viewRows.rows, ownerNets, days),
  };
}

// Real visitors: page views from browsers that ran the page's script, minus bots and the owner's own networks.
function visitorStats(rows: any[], ownerNets: Set<string>, days: number) {
  const now = Date.now();
  const hourly = days === 1;
  const bucketMs = hourly ? 3_600_000 : 86_400_000;
  const buckets = hourly ? 24 : days;
  const firstBucket = Math.floor(now / bucketMs) - (buckets - 1);
  const series = Array.from({ length: buckets }, (_, i) => ({ start: new Date((firstBucket + i) * bucketMs).toISOString(), views: 0, visitors: new Set<string>() }));

  let botViews = 0, ownViews = 0;
  const visitors = new Set<string>(), live5 = new Set<string>(), live30 = new Set<string>(), day = new Set<string>();
  let views = 0, views24h = 0;
  const pages = new Map<string, { views: number; visitors: Set<string> }>();
  const referrers = new Map<string, number>();
  const devices = new Map<string, Set<string>>();
  let mobile = 0, desktop = 0;
  const recent: any[] = [];
  for (const r of rows) {
    const info = classifyClient(r.client);
    if (info.kind !== "browser") { botViews++; continue; }
    if (r.caller_hash && ownerNets.has(r.caller_hash)) { ownViews++; continue; }
    const who = r.caller_hash ?? "unknown";
    const at = ms(r.created_at);
    views++; visitors.add(who);
    if (now - at <= 5 * 60_000) live5.add(who);
    if (now - at <= 30 * 60_000) live30.add(who);
    if (now - at <= 86_400_000) { day.add(who); views24h++; }
    const b = series[Math.floor(at / bucketMs) - firstBucket];
    if (b) { b.views++; b.visitors.add(who); }
    const page = pages.get(r.path) ?? { views: 0, visitors: new Set<string>() };
    page.views++; page.visitors.add(who); pages.set(r.path, page);
    const ref = r.referrer_host || "Direct or unknown";
    referrers.set(ref, (referrers.get(ref) ?? 0) + 1);
    if (!devices.has(info.name)) devices.set(info.name, new Set());
    const seen = devices.get(info.name)!;
    if (!seen.has(who)) { seen.add(who); if (isMobile(r.client)) mobile++; else desktop++; }
    if (recent.length < 40) recent.push({ at: iso(r.created_at), path: r.path, referrer: r.referrer_host, device: info.name, visitor: shortId(r.caller_hash) });
  }
  const top = <T,>(m: Map<string, T>, value: (v: T) => number, n = 12) => [...m.entries()].sort((a, b) => value(b[1]) - value(a[1])).slice(0, n);
  return {
    liveNow: live5.size, last30Minutes: live30.size, visitors24h: day.size, views24h,
    visitors: visitors.size, views, botViews, ownViews, mobile, desktop,
    bucket: hourly ? "hour" : "day",
    series: series.map((s) => ({ start: s.start, views: s.views, visitors: s.visitors.size })),
    pages: top(pages, (p) => p.views).map(([path, p]) => ({ path, views: p.views, visitors: p.visitors.size })),
    referrers: top(referrers, (n) => n).map(([host, n]) => ({ host, views: n })),
    devices: top(devices, (s) => s.size).map(([name, s]) => ({ name, visitors: s.size })),
    recent,
  };
}
