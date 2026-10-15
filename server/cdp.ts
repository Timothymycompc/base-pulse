// Coinbase's x402 facilitator (CDP). Every request carries a short-lived JWT signed with the CDP API key, made here
// with node:crypto so no Coinbase SDK is needed. The key secret is either a base64 Ed25519 key (64 bytes: seed then
// public key) or a PEM EC key, as the CDP portal issues them.
import crypto from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

type SigningKey = { key: crypto.KeyObject; alg: "EdDSA" | "ES256" };

export function signingKey(secret: string): SigningKey {
  if (secret.includes("BEGIN")) return { key: crypto.createPrivateKey(secret.replace(/\\n/g, "\n")), alg: "ES256" };
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 64 && raw.length !== 32) throw new Error("CDP_API_KEY_SECRET is neither a PEM EC key nor a base64 Ed25519 key");
  return { key: crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: "der", type: "pkcs8" }), alg: "EdDSA" };
}

// A JWT good for one method and URL, for two minutes.
export function cdpJwt(keyId: string, signer: SigningKey, method: string, url: string): string {
  const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const { host, pathname } = new URL(url);
  const header = { alg: signer.alg, kid: keyId, typ: "JWT", nonce: crypto.randomBytes(16).toString("hex") };
  const claims = { sub: keyId, iss: "cdp", nbf: now, exp: now + 120, uris: [`${method} ${host}${pathname}`] };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const signature = signer.alg === "EdDSA"
    ? crypto.sign(null, Buffer.from(input), signer.key)
    : crypto.sign("sha256", Buffer.from(input), { key: signer.key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(signature)}`;
}

// The CDP facilitator client, or null when the key isn't configured (payments then go through PayAI alone).
export function cdpFacilitator(keyId = process.env.CDP_API_KEY_ID, secret = process.env.CDP_API_KEY_SECRET): HTTPFacilitatorClient | null {
  if (!keyId || !secret) return null;
  const signer = signingKey(secret.trim());
  const auth = (method: string, path: string) => ({ Authorization: `Bearer ${cdpJwt(keyId.trim(), signer, method, `${CDP_FACILITATOR_URL}/${path}`)}` });
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => ({
      verify: auth("POST", "verify"),
      settle: auth("POST", "settle"),
      supported: auth("GET", "supported"),
      bazaar: auth("GET", "discovery/resources"),
    }),
  });
}

// Coinbase's SQL API over indexed Base data (https://docs.cdp.coinbase.com/data/sql-api). Used to find history the
// node can't search quickly (approvals, transfers); anything that decides money is then re-read from the chain.
export const CDP_SQL_URL = "https://api.cdp.coinbase.com/platform/v2/data/query/run";

export function cdpSql(keyId = process.env.CDP_API_KEY_ID, secret = process.env.CDP_API_KEY_SECRET): ((sql: string) => Promise<Record<string, any>[]>) | undefined {
  if (!keyId || !secret) return undefined;
  const signer = signingKey(secret.trim());
  return async (sql) => {
    const res = await fetch(CDP_SQL_URL, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${cdpJwt(keyId.trim(), signer, "POST", CDP_SQL_URL)}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`CDP SQL ${res.status}: ${String(body?.errorMessage ?? "no answer").split("\n")[0]}`);
    return Array.isArray(body?.result) ? body.result : [];
  };
}
