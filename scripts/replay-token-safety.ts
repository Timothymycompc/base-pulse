// After changing a token_safety rule: re-run every recorded token offline, store the new answers and rewrite ACCURACY.md.
// Review the git diff of tests/fixtures/token-safety to see exactly which answers the change moved.
//   npx tsx scripts/replay-token-safety.ts
import fs from "fs";
import path from "path";
import { TOKEN_TOOLS } from "../server/tools/tokens";
import { replayContext } from "../tests/helpers/replay";
import { summarize, type Fixture } from "../tests/helpers/accuracy";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tests", "fixtures", "token-safety");
const fixtures: Fixture[] = [];
let changed = 0;
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const f: Fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
  if (f.result) {
    const result = await TOKEN_TOOLS[0].run({ token: f.token }, replayContext(f.recording));
    if (JSON.stringify(result) !== JSON.stringify(f.result)) {
      changed++;
      console.log(`${String(result.symbol).padEnd(12)} ${f.result.verdict} -> ${result.verdict}`);
      f.result = result;
      fs.writeFileSync(path.join(DIR, file), JSON.stringify(f));
    }
  }
  fixtures.push(f);
}
fs.writeFileSync(path.join(DIR, "ACCURACY.md"), summarize(fixtures));
console.log(`${changed} of ${fixtures.length} answers changed; ACCURACY.md rewritten.`);
