// Owner dashboard numbers against a real Postgres (PGlite, in memory): revenue per tool, who called it, and
// visitors with bots and the owner's own traffic left out.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pool, ensureSchema, noteOwnerNetwork, recordPageView, recordPayment, recordServiceUsage, clearOldToolIo } from "../server/db";
import { hashIp } from "../server/meter";
import { ownerOverview } from "../server/owner";

const db = new PGlite();
const OWNER_IP = "198.51.100.1", AGENT_IP = "203.0.113.20", BROWSER_IP = "203.0.113.30";
const MY_WALLET = "HGKYVGfQGvWdd9Y7uEm7NyHHPjmf5KMFAkfeYMvk5nVV", THEIR_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

before(async () => {
  (pool as any).query = async (sql: string, params?: unknown[]) => {
    const r = await db.query(sql, params as any[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  await ensureSchema();
  process.env.OWNER_WALLETS = MY_WALLET;

  const run = (endpoint: string, ip: string, client: string, extra: Partial<Parameters<typeof recordServiceUsage>[0]> = {}) =>
    recordServiceUsage({ endpoint, method: "POST", status: 200, callerHash: hashIp(ip), client, ...extra });

  // A directory bot pinging MCP from two networks, and asking a paid tool for its price.
  for (const ip of ["192.0.2.1", "192.0.2.2"]) await run("/mcp", ip, "mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)");
  await run("/api/tools/token_safety", "192.0.2.3", "PayAI-Bazaar/1.0 (+https://docs.payai.network)", { status: 402, via: "x402" });
  // An agent: Claude Code over MCP. One free call, then one paid call.
  await run("/mcp", AGENT_IP, "node", { mcpClient: "claude-code 2.1.0" });
  await run("/mcp/tools/token_safety", AGENT_IP, "node", { via: "free_call" });
  await run("/mcp/tools/token_safety", AGENT_IP, "node", { via: "x402", paymentTx: "tx-agent" });
  await recordPayment({ txSignature: "tx-agent", tool: "token_safety", payer: THEIR_WALLET, amountBaseUnits: "20000", asset: "USDC", network: "eip155:8453" });
  // The owner: a test payment from their own wallet, and an owner-key call.
  await recordPayment({ txSignature: "tx-test", tool: "fee", payer: MY_WALLET, amountBaseUnits: "10000", asset: "USDC", network: "eip155:8453" });
  await run("/api/tools/fee", OWNER_IP, "curl/8.5.0", { via: "owner" });
  await noteOwnerNetwork(hashIp(OWNER_IP));
  // Someone trying the playground in a browser, and an unknown tool name from an old client.
  await run("/api/tools/find_token", BROWSER_IP, BROWSER_UA, { via: "free_call", input: { query: "BONK" }, output: { found: true, symbol: "BONK" } });
  await run("/api/tools/get_price", BROWSER_IP, "SentinelOracle/0.1 (+https://glimind.com)", { status: 404 });

  // Visits: one real visitor on two pages, a crawler, and the owner.
  await recordPageView({ path: "/", referrerHost: "x.com", callerHash: hashIp(BROWSER_IP), client: BROWSER_UA });
  await recordPageView({ path: "/docs/tools/token_safety", referrerHost: null, callerHash: hashIp(BROWSER_IP), client: BROWSER_UA });
  await recordPageView({ path: "/", referrerHost: null, callerHash: hashIp("192.0.2.9"), client: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
  await recordPageView({ path: "/owner", referrerHost: null, callerHash: hashIp(OWNER_IP), client: BROWSER_UA });
});

test("revenue per tool, with the owner's own test payments kept apart", async () => {
  const o = await ownerOverview({ days: 7 });
  assert.equal(o.revenue.allTimeUsdc, 0.03);
  assert.equal(o.revenue.fromOthersUsdc, 0.02);
  assert.equal(o.revenue.payments, 2);
  const verdict = o.tools.find((t) => t.tool === "token_safety")!;
  assert.equal(verdict.revenueUsdc, 0.02);
  assert.equal(verdict.revenueOthersUsdc, 0.02);
  assert.equal(o.tools.find((t) => t.tool === "fee")!.revenueOthersUsdc, 0);
  assert.deepEqual(o.payers.map((p) => [p.payer, p.mine]), [[THEIR_WALLET, false], [MY_WALLET, true]]);
  // The paid MCP call is linked to the app that made it.
  assert.equal(o.recentPayments.find((p) => p.txSignature === "tx-agent")!.caller!.name, "Claude Code");
});

test("each tool's runs are split by who made them", async () => {
  const o = await ownerOverview({ days: 7 });
  const verdict = o.tools.find((t) => t.tool === "token_safety")!;
  assert.equal(verdict.runs, 3);
  assert.equal(verdict.byKind.bot, 1);
  assert.equal(verdict.byKind.ai_app, 2);
  assert.equal(verdict.paymentAsked, 1);
  assert.equal(verdict.freeCalls, 1);
  assert.equal(verdict.mcp, 2);
  assert.equal(o.tools.find((t) => t.tool === "fee")!.byKind.you, 1);
  assert.equal(o.tools.find((t) => t.tool === "find_token")!.byKind.browser, 1);
  // Unknown names are reported, and every registered tool is listed even with no runs.
  assert.equal(o.tools.find((t) => t.tool === "get_price")!.known, false);
  assert.ok(o.tools.some((t) => t.tool === "balance" && t.runs === 0));
});

test("callers: one row per bot across networks, apps named by their MCP client", async () => {
  const o = await ownerOverview({ days: 7 });
  const beat = o.callers.find((c) => c.name === "mcpbeat")!;
  assert.equal(beat.kind, "bot");
  assert.equal(beat.pings, 2);
  const agent = o.callers.find((c) => c.name === "Claude Code")!;
  assert.equal(agent.runs, 2);
  assert.equal(agent.paidCalls, 1);
  assert.equal(agent.paidUsdc, 0.02);
  assert.equal(o.callers.find((c) => c.name === "curl")!.kind, "you");
  assert.equal(o.kinds.bot.callers, 3);
});

test("visitors leave out bots and the owner", async () => {
  const v = (await ownerOverview({ days: 7 })).visitors;
  assert.equal(v.visitors, 1);
  assert.equal(v.views, 2);
  assert.equal(v.botViews, 1);
  assert.equal(v.ownViews, 1);
  assert.equal(v.liveNow, 1);
  assert.equal(v.series.length, 7);
  assert.equal(v.series.at(-1)!.views, 2);
  assert.deepEqual(v.referrers.map((r) => r.host).sort(), ["Direct or unknown", "x.com"]);
  assert.deepEqual(v.devices, [{ name: "Chrome on Android", visitors: 1 }]);
  assert.equal((await ownerOverview({ days: 1 })).visitors.series.length, 24);
});

test("tool inputs and results are kept, capped, and cleared after 30 days", async () => {
  const o = await ownerOverview({ days: 7 });
  const run = o.recentRuns.find((r) => r.tool === "find_token")!;
  assert.deepEqual(run.input, { query: "BONK" });
  assert.deepEqual(run.output, { found: true, symbol: "BONK" });
  assert.equal(o.recentRuns.find((r) => r.tool === "fee")!.input, null);

  await recordServiceUsage({ endpoint: "/api/tools/explain_tx", method: "POST", status: 200, callerHash: null, client: "curl/8.5.0",
    input: { tx: "x".repeat(40_000) }, output: { note: "nul\u0000here" } });
  const big = (await pool.query(`SELECT input, output FROM service_usage WHERE endpoint = '/api/tools/explain_tx'`)).rows[0];
  assert.equal(big.input.truncated, true);
  assert.deepEqual(big.output, { note: "nulhere" });

  await pool.query(`UPDATE service_usage SET created_at = NOW() - INTERVAL '31 days' WHERE endpoint = '/api/tools/explain_tx'`);
  await clearOldToolIo();
  const cleared = (await pool.query(`SELECT input, output FROM service_usage WHERE endpoint = '/api/tools/explain_tx'`)).rows[0];
  assert.deepEqual([cleared.input, cleared.output], [null, null]);
  assert.ok((await pool.query(`SELECT 1 FROM service_usage WHERE endpoint = '/api/tools/find_token' AND input IS NOT NULL`)).rows.length);
});
