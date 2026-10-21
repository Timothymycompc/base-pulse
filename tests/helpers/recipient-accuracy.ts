// Counts how often recipient_check gets real cases right (scripts/measure-recipient-check.ts records them).
import type { Recording } from "./replay";

export type Group = "poisoned" | "meant" | "repeat" | "first";
export type RecipientFixture = { group: Group; from: string; to: string; truth: string; recordedAt: string; result: Record<string, any> | null; error: string | null; recording: Recording };

const GROUPS: { group: Group; label: string; right: string; isRight: (v: string) => boolean }[] = [
  { group: "poisoned", label: "Poisoned address", right: "AVOID", isRight: (v) => v === "AVOID" },
  { group: "meant", label: "Address the victim really paid", right: "not AVOID", isRight: (v) => v !== "AVOID" },
  { group: "repeat", label: "Paying someone again", right: "not AVOID", isRight: (v) => v !== "AVOID" },
  { group: "first", label: "First payment to a real recipient", right: "not AVOID", isRight: (v) => v !== "AVOID" },
];
export const isRight = (f: RecipientFixture) => !!f.result && GROUPS.find((g) => g.group === f.group)!.isRight(f.result.verdict);

export function recipientReport(fixtures: RecipientFixture[], leftOut = 0): string {
  const date = fixtures.map((f) => f.recordedAt.slice(0, 10)).sort()[0] ?? "never";
  const lines = [
    "# recipient_check accuracy", "",
    `Measured ${date} on ${fixtures.length} real Base cases. Each answer is recorded in this folder and replayed by \`npm test\`. The right answer for each case comes from the chain, found by scripts/measure-recipient-check.ts with its own queries:`, "",
    "- **Poisoned address:** a third party signed a zero-value USDC transfer out of the victim's wallet to this address, which has the same first and last 4 characters as an address the victim really paid. Right answer: AVOID.",
    "- **Address the victim really paid:** the address the poisoner imitated. Right answer: anything but AVOID.",
    "- **Paying someone again:** a real USDC payment of at least $1 from the last hour, checked as if the sender were paying again. Right answer: anything but AVOID.",
    "- **First payment to a real recipient:** a sender paired with a wallet that really received USDC from someone else and that the sender has never paid. Right answer: anything but AVOID.", "",
    "| Case | Right answer | Cases | Right | SAFE | CAUTION | AVOID | Error |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const g of GROUPS) {
    const fs = fixtures.filter((f) => f.group === g.group), n = (v: string) => fs.filter((f) => f.result?.verdict === v).length;
    lines.push(`| ${g.label} | ${g.right} | ${fs.length} | ${fs.filter(isRight).length} | ${n("SAFE")} | ${n("CAUTION")} | ${n("AVOID")} | ${fs.filter((f) => !f.result).length} |`);
  }
  const poisoned = fixtures.filter((f) => f.group === "poisoned");
  lines.push("", `The poisoned cases come from ${new Set(poisoned.map((f) => f.truth.split(" ")[0])).size} different attacker wallets and ${new Set(poisoned.map((f) => f.from)).size} victims.`);
  if (leftOut) lines.push("", `${leftOut} sampled case(s) were left out because the sender's history was too big to keep as a test fixture (busy bots and exchanges).`);
  const wrong = fixtures.filter((f) => !isRight(f));
  lines.push("", "## Wrong answers", "", wrong.length ? "Each one, with what the chain showed, for a person to judge:" : "None.");
  for (const f of wrong) lines.push("", `- **${GROUPS.find((g) => g.group === f.group)!.label}**, ${f.from} → ${f.to}: we said ${f.result?.verdict ?? `error (${f.error})`}. ${f.result?.summary ?? ""}`, `  Chain: ${f.truth}`);
  const cautions = fixtures.filter((f) => f.result?.verdict === "CAUTION");
  if (cautions.length) {
    lines.push("", "## Why CAUTION", "");
    const why = new Map<string, number>();
    for (const f of cautions) for (const c of f.result!.checks.filter((c: any) => c.result === "warn")) why.set(c.name, (why.get(c.name) ?? 0) + 1);
    for (const [name, n] of [...why].sort((a, b) => b[1] - a[1])) lines.push(`- ${name}: ${n}`);
  }
  return lines.join("\n") + "\n";
}
