import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { pool, ensureSchema, noteOwnerNetwork, recordPageView, recordServiceUsage, clearOldToolIo, TOOL_RUN_SQL } from "./db";
import { keyFromReq } from "./auth";
import { loadSecrets } from "./secrets";
import { admitCall, getFreeCallStatus, hashIp, isOwnerKey, paidRouteMiddleware, refundFreeCall } from "./meter";
import { FREE_CALLS_PER_TOOL, FREE_CALLS_RESET, FREE_CALLS_TEXT, priceOf, TOOL_PRICES } from "./pricing";
import { createX402, X402_NETWORK } from "./x402";
import { ownerOverview } from "./owner";
import { clientFor, simulationClients } from "./tools/chain";
import { mcpDescription, priceText, toolDoc, ToolError, TOOLS, TOOLS_BY_NAME, type ToolContext, type ToolDef } from "./tools";

// Where USDC payments go, on Base. Set before the first deploy; the server refuses to start without it.
const GATEWAY_WALLET = "0x717bFe8505FA89C038b9832dCc187871003d4B93";
const PUBLIC_URL = "https://base-pulse-1021990235790.us-central1.run.app";

async function startServer() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(GATEWAY_WALLET)) throw new Error("Set GATEWAY_WALLET in server/index.ts to the Base address that receives payments.");
  // This project's own database; the owner key, caller hash key and Coinbase key are shared with Solana Pulse.
  await loadSecrets(["DATABASE_URL=BASE_PULSE_DATABASE_URL", "OWNER_API_KEY", "BASE_RPC_URL", "CALLER_HASH_SECRET", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]);
  await ensureSchema();
  void clearOldToolIo();
  setInterval(() => void clearOldToolIo(), 6 * 60 * 60 * 1000).unref();

  const app = express();
  app.set("trust proxy", 1);
  const PORT = Number(process.env.PORT) || 3000;

  // Cloud Run terminates TLS before requests reach Express; send the policy to HTTPS clients.
  app.use((_req, res, next) => { res.setHeader("Strict-Transport-Security", "max-age=31536000"); next(); });
  app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], exposedHeaders: ["payment-required", "payment-response", "x-free-calls-remaining"] }));
  app.use(express.json({ limit: "256kb" }));

  // The transaction a paid HTTP call settled in, from the PAYMENT-RESPONSE header x402 adds to the response.
  const settledTx = (header: unknown): string | null => {
    if (typeof header !== "string" || !header) return null;
    try { const r = decodePaymentResponseHeader(header); return r.success && r.transaction ? r.transaction : null; }
    catch { return null; }
  };

  // Record route-level usage without query strings or raw IPs: a keyed hash of the caller network and the client name,
  // plus the MCP client's own name on initialize and, for tool calls, how the call was admitted and paid, the tool's
  // arguments (never the MCP _meta, which carries the payment) and its result (res.locals.output, set where it runs).
  const trackServiceUsage = (req: any, res: any, next: any) => {
    const pathOnly = String(req.originalUrl || req.url).split("?")[0];
    if (pathOnly.startsWith("/api/analytics/") || pathOnly.startsWith("/api/owner/")) return next();
    const callerHash = req.ip ? hashIp(req.ip) : null;
    const client = String(req.headers["user-agent"] || "").slice(0, 120) || null;
    const info = req.body?.method === "initialize" ? req.body?.params?.clientInfo : null;
    const mcpClient = typeof info?.name === "string" ? `${info.name} ${typeof info.version === "string" ? info.version : ""}`.trim().slice(0, 80) : null;
    res.once("finish", () => {
      const toolName = req.body?.method === "tools/call" ? req.body?.params?.name : null;
      const isMcpMessage = pathOnly === "/mcp" || pathOnly === "/mcp/messages";
      const endpoint = isMcpMessage && typeof toolName === "string" ? `/mcp/tools/${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : pathOnly;
      const paymentTx = res.locals.paymentTx ?? settledTx(res.getHeader("payment-response"));
      const isToolCall = req.method === "POST" && (pathOnly.startsWith("/api/tools/") || endpoint.startsWith("/mcp/tools/"));
      const input = !isToolCall ? null : endpoint.startsWith("/mcp/tools/") ? req.body?.params?.arguments : req.body;
      void recordServiceUsage({ endpoint, method: req.method, status: res.statusCode, callerHash, client, mcpClient, via: res.locals.via ?? null, paymentTx,
        input, output: isToolCall ? res.locals.output : null });
    });
    next();
  };
  app.use("/api", trackServiceUsage);
  app.use("/mcp", trackServiceUsage);

  const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Rate limit reached (120 requests per minute per IP). Retry shortly." } });
  app.use("/api/", limiter);
  app.use("/mcp", limiter);

  const noCache = (_req: any, res: any, next: any) => { res.setHeader("Cache-Control", "no-store"); next(); };

  const ctx: ToolContext = {
    client: clientFor,
    simulators: simulationClients,
    fetchJson: async (url, timeoutMs = 8000) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return res.json();
    },
    postJson: async (url, body, timeoutMs = 8000) => {
      const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return res.json();
    },
  };

  // Validate inputs against the tool's schema, run it, and map failures to a status and a fix.
  type ToolOutcome = { status: number; body: Record<string, unknown> };
  async function runTool(tool: ToolDef, rawArgs: unknown): Promise<ToolOutcome> {
    const parsed = z.object(tool.inputs).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { status: 400, body: { error: "Invalid input.", issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })), fix: `See GET /api/tools/${tool.name} for every input and how to get it.` } };
    }
    try {
      return { status: 200, body: await tool.run(parsed.data, ctx) };
    } catch (error: any) {
      if (error instanceof ToolError) return { status: error.status, body: { error: error.message, fix: error.fix ?? null } };
      const message = String(error?.message ?? error);
      const rateLimited = /429|Too many requests/i.test(message);
      console.error(`tool ${tool.name} failed:`, message);
      return { status: rateLimited ? 503 : 502, body: { error: rateLimited ? "The Base RPC is rate-limiting requests." : "The Base RPC returned an error.", detail: message.slice(0, 300), fix: "Retry in a few seconds. Failed calls are never charged." } };
    }
  }

  // Paid tools settle in USDC via x402 to GATEWAY_WALLET; free tools, the daily free calls and the owner key skip payment.
  const x402 = createX402(GATEWAY_WALLET);
  const paidRoute = paidRouteMiddleware(x402.httpMiddleware);

  // ---------- Tool API ----------
  app.get("/api/tools", noCache, (_req, res) => {
    res.json({
      freeCallsPerTool: FREE_CALLS_PER_TOOL, freeCallsReset: FREE_CALLS_RESET,
      payments: { protocol: "x402", x402Version: 2, scheme: "exact", network: X402_NETWORK, asset: "USDC", payTo: GATEWAY_WALLET },
      tools: TOOLS.map(toolDoc),
    });
  });

  const requireTool = (req: any, res: any, next: any) => {
    const tool = TOOLS_BY_NAME.get(req.params.name);
    if (!tool) return res.status(404).json({ error: `Unknown tool "${req.params.name}".`, fix: "GET /api/tools lists every tool." });
    req.tool = tool;
    next();
  };

  app.get("/api/tools/:name", noCache, requireTool, (req: any, res) => res.json(toolDoc(req.tool)));

  // Live example inputs built from current mainnet data, so a request runs as-is.
  const exampleCache = new Map<string, { at: number; value: unknown }>();
  app.get("/api/tools/:name/example", noCache, requireTool, async (req: any, res) => {
    const tool: ToolDef = req.tool;
    const hit = exampleCache.get(tool.name);
    if (hit && Date.now() - hit.at < 15_000) return res.json({ tool: tool.name, arguments: hit.value, live: true });
    try {
      const value = await tool.example(ctx);
      exampleCache.set(tool.name, { at: Date.now(), value });
      res.json({ tool: tool.name, arguments: value, live: true });
    } catch (error: any) {
      res.status(503).json({ error: "Could not build a live example right now.", detail: String(error?.message ?? error).slice(0, 200) });
    }
  });

  app.post("/api/tools/:name", noCache, requireTool, paidRoute, async (req: any, res) => {
    const outcome = await runTool(req.tool, req.body);
    res.locals.output = outcome.body;
    res.status(outcome.status).json(outcome.body);
  });

  app.get("/api/trial/status", noCache, async (req: any, res) => {
    try {
      const used = await getFreeCallStatus(req.ip || "unknown");
      res.json({ scope: "caller_ip", freeCallsPerTool: FREE_CALLS_PER_TOOL, freeCallsReset: FREE_CALLS_RESET, freeCallsUsedByTool: used, prices: TOOL_PRICES, network: X402_NETWORK, asset: "USDC" });
    } catch (error) {
      console.error("free call status lookup failed:", error);
      res.status(503).json({ error: "Free call status is temporarily unavailable." });
    }
  });

  app.get("/api/analytics/usage", noCache, async (req, res) => {
    const you = req.ip ? hashIp(req.ip) : "";
    try {
      const [totals, tools] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE ${TOOL_RUN_SQL} AND created_at >= NOW() - INTERVAL '24 hours')::bigint AS tool_runs_24h,
            COUNT(DISTINCT caller_hash) FILTER (WHERE ${TOOL_RUN_SQL} AND created_at >= NOW() - INTERVAL '24 hours')::bigint AS callers_24h,
            COUNT(DISTINCT caller_hash) FILTER (WHERE ${TOOL_RUN_SQL} AND caller_hash <> $1 AND created_at >= NOW() - INTERVAL '24 hours')::bigint AS other_callers_24h,
            COUNT(*) FILTER (WHERE ${TOOL_RUN_SQL} AND caller_hash <> $1)::bigint AS other_tool_runs_7d,
            COUNT(DISTINCT caller_hash) FILTER (WHERE ${TOOL_RUN_SQL} AND caller_hash <> $1)::bigint AS other_callers_7d,
            COUNT(*) FILTER (WHERE endpoint LIKE '/mcp%' AND NOT ${TOOL_RUN_SQL} AND created_at >= NOW() - INTERVAL '24 hours')::bigint AS pings_24h,
            MAX(created_at) FILTER (WHERE ${TOOL_RUN_SQL}) AS last_tool_run_at
          FROM service_usage WHERE created_at >= NOW() - INTERVAL '7 days'`, [you]),
        pool.query(`
          SELECT endpoint, COUNT(*)::bigint AS runs, COUNT(DISTINCT caller_hash) FILTER (WHERE caller_hash <> $1)::bigint AS other_callers, MAX(created_at) AS last_run_at
          FROM service_usage WHERE ${TOOL_RUN_SQL} AND created_at >= NOW() - INTERVAL '7 days'
          GROUP BY endpoint ORDER BY COUNT(*) DESC, endpoint ASC LIMIT 12`, [you]),
      ]);
      const row = totals.rows[0] || {};
      res.json({
        toolRuns24h: Number(row.tool_runs_24h || 0), callers24h: Number(row.callers_24h || 0), otherCallers24h: Number(row.other_callers_24h || 0),
        otherToolRuns7d: Number(row.other_tool_runs_7d || 0), otherCallers7d: Number(row.other_callers_7d || 0), pings24h: Number(row.pings_24h || 0),
        lastToolRunAt: row.last_tool_run_at || null,
        tools: tools.rows.map((t: any) => ({ endpoint: t.endpoint, runs: Number(t.runs), otherCallers: Number(t.other_callers), lastRunAt: t.last_run_at })),
        note: "A tool run is a tool call over HTTP or MCP. Callers are counted by network, so \"besides you\" means a different network from the one viewing this page. Pings are MCP connections and tool listings, mostly directory uptime checks.",
      });
    } catch (error: any) {
      console.error("usage analytics query failed:", error);
      res.status(503).json({ error: "Live usage counts are temporarily unavailable." });
    }
  });

  // Owner-only revenue view: send the OWNER_API_KEY as x-api-key.
  app.get("/api/owner/payments", noCache, async (req, res) => {
    if (!isOwnerKey(keyFromReq(req))) return res.status(401).json({ error: "Owner key required.", fix: "Send your OWNER_API_KEY in the x-api-key header." });
    try {
      const [totals, byTool, recent] = await Promise.all([
        pool.query(`SELECT COUNT(*)::bigint AS payments, COALESCE(SUM(amount_base_units), 0)::bigint AS total,
          COALESCE(SUM(amount_base_units) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0)::bigint AS total_24h,
          COALESCE(SUM(amount_base_units) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::bigint AS total_7d,
          COUNT(DISTINCT payer)::bigint AS payers FROM x402_payments`),
        pool.query(`SELECT tool, COUNT(*)::bigint AS payments, SUM(amount_base_units)::bigint AS total FROM x402_payments GROUP BY tool ORDER BY total DESC`),
        pool.query(`SELECT tx_signature, tool, payer, amount_base_units, created_at FROM x402_payments ORDER BY created_at DESC LIMIT 25`),
      ]);
      const usdc = (v: unknown) => Number(v ?? 0) / 1e6;
      const t = totals.rows[0];
      res.json({
        asset: "USDC", payments: Number(t.payments), distinctPayers: Number(t.payers),
        revenueUsdc: { allTime: usdc(t.total), last7Days: usdc(t.total_7d), last24Hours: usdc(t.total_24h) },
        byTool: byTool.rows.map((r: any) => ({ tool: r.tool, payments: Number(r.payments), revenueUsdc: usdc(r.total) })),
        recent: recent.rows.map((r: any) => ({ txSignature: r.tx_signature, tool: r.tool, payer: r.payer, amountUsdc: usdc(r.amount_base_units), at: r.created_at })),
      });
    } catch (error) {
      console.error("payments query failed:", error);
      res.status(503).json({ error: "Payments are temporarily unavailable." });
    }
  });

  // Site visits, sent by the page on each load and navigation. Path and referring site only.
  // At most VIEWS_PER_HOUR per network per hour (per server instance), so the endpoint cannot be used to fill the table.
  const VIEWS_PER_HOUR = 300;
  const viewCounts = new Map<string, { n: number; resetAt: number }>();
  app.post("/api/analytics/view", (req, res) => {
    const pagePath = typeof req.body?.path === "string" ? req.body.path.split(/[?#]/)[0].slice(0, 200) : "";
    if (!pagePath.startsWith("/")) return res.status(400).json({ error: "path is required." });
    const callerHash = req.ip ? hashIp(req.ip) : null;
    const now = Date.now();
    if (viewCounts.size > 50_000) for (const [k, v] of viewCounts) if (v.resetAt <= now) viewCounts.delete(k);
    const count = viewCounts.get(callerHash ?? "") ?? { n: 0, resetAt: now + 3_600_000 };
    if (count.resetAt <= now) { count.n = 0; count.resetAt = now + 3_600_000; }
    count.n++;
    viewCounts.set(callerHash ?? "", count);
    if (count.n > VIEWS_PER_HOUR) return res.status(204).end();
    let referrerHost: string | null = null;
    try {
      const host = new URL(String(req.body?.referrer || "")).hostname.slice(0, 120);
      if (host && host !== req.hostname) referrerHost = host;
    } catch { /* no referrer, or not a URL */ }
    const client = String(req.headers["user-agent"] || "").slice(0, 200) || null;
    void recordPageView({ path: pagePath, referrerHost, callerHash, client });
    res.status(204).end();
  });

  // Owner dashboard (/owner on the site): revenue per tool, who calls each tool, and site visitors.
  app.get("/api/owner/overview", noCache, async (req, res) => {
    if (!isOwnerKey(keyFromReq(req))) return res.status(401).json({ error: "Owner key required.", fix: "Send your OWNER_API_KEY in the x-api-key header." });
    const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    try {
      // Calls and visits from a network the dashboard is opened from are counted as the owner's own.
      if (req.ip) await noteOwnerNetwork(hashIp(req.ip));
      res.json(await ownerOverview({ days }));
    } catch (error) {
      console.error("owner overview failed:", error);
      res.status(503).json({ error: "The dashboard data is temporarily unavailable." });
    }
  });

  // ---------- MCP ----------
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const asResult = (outcome: ToolOutcome) => ({
    content: [{ type: "text" as const, text: JSON.stringify(outcome.body, null, 2) }],
    ...(outcome.status === 200 ? { structuredContent: outcome.body } : { isError: true }),
  });

  // Every tool goes through the same admission as HTTP: free tools run, the owner key and free calls run unpaid,
  // and everything else follows the x402 MCP transport (PaymentRequired result, then _meta["x402/payment"]).
  // note() tells the request's usage record how a tool call was admitted, when paid its settlement transaction, and
  // the tool's result.
  type CallNote = { via?: string; paymentTx?: string; output?: unknown };
  const createMcpServer = (caller: { apiKey?: string; ip: string; userAgent?: string; note?: (n: CallNote) => void }) => {
    const server = new McpServer({ name: "base-pulse", version: "0.1.0" });
    for (const tool of TOOLS) {
      const price = priceOf(tool.name);
      const handler = async (args: any) => {
        const outcome = await runTool(tool, args);
        caller.note?.({ output: outcome.body });
        return asResult(outcome);
      };
      server.tool(tool.name, mcpDescription(tool), tool.inputs, READ_ONLY, async (args: any, extra: any) => {
        if (!price) return handler(args);
        let admission;
        try {
          admission = await admitCall({ tool: tool.name, ip: caller.ip, apiKey: caller.apiKey, hasPayment: Boolean(extra?._meta?.["x402/payment"]), userAgent: caller.userAgent });
        } catch (error) {
          console.error("free call metering error:", error);
          return { content: [{ type: "text" as const, text: "Usage metering is temporarily unavailable. Retry shortly." }], isError: true };
        }
        caller.note?.({ via: admission.via });
        if (admission.via === "x402") {
          try {
            const paid: any = await (await x402.wrapMcpTool(tool.name, price, handler))(args, extra);
            const settled = paid?._meta?.["x402/payment-response"];
            if (settled?.success && typeof settled.transaction === "string") caller.note?.({ via: "x402", paymentTx: settled.transaction });
            return paid;
          }
          catch (error) {
            console.error("x402 payment setup failed:", error);
            return { content: [{ type: "text" as const, text: "Payments are temporarily unavailable. Retry shortly." }], isError: true };
          }
        }
        const result: any = await handler(args);
        if (admission.via !== "free_call") return result;
        if (result.isError) await refundFreeCall(caller.ip, tool.name);
        return { ...result, _meta: { freeCallsRemaining: admission.remaining } };
      });
    }
    return server;
  };

  const sseTransports = new Map<string, SSEServerTransport>();
  app.get("/mcp/sse", async (req, res) => {
    const sessionId = randomUUID();
    const transport = new SSEServerTransport(`/mcp/messages?sessionId=${sessionId}`, res);
    sseTransports.set(sessionId, transport);
    await createMcpServer({ apiKey: keyFromReq(req), ip: req.ip || "unknown", userAgent: req.get("user-agent") }).connect(transport);
    res.on("close", () => sseTransports.delete(sessionId));
  });
  app.post("/mcp/messages", async (req, res) => {
    const transport = sseTransports.get(String(req.query.sessionId || ""));
    if (transport) await transport.handlePostMessage(req, res, req.body);
    else res.status(404).json({ error: "MCP SSE session not found." });
  });
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer({ apiKey: keyFromReq(req), ip: req.ip || "unknown", userAgent: req.get("user-agent"), note: (n) => Object.assign(res.locals, n) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }));

  // ---------- Discovery ----------
  const pricingSummary = `Every tool gives each caller ${FREE_CALLS_TEXT} (reset ${FREE_CALLS_RESET}), then costs $0.01 USDC per call ($0.02 for the three pre-sign and token safety checks), paid per request with x402 on Base. Calls that return an error are never charged.`;

  app.get("/.well-known/mcp.json", noCache, (_req, res) => {
    res.json({
      name: "Base Pulse",
      version: "0.1.0",
      description: "Safety checks and honest reads for AI agents on Base. Every answer comes from on-chain data and names its source.",
      instructions: `Connect with POST /mcp (Streamable HTTP) or /mcp/sse. ${pricingSummary} Paid calls follow the x402 v2 MCP transport: an unpaid call returns a PaymentRequired result and the client retries with _meta["x402/payment"]. No account or API key is needed. Field-by-field docs for every tool: GET /api/tools/<name>.`,
      payments: { protocol: "x402", x402Version: 2, scheme: "exact", network: X402_NETWORK, asset: "USDC", payTo: GATEWAY_WALLET, freeCallsPerTool: FREE_CALLS_PER_TOOL, freeCallsReset: FREE_CALLS_RESET },
      mcp_sse_endpoint: "/mcp/sse",
      tools: TOOLS.map((t) => ({ name: t.name, description: `${t.useWhen} ${priceText(t.name)}.`, price: priceOf(t.name) })),
    });
  });

  // Glama connector ownership verification
  app.get("/.well-known/glama.json", (_req, res) => {
    res.json({ $schema: "https://glama.ai/mcp/schemas/connector.json", maintainers: [{ email: "timothymycompc@gmail.com" }] });
  });

  // Every page and tool page, generated from the registry so new tools are indexed automatically.
  app.get("/sitemap.xml", noCache, (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const paths = ["/", "/docs/quickstart", "/docs/calls", "/docs/connect", "/docs/pricing", "/toolbox", "/status", ...TOOLS.map((t) => `/docs/tools/${t.name}`), "/llms.txt", "/.well-known/mcp.json"];
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${PUBLIC_URL}${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>`);
  });

  app.get("/robots.txt", noCache, (_req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${PUBLIC_URL}/sitemap.xml`);
  });

  app.get("/llms.txt", noCache, (_req, res) => {
    const section = (category: string, heading: string) => {
      const tools = TOOLS.filter((t) => t.category === category);
      return tools.length ? `## ${heading}\n${tools.map((t) => `- ${t.name} (${priceText(t.name)}): ${t.useWhen} Inputs: ${t.inputDocs.map((i) => `${i.name}${i.required ? "" : "?"}`).join(", ")}.`).join("\n")}\n` : "";
    };
    res.type("text/plain").send(`# Base Pulse

Safety checks and honest reads for AI agents on Base. Every answer comes from on-chain data and names its source; when data is missing it says "unknown" instead of guessing.

## Pricing
- ${pricingSummary}
- No account or API key. HTTP: an unpaid call to a paid tool returns 402 with a PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE. MCP: the unpaid call returns a PaymentRequired tool result; retry with _meta["x402/payment"].

## How to call
- HTTP: POST /api/tools/<name> with a JSON body of inputs.
- MCP: POST /mcp (Streamable HTTP) or /mcp/sse, then tools/call with the tool name.
- Docs for every input (what it's looking for, where to get it) and every output field (what it is, how it's worked out): GET /api/tools and GET /api/tools/<name>.
- Ready-to-run live example inputs: GET /api/tools/<name>/example.

${section("transactions", "Transactions")}
${section("tokens", "Tokens")}
${section("wallets", "Wallets")}
${section("network", "Network")}
${section("reference", "Reference")}`);
  });

  app.get("/api/debug/build", noCache, (_req, res) => res.json({ status: "alive", tools: TOOLS.length }));

  // Unknown discovery files get a plain 404, not the website, so crawlers don't mistake the page for a manifest.
  app.use("/.well-known", (_req, res) => res.status(404).json({ error: "Not found" }));

  // ---------- Frontend ----------
  const distPath = path.join(process.cwd(), "dist");
  if (!fs.existsSync(path.join(distPath, "index.html"))) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { allowedHosts: true, middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.use((_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Base Pulse running on port ${PORT} with ${TOOLS.length} tools`));
}

startServer();
