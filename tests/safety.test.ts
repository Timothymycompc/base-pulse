// token_safety on recorded real Base tokens (tests/fixtures/token-safety, made by scripts/measure-token-safety.ts).
// Every fixture replays offline to exactly the answer recorded from mainnet, and the measured promises hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { TOKEN_TOOLS } from "../server/tools/tokens";
import { replayContext } from "./helpers/replay";
import { oursHoneypot, type Fixture } from "./helpers/accuracy";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "token-safety");
const fixtures: Fixture[] = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));
const tool = TOKEN_TOOLS[0];

test("there are recorded cases to check", () => {
  assert.ok(fixtures.length >= 40, `only ${fixtures.length} fixtures`);
});

test("every recorded token replays to the answer recorded from mainnet", async () => {
  for (const f of fixtures.filter((f) => f.result)) {
    const replayed = await tool.run({ token: f.token }, replayContext(f.recording));
    assert.deepEqual(replayed, f.result, `${f.result!.symbol} ${f.token}`);
  }
});

test("no well-known token gets AVOID", () => {
  for (const f of fixtures.filter((f) => f.group === "well_known")) assert.notEqual(f.result?.verdict, "AVOID", `${f.result?.symbol}: ${f.result?.summary}`);
});

test("a token that can be bought but not sold always gets AVOID", () => {
  for (const f of fixtures.filter((f) => oursHoneypot(f))) assert.equal(f.result!.verdict, "AVOID", f.result!.symbol);
});

test("the rugged pools found while measuring (liquidity pulled to $0) get AVOID", () => {
  const cases = fixtures.filter((f) => f.group === "case");
  assert.ok(cases.length >= 2);
  for (const f of cases) assert.equal(f.result?.verdict, "AVOID", `${f.note}`);
});
