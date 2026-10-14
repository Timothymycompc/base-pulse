// Catches the easy mistakes when adding or changing a tool. Runs in `npm run check` and before every build.
import { TOOLS } from "../server/tools";
import { TOOL_PRICES } from "../server/pricing";
import { LISTING_EXAMPLES } from "../server/x402";

const problems: string[] = [];
const names = new Set<string>();
for (const tool of TOOLS) {
  if (names.has(tool.name)) problems.push(`${tool.name}: defined twice`);
  names.add(tool.name);
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) problems.push(`${tool.name}: names must be lower_snake_case`);
  if (!(tool.name in TOOL_PRICES)) problems.push(`${tool.name}: no entry in server/pricing.ts (use null for free)`);
  if (TOOL_PRICES[tool.name] && !LISTING_EXAMPLES[tool.name]) problems.push(`${tool.name}: paid tools need a fixed example input in LISTING_EXAMPLES (server/x402.ts)`);
  const inputs = Object.keys(tool.inputs);
  // Nested inputs may be documented field by field, e.g. "intent.token".
  const documented = tool.inputDocs.map((d) => d.name);
  const root = (doc: string) => doc.split(/[.[]/)[0];
  for (const i of inputs) if (!documented.some((d) => root(d) === i)) problems.push(`${tool.name}: input "${i}" has no inputDocs entry`);
  for (const d of documented) if (!inputs.includes(root(d))) problems.push(`${tool.name}: inputDocs lists "${d}", which is not an input`);
  if (!tool.outputs.length) problems.push(`${tool.name}: document at least one output field`);
  if (!tool.useWhen || !tool.description || !tool.benefit?.text) problems.push(`${tool.name}: useWhen, description and benefit are required`);
}
for (const name of Object.keys(TOOL_PRICES)) if (!names.has(name)) problems.push(`server/pricing.ts: "${name}" is priced but no tool has that name`);

if (problems.length) {
  console.error(`Tool check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Tool check passed: ${TOOLS.length} tools.`);
