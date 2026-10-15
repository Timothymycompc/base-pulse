// Every tool on recorded real Base data (tests/fixtures/tools/<tool>/*.json, made by scripts/record-fixture.ts).
// Each fixture replays offline to exactly the answer recorded from mainnet, and still meets what a person checked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { TOOLS, TOOLS_BY_NAME, ToolError } from "../server/tools";
import { replayContext, type Recording } from "./helpers/replay";

type Fixture = { tool: string; case: string; note: string; args: Record<string, unknown>; expect: Record<string, unknown>; result: Record<string, unknown> | null; error: { status: number; message: string } | null; recording: Recording };

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "tools");
const fixtures: Fixture[] = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, f), "utf8"))))
  : [];

// "checks[name=sell].result" finds the element of checks whose name is sell; plain dots walk into objects and arrays.
export function at(value: any, dotted: string): unknown {
  for (const part of dotted.split(".")) {
    const m = part.match(/^(\w+)\[(\w+)=([^\]]+)\]$/);
    value = m ? (value?.[m[1]] as any[] | undefined)?.find((x) => String(x?.[m[2]]) === m[3]) : value?.[part];
  }
  return value;
}

async function replay(f: Fixture) {
  try {
    return { result: await TOOLS_BY_NAME.get(f.tool)!.run(f.args, replayContext(f.recording)), error: null };
  } catch (e: any) {
    if (!(e instanceof ToolError)) throw e;
    return { result: null, error: { status: e.status, message: e.message } };
  }
}

for (const f of fixtures) {
  test(`${f.tool} / ${f.case}: replays to the recorded answer and meets its checks`, async () => {
    assert.ok(TOOLS_BY_NAME.has(f.tool), `no tool named ${f.tool}`);
    const replayed = await replay(f);
    assert.deepEqual(replayed, { result: f.result, error: f.error }, f.note);
    for (const [p, want] of Object.entries(f.expect)) assert.deepEqual(at(f.error ? { error: f.error } : f.result, p), want, `${p} (${f.note})`);
  });
}

test("every tool other than token_safety has recorded cases, including at least one checked by hand", () => {
  for (const tool of TOOLS.filter((t) => t.name !== "token_safety")) {
    const mine = fixtures.filter((f) => f.tool === tool.name);
    assert.ok(mine.length >= 2, `${tool.name}: only ${mine.length} recorded case(s)`);
    assert.ok(mine.some((f) => Object.keys(f.expect).length), `${tool.name}: no case has hand-checked expectations`);
  }
});
