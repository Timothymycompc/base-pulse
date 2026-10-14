export function keyFromReq(req: { headers: Record<string, any> }): string | undefined {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  const a = req.headers["authorization"];
  if (typeof a === "string") {
    const m = a.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}
