// A real paid call to each tool on the live site, paid in USDC on Base from the test wallet (BASE_TEST_PAYER_KEY).
//   BASE_TEST_PAYER_KEY=$(gcloud secrets versions access latest --secret=BASE_TEST_PAYER_KEY) npx tsx scripts/paid-test.ts [tool...]
// The first request sends Go's default user agent, which the meter never gives free calls (it's what Coinbase's directory
// checker sends), so the site answers 402 and the payment path runs even while this network has free calls left.
import { createPublicClient, erc20Abi, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { USDC } from "../server/tools/chain";
import { LISTING_EXAMPLES } from "../server/x402";

const SITE = process.env.SITE ?? "https://base-pulse-1021990235790.us-central1.run.app";
const key = process.env.BASE_TEST_PAYER_KEY as Hex | undefined;
if (!key) throw new Error("Set BASE_TEST_PAYER_KEY (from Secret Manager).");
const account = privateKeyToAccount(key);
const chain = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
const usdc = async () => formatUnits(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address], authorizationList: undefined }), 6);

const payer = new x402HTTPClient(new x402Client().register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account as any, chain as any))));
console.log(`Test wallet ${account.address}: ${await usdc()} USDC`);

for (const tool of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LISTING_EXAMPLES)) {
  const url = `${SITE}/api/tools/${tool}`;
  const body = JSON.stringify(LISTING_EXAMPLES[tool]);
  const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Go-http-client/1.1" }, body });
  if (first.status !== 402) { console.log(`${tool}: expected 402, got ${first.status}`); continue; }
  const required = payer.getPaymentRequiredResponse((h) => first.headers.get(h), await first.json().catch(() => undefined));
  const payload = await payer.createPaymentPayload(required);
  const paid = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "base-pulse-paid-test/1", ...payer.encodePaymentSignatureHeader(payload) }, body });
  const answer = await paid.json().catch(() => null);
  let settled: any = null;
  try { settled = payer.getPaymentSettleResponse((h) => paid.headers.get(h)); } catch { /* no receipt */ }
  console.log(`${tool}: HTTP ${paid.status}, price ${Number(required.accepts[0].amount) / 1e6} USDC to ${required.accepts[0].payTo}`);
  console.log(`  receipt: ${settled?.success ? `https://basescan.org/tx/${settled.transaction}` : JSON.stringify(settled ?? answer).slice(0, 200)}`);
  if (paid.ok) console.log(`  answer: ${JSON.stringify(answer).slice(0, 160)}`);
}
console.log(`Test wallet now: ${await usdc()} USDC`);
