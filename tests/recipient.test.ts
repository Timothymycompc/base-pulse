// recipient_check on recorded real Base cases (tests/fixtures/recipient-check, made by scripts/measure-recipient-check.ts).
// Every case replays offline to exactly the answer recorded from mainnet, and the measured promises hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { SCREEN_TOOLS } from "../server/tools/screen";
import { replayContext } from "./helpers/replay";
import type { RecipientFixture } from "./helpers/recipient-accuracy";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "recipient-check");
const fixtures: RecipientFixture[] = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))) : [];
const tool = SCREEN_TOOLS.find((t) => t.name === "recipient_check")!;

test("there are recorded cases to check", () => {
  assert.ok(fixtures.filter((f) => f.group === "poisoned").length >= 20, "too few poisoned cases");
});

test("every recorded case replays to the answer recorded from mainnet", async () => {
  for (const f of fixtures.filter((f) => f.result)) {
    const replayed = await tool.run({ from: f.from, to: f.to, network: "base" }, replayContext(f.recording));
    assert.deepEqual(replayed, f.result, `${f.group} ${f.from} -> ${f.to}`);
  }
});

test("every poisoned address found on chain gets AVOID", () => {
  for (const f of fixtures.filter((f) => f.group === "poisoned")) assert.equal(f.result?.verdict, "AVOID", f.truth);
});

test("the address a poisoning victim really paid never gets AVOID", () => {
  for (const f of fixtures.filter((f) => f.group === "meant")) assert.notEqual(f.result?.verdict, "AVOID", `${f.truth} ${f.result?.summary}`);
});
