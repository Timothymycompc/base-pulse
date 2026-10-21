// Measures recipient_check on real Base wallets and records every answer as a test fixture.
//   BASE_RPC_URL=... CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... npx tsx scripts/measure-recipient-check.ts [perGroup=30]
// Ground truth comes from the chain, found with this script's own queries (not the tool's code):
//   poisoned: a zero-value USDC transfer out of the victim's wallet that a third party signed (the victim never did),
//             to an address with the same first and last 4 characters as one the victim really paid. Should be AVOID.
//   meant:    the address that victim really paid, the one the poisoner imitated. Should not be AVOID.
//   repeat:   a real USDC payment from the last hour, checked as if the sender were paying again. Should not be AVOID.
//   first:    a sender paired with another payment's recipient it has never paid. A first payment isn't a trap.
// Writes tests/fixtures/recipient-check/*.json and ACCURACY.md.
import fs from "fs";
import path from "path";
import { cdpSql } from "../server/cdp";
import { SCREEN_TOOLS } from "../server/tools/screen";
import { recordingContext } from "../tests/helpers/replay";
import { recipientReport, type Group, type RecipientFixture } from "../tests/helpers/recipient-accuracy";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tests", "fixtures", "recipient-check");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// A wallet whose history is bigger than this would make a fixture of several MB; such wallets are left out and counted.
const MAX_FIXTURE_BYTES = 400_000;
const perGroup = Number(process.argv[2] ?? 30);
const live = cdpSql();
if (!live) throw new Error("Set CDP_API_KEY_ID and CDP_API_KEY_SECRET: the history checks need Coinbase's SQL API.");
// This script's own queries retry a dropped connection a few times (the tool's queries are recorded as they happen).
const sql = async (query: string) => {
  for (let attempt = 1; ; attempt++) {
    try { return await live(query); } catch (e) { if (attempt === 4) throw e; await new Promise((r) => setTimeout(r, attempt * 5000)); }
  }
};
const tool = SCREEN_TOOLS.find((t) => t.name === "recipient_check")!;
const ends = (a: string) => [a.slice(2, 6), a.slice(-4)].map((s) => s.toLowerCase());

async function poisonCases(want: number) {
  const fakes = await sql(`SELECT from_address AS victim, to_address AS poison, any(transaction_from) AS attacker, min(block_timestamp) AS planted_at
    FROM base.transfers WHERE token_address = '${USDC}' AND value = '0' AND action = 'added' AND transaction_from != from_address
      AND block_timestamp > now() - INTERVAL 24 HOUR
    GROUP BY victim, poison ORDER BY planted_at DESC LIMIT 20000`);
  // Round-robin across attackers, so one busy attacker doesn't make up the whole sample.
  const byAttacker = new Map<string, typeof fakes>();
  for (const f of fakes) byAttacker.set(f.attacker, [...(byAttacker.get(f.attacker) ?? []), f]);
  const queue: typeof fakes = [];
  for (let i = 0; queue.length < fakes.length; i++) for (const list of byAttacker.values()) if (list[i]) queue.push(list[i]);
  const seen = new Set<string>(), cases: { victim: string; poison: string; meant: string; truth: string }[] = [];
  for (const f of queue) {
    if (cases.length >= want) break;
    if (seen.has(f.victim)) continue;
    seen.add(f.victim);
    const [head, tail] = ends(f.poison);
    const paid = await sql(`SELECT to_address, count() AS n FROM base.transfers WHERE from_address = '${f.victim}' AND transaction_from = from_address
      AND value != '0' AND action = 'added' AND to_address != '${f.poison}' AND substring(to_address, 3, 4) = '${head}' AND substring(to_address, 39, 4) = '${tail}'
      GROUP BY to_address ORDER BY n DESC LIMIT 1`);
    if (!paid.length) continue;
    cases.push({ victim: f.victim, poison: f.poison, meant: paid[0].to_address,
      truth: `${f.attacker} signed a zero-value USDC transfer from ${f.victim} to ${f.poison} on ${String(f.planted_at).slice(0, 16)}; the victim has really paid ${paid[0].to_address} ${paid[0].n} time(s), same first and last 4 characters.` });
  }
  return cases;
}

