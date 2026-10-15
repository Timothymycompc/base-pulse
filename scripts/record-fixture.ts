// Records one real mainnet call of a tool as a test fixture, so `npm test` replays it offline forever after.
//   BASE_RPC_URL=... npx tsx scripts/record-fixture.ts <tool> '<json args>' <case-name> '<note>' ['<json expect>']
// note says why the case matters, in plain words. expect is what a person checked by hand, as {"dot.path": value},
// e.g. '{"verdict":"AVOID"}'; the test fails if a later change breaks it. Writes tests/fixtures/tools/<tool>/<case>.json.
import fs from "fs";
import path from "path";
import { TOOLS_BY_NAME, ToolError } from "../server/tools";
import { recordingContext } from "../tests/helpers/replay";
import { z } from "zod";
import { listMatch, TOKEN_LISTS } from "../server/tools/find";

const [name, argsJson, caseName, note, expectJson] = process.argv.slice(2);
const tool = TOOLS_BY_NAME.get(name ?? "");
if (!tool || !argsJson || !caseName || !note) {
  console.error("usage: record-fixture.ts <tool> '<json args>' <case-name> '<note>' ['<json expect>']");
  process.exit(1);
}
const args = z.object(tool.inputs).parse(JSON.parse(argsJson));
const { ctx, recording } = recordingContext();
let result: Record<string, unknown> | null = null;
let error: { status: number; message: string } | null = null;
try {
  result = await tool.run(args, ctx);
} catch (e: any) {
  if (!(e instanceof ToolError)) throw e;
  error = { status: e.status, message: e.message };
}
// Token lists are ~700 KB each; keep only the entries the call could have used, so fixtures stay small.
for (const url of Object.values(TOKEN_LISTS)) {
  const stored = recording.http[url] as any;
  if (stored?.result?.tokens) stored.result = { tokens: stored.result.tokens.filter((t: any) => listMatch(t, String((args as any).query ?? ""))) };
}
const fixture = { tool: name, case: caseName, note, args, recordedAt: new Date(recording.now).toISOString(), expect: expectJson ? JSON.parse(expectJson) : {}, result, error, recording };
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tests", "fixtures", "tools", name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${caseName}.json`), JSON.stringify(fixture, null, 1) + "\n");
console.log(JSON.stringify(error ?? result, null, 2));
