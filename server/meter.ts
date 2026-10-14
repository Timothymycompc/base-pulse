import { createHmac, timingSafeEqual } from "crypto";
import { keyFromReq } from "./auth";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { pool } from "./db";
import { FREE_CALLS_PER_TOOL, priceOf, toolForRoute } from "./pricing";
import { TOOLS_BY_NAME } from "./tools";

// Free calls: each paid tool can be called FREE_CALLS_PER_TOOL times per caller IP (IPv6 grouped by /64) per UTC day,
// shared across HTTP and MCP. Keyed by IP rather than a cookie, because most agents and MCP clients do not keep cookies.

function normalizeIp(raw: string): string {
  const ip = (raw || "unknown").replace(/^::ffff:/i, "");
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}
// Keyed hash so stored caller IDs cannot be reversed into IP addresses by brute force.
const callerHashKey = () => process.env.CALLER_HASH_SECRET || process.env.DATABASE_URL || "local-development-caller-key";
export const hashIp = (ip: string) => createHmac("sha256", callerHashKey()).update("ip:" + normalizeIp(ip)).digest("hex");

// The owner key (OWNER_API_KEY secret, sent as x-api-key) gets unlimited calls on every tool.
export function isOwnerKey(apiKey?: string): boolean {
  const owner = process.env.OWNER_API_KEY;
  if (!owner || !apiKey) return false;
  const a = Buffer.from(apiKey), b = Buffer.from(owner);
  return a.length === b.length && timingSafeEqual(a, b);
}

// True when a row's last call was on an earlier UTC day, so its count starts again from zero.
const NEW_DAY = `(trial_tool_usage.last_call_at AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date`;

async function reserveFreeCall(ip: string, tool: string): Promise<number | null> {
  const result = await pool.query(
    `INSERT INTO trial_tool_usage (ip_hash, tool, calls_used)
     VALUES ($1, $2, 1)
     ON CONFLICT (ip_hash, tool) DO UPDATE SET
       calls_used = CASE WHEN ${NEW_DAY} THEN 1 ELSE trial_tool_usage.calls_used + 1 END,
       last_call_at = NOW()
     WHERE ${NEW_DAY} OR trial_tool_usage.calls_used < $3
     RETURNING calls_used`,
    [hashIp(ip), tool, FREE_CALLS_PER_TOOL]
  );
  return result.rowCount ? Number(result.rows[0].calls_used) : null;
}

export async function refundFreeCall(ip: string, tool: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE trial_tool_usage SET calls_used = GREATEST(calls_used - 1, 0) WHERE ip_hash = $1 AND tool = $2`,
      [hashIp(ip), tool]
    );
  } catch (error) { console.error("free call refund failed:", error); }
}

// Free calls used today per paid tool for this caller; tools never called are omitted.
export async function getFreeCallStatus(ip: string): Promise<Record<string, number>> {
  const result = await pool.query(`SELECT tool, CASE WHEN ${NEW_DAY} THEN 0 ELSE calls_used END AS calls_used FROM trial_tool_usage WHERE ip_hash = $1`, [hashIp(ip)]);
  return Object.fromEntries(result.rows.map((r: any) => [r.tool, Number(r.calls_used)]));
}

// One-off free passes the owner grants: a caller named here runs every tool free, without using its daily free calls,
// until the time given. After that it's back to the normal 25 a day. Kept in code so every pass is on record.
export const FREE_PASSES: { userAgent: RegExp; until: string; why: string }[] = [];
export const freePassFor = (userAgent: string | undefined, now = Date.now()) =>
  FREE_PASSES.find((p) => p.userAgent.test(userAgent ?? "") && now < Date.parse(p.until)) ?? null;

// How a call is admitted before any payment is asked for.
export type Admission =
  | { via: "free_tool" }
  | { via: "owner" }
  | { via: "free_pass" }
  | { via: "free_call"; remaining: number }
  | { via: "x402" };

export async function admitCall(o: { tool: string; ip: string; apiKey?: string; hasPayment: boolean; userAgent?: string }): Promise<Admission> {
  if (!priceOf(o.tool)) return { via: "free_tool" };
  if (isOwnerKey(o.apiKey)) return { via: "owner" };
  if (!o.hasPayment && freePassFor(o.userAgent)) return { via: "free_pass" };
  // A caller that already attached an x402 payment pays; free calls are not spent on it.
  if (!o.hasPayment && o.ip && o.ip !== "unknown") {
    const used = await reserveFreeCall(o.ip, o.tool);
    if (used !== null) return { via: "free_call", remaining: Math.max(FREE_CALLS_PER_TOOL - used, 0) };
  }
  return { via: "x402" };
}

// Directory checkers must see "402 Payment Required" to list a paid tool, so they get no free calls over HTTP: Coinbase's
// Bazaar validator (Go's default user agent and nothing else) and its indexer (CoinbaseBazaarDiscovery), which calls
// each tool with its listed example after a payment. A Go app that names itself still gets free calls.
export const NO_FREE_CALLS_UA = /^Go-http-client\/[\d.]+$|^CoinbaseBazaarDiscovery\//;

// HTTP gate for data routes: free tools, the owner key and free calls pass straight through; everything else goes to x402.
export function paidRouteMiddleware(x402Middleware: RequestHandler): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Express decodes the :name param, so "/api/tools/token%5Fsafety" shares token_safety's free calls instead of
    // getting its own allowance (req.path keeps the percent-encoding). Old names count as the tool's current name.
    const name = typeof req.params.name === "string" ? req.params.name : toolForRoute(req.path);
    const tool = TOOLS_BY_NAME.get(name)?.name ?? name;
    const ip = req.ip || "unknown";
    const hasPayment = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]) || NO_FREE_CALLS_UA.test(req.get("user-agent") ?? "");
    let admission: Admission;
    try {
      admission = await admitCall({ tool, ip, apiKey: keyFromReq(req), hasPayment, userAgent: req.get("user-agent") });
    } catch (error) {
      console.error("free call metering error:", error);
      return res.status(503).json({ error: "Usage metering is temporarily unavailable. Retry shortly." });
    }

    res.locals.via = admission.via;
    res.setHeader("Access-Control-Expose-Headers", "x-free-calls-remaining, payment-required, payment-response");
    if (admission.via === "free_call") res.setHeader("x-free-calls-remaining", String(admission.remaining));

    res.once("finish", () => {
      if (res.statusCode >= 400 && admission.via === "free_call") void refundFreeCall(ip, tool);
    });

    if (admission.via === "x402") return x402Middleware(req, res, next);
    return next();
  };
}
