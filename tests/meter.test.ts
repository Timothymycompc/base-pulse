// Free-call metering against a real Postgres (PGlite, in memory): the daily allowance, refunds and path tricks.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { pool, ensureSchema } from "../server/db";
import { admitCall, getFreeCallStatus, hashIp, paidRouteMiddleware, refundFreeCall } from "../server/meter";
import { FREE_CALLS_PER_TOOL, TOOL_PRICES } from "../server/pricing";

const db = new PGlite();
before(async () => {
  // Route the server's queries to PGlite, then create the real schema.
  (pool as any).query = async (sql: string, params?: unknown[]) => {
    const r = await db.query(sql, params as any[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  await ensureSchema();
});

const ip = "203.0.113.7";
const use = (tool: string, callerIp = ip) => admitCall({ tool, ip: callerIp, hasPayment: false });

test("a tool priced null (free, no daily limit) never touches the allowance", async () => {
  // Every real tool is priced today, so check the free path with a stand-in.
  TOOL_PRICES.stand_in_free_tool = null;
  try {
    assert.deepEqual(await use("stand_in_free_tool"), { via: "free_tool" });
  } finally {
    delete TOOL_PRICES.stand_in_free_tool;
  }
});

test("each paid tool gives the daily allowance, then asks for payment", async () => {
  for (let i = 1; i <= FREE_CALLS_PER_TOOL; i++) {
    assert.deepEqual(await use("token_safety"), { via: "free_call", remaining: FREE_CALLS_PER_TOOL - i });
  }
  assert.deepEqual(await use("token_safety"), { via: "x402" });
  // Another tool and another caller have their own allowance.
  assert.equal((await use("check_tx")).via, "free_call");
  assert.equal((await use("token_safety", "198.51.100.9")).via, "free_call");
});

test("a failed call is refunded", async () => {
  await refundFreeCall(ip, "token_safety");
  assert.equal((await use("token_safety")).via, "free_call");
  assert.equal((await use("token_safety")).via, "x402");
});

test("the allowance starts again the next day", async () => {
  await db.query(`UPDATE trial_tool_usage SET last_call_at = NOW() - INTERVAL '1 day' WHERE ip_hash = $1`, [hashIp(ip)]);
  assert.deepEqual(await getFreeCallStatus(ip), { token_safety: 0, check_tx: 0 });
  assert.deepEqual(await use("token_safety"), { via: "free_call", remaining: FREE_CALLS_PER_TOOL - 1 });
});

test("a caller that attaches a payment pays and keeps its free calls", async () => {
  assert.deepEqual(await admitCall({ tool: "fee", ip, hasPayment: true }), { via: "x402" });
  assert.equal((await getFreeCallStatus(ip)).fee, undefined);
});

test("percent-encoded tool names share the real tool's allowance", async () => {
  const app = express();
  app.set("trust proxy", 1);
  const payWall = (_req: any, res: any) => res.status(402).json({ paymentRequired: true });
  app.post("/api/tools/:name", paidRouteMiddleware(payWall as any), (_req, res) => res.json({ ran: true }));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const call = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "x-forwarded-for": "192.0.2.44" } })).status;
  try {
    for (let i = 0; i < FREE_CALLS_PER_TOOL; i++) assert.equal(await call("/api/tools/balance"), 200);
    assert.equal(await call("/api/tools/b%61lance"), 402);
  } finally {
    server.close();
  }
});

test("Coinbase's Bazaar checker and indexer are asked to pay, not given a free call", async () => {
  const app = express();
  app.set("trust proxy", true);
  const payWall = (_req: any, res: any) => res.status(402).json({ x402Version: 2 });
  app.post("/api/tools/:name", paidRouteMiddleware(payWall as any), (_req, res) => res.json({ ran: true }));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const call = async (ua: string) => (await fetch(`http://127.0.0.1:${port}/api/tools/fee`, { method: "POST", headers: { "x-forwarded-for": "192.0.2.55", "user-agent": ua } })).status;
  try {
    assert.equal(await call("Go-http-client/1.1"), 402);
    assert.equal(await call("Go-http-client/2.0"), 402);
    assert.equal(await call("CoinbaseBazaarDiscovery/1.0 (+/x402)"), 402);
    assert.equal(await call("my-agent/1.0 Go-http-client/1.1"), 200, "a Go app that names itself still gets free calls");
  } finally {
    server.close();
  }
});

test("a free pass lets its caller run paid tools free until it ends, without using daily free calls", async () => {
  const { freePassFor, FREE_PASSES } = await import("../server/meter");
  const until = Date.now() + 60_000;
  FREE_PASSES.push({ userAgent: /^test-agent\//i, until: new Date(until).toISOString(), why: "test" });
  try {
    assert.ok(freePassFor("test-agent/1", until - 1000));
    assert.equal(freePassFor("test-agent/1", until + 1000), null, "it ends on time");
    assert.equal(freePassFor("someone-else/1", until - 1000), null);
    for (let i = 0; i < 30; i++) assert.deepEqual(await admitCall({ tool: "balance", ip: "192.0.2.77", hasPayment: false, userAgent: "test-agent/1" }), { via: "free_pass" });
    assert.equal((await getFreeCallStatus("192.0.2.77")).balance, undefined, "daily free calls untouched");
  } finally {
    FREE_PASSES.pop();
  }
});