async function ordinaryPayments(want: number) {
  // Plain sends: the sender called USDC's own transfer (transaction_to is the USDC contract), at least $1 (dust is mostly
  // spam). A swap also moves USDC out of the signer's wallet, but into a pool through a router: not a payment.
  return sql(`SELECT from_address AS sender, any(to_address) AS recipient, max(block_timestamp) AS at FROM base.transfers
    WHERE token_address = '${USDC}' AND action = 'added' AND transaction_from = from_address AND transaction_to = '${USDC}' AND value >= 1000000
      AND block_timestamp > now() - INTERVAL 1 HOUR
    GROUP BY sender ORDER BY cityHash64(sender) LIMIT ${want * 4}`);
}

async function record(group: Group, from: string, to: string, truth: string, retry = true): Promise<RecipientFixture | null> {
  const { ctx, recording } = recordingContext();
  let result: Record<string, any> | null = null, error: string | null = null;
  try { result = await tool.run({ from, to, network: "base" }, ctx); } catch (e: any) { error = String(e?.message ?? e); }
  // A dropped connection to the SQL API is the network, not the tool: try the case once more before recording it.
  const sqlFailed = Object.entries(recording.http).some(([k, v]: [string, any]) => k.startsWith("SQL ") && v.error);
  if (sqlFailed && retry) return record(group, from, to, truth, false);
  // The tool reads only the recipient's own entry from the sanctions list; keep just that, not all 124 addresses.
  const ofac = recording.http["OFAC list"] as any;
  if (ofac?.result?.addresses) ofac.result.addresses = Object.fromEntries(Object.entries(ofac.result.addresses).filter(([a]) => a.toLowerCase() === to.toLowerCase()));
  const fixture: RecipientFixture = { group, from, to, truth, recordedAt: new Date(recording.now).toISOString(), result, error, recording };
  const json = JSON.stringify(fixture);
  if (json.length > MAX_FIXTURE_BYTES) return null;
  fs.writeFileSync(path.join(DIR, `${group}-${from.slice(2, 8)}-${to.slice(2, 8)}.json`.toLowerCase()), json);
  console.log(`${group.padEnd(9)} ${from.slice(0, 10)} -> ${to.slice(0, 10)} ${result?.verdict ?? `ERROR ${error?.slice(0, 80)}`}`);
  return fixture;
}

fs.mkdirSync(DIR, { recursive: true });
const fixtures: RecipientFixture[] = [];
let tooBig = 0;
const keep = (f: RecipientFixture | null) => (f ? fixtures.push(f) : tooBig++);

for (const c of await poisonCases(perGroup)) {
  keep(await record("poisoned", c.victim, c.poison, c.truth));
  keep(await record("meant", c.victim, c.meant, c.truth.replace(/;.*/, `; this is the address the victim really paid.`)));
}
const payments = await ordinaryPayments(perGroup);
let repeat = 0, first = 0;
for (let i = 0; i < payments.length && (repeat < perGroup || first < perGroup); i++) {
  const p = payments[i], other = payments[(i + 1) % payments.length];
  if (repeat < perGroup) {
    const f = await record("repeat", p.sender, p.recipient, `${p.sender} signed a USDC payment of at least $1 to ${p.recipient} on ${String(p.at).slice(0, 16)}.`);
    keep(f);
    if (f) repeat++;
  }
  if (first < perGroup && other.recipient !== p.sender && other.recipient !== p.recipient) {
    const f = await record("first", p.sender, other.recipient, `${other.recipient} received a real USDC payment from another wallet; ${p.sender} has never paid it.`);
    // Only a true first payment belongs in this group.
    if (f && f.result?.times_paid_before !== 0) fs.rmSync(path.join(DIR, `first-${p.sender.slice(2, 8)}-${other.recipient.slice(2, 8)}.json`.toLowerCase()));
    else { keep(f); if (f) first++; }
  }
}
fs.writeFileSync(path.join(DIR, "ACCURACY.md"), recipientReport(fixtures, tooBig));
console.log(`\n${fixtures.length} recorded, ${tooBig} left out (history too big to keep as a fixture)`);
