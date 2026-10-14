// Counts how often token_safety agrees with two independent checkers (GoPlus, honeypot.is) on recorded real tokens.
import type { Recording } from "./replay";

export type Labels = {
  goplus: { is_honeypot: number | null; buy_tax: number | null; sell_tax: number | null; cannot_sell_all: number | null; is_mintable: number | null; is_proxy: number | null; is_open_source: number | null; owner_address: string | null } | null;
  honeypot_is: { is_honeypot: boolean; buy_tax: number | null; sell_tax: number | null; pair: string | null } | null;
};
export type Fixture = { token: string; group: "well_known" | "new" | "case"; note?: string; recordedAt: string; result: Record<string, any> | null; error: string | null; labels: Labels; recording: Recording };

const check = (f: Fixture, name: string) => (f.result?.checks as any[] | undefined)?.find((c) => c.name === name);
// Our view, from the result: honeypot = bought but couldn't sell; null when the sell wasn't tested.
export const oursHoneypot = (f: Fixture) => (f.result?.trade_test?.bought ? f.result.trade_test.sold === false : null);
// Theirs: either checker calls it a honeypot; null when neither had an answer.
export const theirsHoneypot = (f: Fixture) => {
  const g = f.labels.goplus?.is_honeypot, h = f.labels.honeypot_is?.is_honeypot;
  if (g === 1 || h === true) return true;
  return g === 0 || h === false ? false : null;
};
// Sell tax in percent: honeypot.is gives percent, GoPlus a fraction.
export const theirsSellTax = (f: Fixture) => f.labels.honeypot_is?.sell_tax ?? (f.labels.goplus?.sell_tax != null ? f.labels.goplus.sell_tax * 100 : null);

export function summarize(fixtures: Fixture[]): string {
  const ran = fixtures.filter((f) => f.result);
  const lines: string[] = [];
  const dates = fixtures.map((f) => f.recordedAt.slice(0, 10));
  lines.push(`# token_safety accuracy`, "", `Measured ${dates[0]} on ${fixtures.length} real Base tokens: ${fixtures.filter((f) => f.group === "new").length} that got a new Uniswap pool against ETH or WETH in the previous ~100 minutes, ${fixtures.filter((f) => f.group === "well_known").length} well-known tokens and ${fixtures.filter((f) => f.group === "case").length} recorded cases. Each answer is recorded in this folder and replayed by \`npm test\`. Compared with GoPlus and honeypot.is, two independent checkers; neither is ground truth, so disagreements are listed for a person to judge.`, "");

  const count = (g: string, v: string) => ran.filter((f) => f.group === g && f.result!.verdict === v).length;
  lines.push("## Verdicts", "", "| Group | SAFE | CAUTION | AVOID | Error |", "| --- | --- | --- | --- | --- |");
  for (const g of ["new", "well_known", "case"]) lines.push(`| ${{ new: "New tokens", well_known: "Well known", case: "Recorded cases" }[g]} | ${count(g, "SAFE")} | ${count(g, "CAUTION")} | ${count(g, "AVOID")} | ${fixtures.filter((f) => f.group === g && !f.result).length} |`);

  const tested = ran.filter((f) => oursHoneypot(f) !== null);
  lines.push("", "## Sell test", "", `Selling was simulated for ${tested.length} of ${ran.length} tokens (${Math.round((tested.length / Math.max(ran.length, 1)) * 100)}%). The rest trade only on pools the test doesn't cover yet, or their buy failed.`);
  const both = tested.filter((f) => theirsHoneypot(f) !== null);
  const agree = both.filter((f) => oursHoneypot(f) === theirsHoneypot(f));
  lines.push("", `Honeypot (can buy, can't sell): we and at least one other checker both answered for ${both.length} tokens and agreed on ${agree.length}.`);
  const oursOnly = tested.filter((f) => oursHoneypot(f) && theirsHoneypot(f) !== true);
  const theirsOnly = ran.filter((f) => theirsHoneypot(f) === true && oursHoneypot(f) !== true);
  if (oursOnly.length) lines.push("", "We flag as a honeypot, others don't:", ...oursOnly.map((f) => `- ${f.result!.symbol} \`${f.token}\`: ${f.result!.trade_test.sell_error}`));
  if (theirsOnly.length) lines.push("", "Others flag as a honeypot, we don't:", ...theirsOnly.map((f) => `- ${f.result!.symbol} \`${f.token}\`: our sell test ${oursHoneypot(f) === null ? "didn't run" : "sold fine"}`));

  const taxed = tested.filter((f) => f.result!.trade_test.sold && f.result!.trade_test.sell_tax != null && theirsSellTax(f) != null);
  const close = taxed.filter((f) => Math.abs(f.result!.trade_test.sell_tax * 100 - theirsSellTax(f)!) <= 2);
  lines.push("", `Sell tax: both measured it for ${taxed.length} tokens; within 2 percentage points for ${close.length}.`);
  for (const f of taxed.filter((f) => !close.includes(f))) lines.push(`- ${f.result!.symbol}: ours ${(f.result!.trade_test.sell_tax * 100).toFixed(1)}%, theirs ${theirsSellTax(f)!.toFixed(1)}%`);

  const mintBoth = ran.filter((f) => check(f, "source")?.result === "pass" && f.labels.goplus?.is_mintable != null);
  const mintAgree = mintBoth.filter((f) => Boolean(check(f, "mint")) === (f.labels.goplus!.is_mintable === 1));
  lines.push("", "## Owner powers", "", `Mint power: both could read it for ${mintBoth.length} tokens; agreed on ${mintAgree.length}.`);
  for (const f of mintBoth.filter((f) => !mintAgree.includes(f))) lines.push(`- ${f.result!.symbol}: ours ${check(f, "mint") ? check(f, "mint").result : check(f, "crosschain_mint") ? "only a bridge mint (crosschainMint, ERC-7802), which GoPlus counts as mintable" : "no mint function in the verified code"}, GoPlus is_mintable=${f.labels.goplus!.is_mintable}`);

  const srcBoth = ran.filter((f) => f.labels.goplus?.is_open_source != null);
  const weFound = srcBoth.filter((f) => check(f, "source")?.result === "pass").length;
  const theyFound = srcBoth.filter((f) => f.labels.goplus!.is_open_source === 1).length;
  lines.push("", "## Verified source", "", `Of ${srcBoth.length} tokens, we found verified source for ${weFound}; GoPlus reports ${theyFound} as open source. The gap is contracts verified only on Basescan, which we read only when an Etherscan key is set.`);

  const cases = fixtures.filter((f) => f.group === "case");
  if (cases.length) lines.push("", "## Recorded cases", "", ...cases.map((f) => `- ${f.note} Our verdict: ${f.result?.verdict ?? `error (${f.error})`}.`));
  const alarms = ran.filter((f) => f.group === "well_known" && f.result!.verdict === "AVOID");
  lines.push("", "## False alarms on well-known tokens", "", alarms.length ? alarms.map((f) => `- ${f.result!.symbol}: ${f.result!.summary}`).join("\n") : "None: no well-known token got AVOID.");
  return lines.join("\n") + "\n";
}
