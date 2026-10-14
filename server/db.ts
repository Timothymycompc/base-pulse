import { Pool } from "pg";

const isCloudSqlSocket = (process.env.DATABASE_URL || "").includes("/cloudsql/");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isCloudSqlSocket ? undefined : { rejectUnauthorized: false },
});

// A tool run: a tool call over HTTP or MCP. Other /mcp traffic is connections, tool listings and uptime pings.
export const TOOL_RUN_SQL = `((method = 'POST' AND endpoint LIKE '/api/tools/%') OR endpoint LIKE '/mcp/tools/%')`;

// The gateway keeps five tables. No wallets, keys or balances are stored: payments settle on chain via x402.
export async function ensureSchema() {
  // Free calls per paid tool, counted per caller network per UTC day (keyed hash, never the raw IP).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trial_tool_usage (
      ip_hash TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls_used INTEGER NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_call_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ip_hash, tool)
    );
  `);

  // One row per /api and /mcp request: route, status, caller network hash and client name. No query strings.
  // via is how a tool call was admitted (free_call, owner, x402); payment_tx links a paid call to x402_payments;
  // mcp_client is the clientInfo name an MCP client sends on initialize. For tool calls only, input is the tool's
  // arguments and output its result (capped by capJson, cleared after IO_RETENTION_DAYS by clearOldToolIo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_usage (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status INTEGER NOT NULL,
      caller_hash TEXT,
      client TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE service_usage ADD COLUMN IF NOT EXISTS caller_hash TEXT, ADD COLUMN IF NOT EXISTS client TEXT,
    ADD COLUMN IF NOT EXISTS mcp_client TEXT, ADD COLUMN IF NOT EXISTS via TEXT, ADD COLUMN IF NOT EXISTS payment_tx TEXT,
    ADD COLUMN IF NOT EXISTS input JSONB, ADD COLUMN IF NOT EXISTS output JSONB;`);
  try {
    await pool.query(`DROP INDEX IF EXISTS service_usage_wallet_idx;`);
    await pool.query(`ALTER TABLE service_usage DROP COLUMN IF EXISTS wallet_address;`);
  } catch (error: any) { console.warn(`legacy column service_usage.wallet_address not dropped: ${error?.message ?? error}`); }
  await pool.query(`CREATE INDEX IF NOT EXISTS service_usage_created_idx ON service_usage (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS service_usage_endpoint_idx ON service_usage (endpoint, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS service_usage_payment_idx ON service_usage (payment_tx) WHERE payment_tx IS NOT NULL;`);

  // Every settled x402 payment: the revenue ledger. Amounts are USDC base units (6 decimals).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x402_payments (
      tx_signature TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      payer TEXT,
      amount_base_units BIGINT NOT NULL,
      asset TEXT NOT NULL,
      network TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS x402_payments_created_idx ON x402_payments (created_at DESC);`);

  // Site visits, sent by the page itself, so only browsers that run JavaScript are counted (most crawlers don't).
  // Path, referring site and client name only: no query strings, full referrer URLs or raw IPs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id BIGSERIAL PRIMARY KEY,
      path TEXT NOT NULL,
      referrer_host TEXT,
      caller_hash TEXT,
      client TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS page_views_created_idx ON page_views (created_at DESC);`);

  // Personal notes to callers who look like a real developer or AI app (outreach.ts). key is the caller: its user
  // agent, plus its network hash when the user agent is a generic one many people share.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach (
      key TEXT PRIMARY KEY,
      match_ua TEXT NOT NULL,
      match_hash TEXT,
      name TEXT,
      note TEXT NOT NULL,
      tools TEXT,
      runs INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Networks the owner dashboard was opened from, so the owner's own calls and visits can be told apart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_networks (
      caller_hash TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Tables from the retired SOL-credit system and the old cookie trial. Cleanup must never stop the server
  // from starting: CASCADE removes foreign keys that point at these tables, and failures are only logged.
  for (const table of ["missed_endpoints", "wallets", "used_wallet_signatures", "processed_payments", "call_history", "anonymous_trial_usage"]) {
    try { await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE;`); }
    catch (error: any) { console.warn(`legacy table ${table} not dropped: ${error?.message ?? error}`); }
  }
}

// Tool inputs and outputs are kept this long, then cleared; the rest of the row stays for the stats.
export const IO_RETENTION_DAYS = 30;
const MAX_IO_CHARS = 32_000;

// A JSON value small enough to keep: anything larger is replaced by a note with its size.
export function capJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  // Postgres JSONB rejects NUL characters inside strings.
  try { text = JSON.stringify(value, (_key, v) => (typeof v === "string" ? v.replace(/\0/g, "") : v)); } catch { return null; }
  if (text === undefined) return null;
  return text.length > MAX_IO_CHARS ? JSON.stringify({ truncated: true, chars: text.length }) : text;
}

export async function clearOldToolIo() {
  try {
    await pool.query(`UPDATE service_usage SET input = NULL, output = NULL
      WHERE created_at < NOW() - make_interval(days => $1::int) AND (input IS NOT NULL OR output IS NOT NULL)`, [IO_RETENTION_DAYS]);
  } catch (e) {
    console.error("clearing old tool inputs and outputs failed:", e);
  }
}

export async function recordServiceUsage(params: {
  endpoint: string; method: string; status: number; callerHash: string | null; client: string | null;
  mcpClient?: string | null; via?: string | null; paymentTx?: string | null; input?: unknown; output?: unknown;
}) {
  try {
    await pool.query(
      `INSERT INTO service_usage (endpoint, method, status, caller_hash, client, mcp_client, via, payment_tx, input, output)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [params.endpoint, params.method, params.status, params.callerHash, params.client, params.mcpClient ?? null, params.via ?? null,
        params.paymentTx ?? null, capJson(params.input), capJson(params.output)]
    );
  } catch (e) {
    console.error("service_usage insert failed:", e);
  }
}

export async function recordPayment(params: { txSignature: string; tool: string; payer: string | null; amountBaseUnits: string; asset: string; network: string }) {
  try {
    await pool.query(
      `INSERT INTO x402_payments (tx_signature, tool, payer, amount_base_units, asset, network) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tx_signature) DO NOTHING`,
      [params.txSignature, params.tool, params.payer, params.amountBaseUnits, params.asset, params.network]
    );
  } catch (e) {
    console.error("x402_payments insert failed:", e);
  }
}

export async function recordPageView(params: { path: string; referrerHost: string | null; callerHash: string | null; client: string | null }) {
  try {
    await pool.query(
      `INSERT INTO page_views (path, referrer_host, caller_hash, client) VALUES ($1, $2, $3, $4)`,
      [params.path, params.referrerHost, params.callerHash, params.client]
    );
  } catch (e) {
    console.error("page_views insert failed:", e);
  }
}

export async function noteOwnerNetwork(callerHash: string) {
  await pool.query(
    `INSERT INTO owner_networks (caller_hash) VALUES ($1) ON CONFLICT (caller_hash) DO UPDATE SET last_seen = NOW()`,
    [callerHash]
  );
}
