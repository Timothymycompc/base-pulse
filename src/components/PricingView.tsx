import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { FREE_CALLS_TEXT, TOOL_PRICES } from '../../server/pricing';
import { H2, PageHeader } from './docs/DocParts';

const NETWORK = 'eip155:8453';

const httpExample = `import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// A Base wallet holding a little USDC; it signs each payment. No ETH is needed for gas.
const signer = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "${NETWORK}", client: new ExactEvmScheme(signer) }],
});

const res = await fetchWithPayment(
  "${typeof window !== 'undefined' ? window.location.origin : ''}/api/tools/balance",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: "<0x address>" }) }
);
console.log(await res.json());`;

const mcpExample = `import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = createx402MCPClient({
  name: "my-agent",
  version: "1.0.0",
  schemes: [{ network: "${NETWORK}", client: new ExactEvmScheme(signer) }],
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(
  new URL("${typeof window !== 'undefined' ? window.location.origin : ''}/mcp")
));
const result = await client.callTool("balance", { wallet: "<0x address>" });`;

const tiers = [
  { price: '$0.01', note: 'Reads, lookups, helpers and transaction forensics.' },
  { price: '$0.02', note: 'The three checks that protect funds.' },
] as const;

const CodeBlock: React.FC<{ id: string; title: string; code: string; copied: string | null; onCopy: (id: string, code: string) => void }> = ({ id, title, code, copied, onCopy }) => (
  <div className="min-w-0 rounded-xl border border-line surface-inset">
    <div className="flex items-center justify-between px-4 pt-2.5">
      <span className="text-[12.5px] text-ink-400">{title}</span>
      <button onClick={() => onCopy(id, code)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-400 hover:bg-white/5 hover:text-white">
        {copied === id ? <Check className="h-3.5 w-3.5 text-success-400" /> : <Copy className="h-3.5 w-3.5" />}{copied === id ? 'Copied' : 'Copy'}
      </button>
    </div>
    <pre className="overflow-x-auto px-4 pb-4 pt-2 font-mono text-[12px] leading-[1.7] text-ink-200">{code}</pre>
  </div>
);

export const PricingView: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1800);
    } catch { setCopied(null); }
  };

  return (
    <div className="space-y-10">
      <PageHeader title="Pricing & x402" lead={<>Every tool gives you {FREE_CALLS_TEXT} (reset at midnight UTC), then one or two cents in USDC paid with each request through the open x402 protocol. No account or API key; agents with a Base wallet pay automatically. Calls that return an error are never charged, and network fees are covered.</>} />

      <section>
        <H2>Prices after the free calls</H2>
        <div className="grid gap-4 md:grid-cols-2">
          {tiers.map((tier) => {
            const tools = Object.keys(TOOL_PRICES).filter((tool) => TOOL_PRICES[tool] === tier.price);
            return (
              <div key={tier.price} className="rounded-2xl border border-line surface p-5">
                <p className="display text-[2.4rem] font-extrabold tabular-nums">{tier.price}<span className="ml-2 text-[15px] font-medium tracking-normal text-ink-400">a call</span></p>
                <p className="mt-1 text-[14px] text-ink-400">{tier.note}</p>
                <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                  {tools.map((tool) => <li key={tool} className="font-mono text-[12.5px] text-accent-300">{tool}</li>)}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <H2>How a paid call works</H2>
        <ol className="grid gap-3 md:grid-cols-3">
          {[
            ['Call the tool', 'Once that day\'s free calls are used, the gateway answers 402 Payment Required (over MCP: a tool result with the payment details). It lists the exact USDC amount and where to pay.'],
            ['Your client pays', 'An x402 client signs a USDC transfer for that amount and retries the same call with it attached. No sign-up and no prepaid balance.'],
            ['Get the answer and a receipt', 'The payment is checked, the tool runs, and the transfer settles on Base only if the call succeeded. The receipt includes the transaction hash.'],
          ].map(([title, detail], i) => (
            <li key={title} className="rounded-2xl border border-line surface p-5">
              <span className="display text-[1.6rem] font-bold text-accent-300">{i + 1}</span>
              <p className="mt-1 text-[16px] font-semibold text-ink-50">{title}</p>
              <p className="mt-1.5 text-[14px] leading-[1.6] text-ink-400">{detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-4">
        <H2>Add payments to your client</H2>
        <div className="grid gap-4 lg:grid-cols-2">
          <CodeBlock id="http" title="HTTP, with @x402/fetch" code={httpExample} copied={copied} onCopy={copy} />
          <CodeBlock id="mcp" title="MCP, with @x402/mcp" code={mcpExample} copied={copied} onCopy={copy} />
        </div>
        <p className="text-[13px] leading-[1.6] text-ink-400">Network <code className="text-ink-300">{NETWORK}</code> (Base mainnet), asset USDC, scheme <code className="text-ink-300">exact</code>. Prices are also listed in <a href="/.well-known/mcp.json" className="text-accent-300 hover:text-accent-200">mcp.json</a>, <a href="/llms.txt" className="text-accent-300 hover:text-accent-200">llms.txt</a> and <a href="/api/trial/status" className="text-accent-300 hover:text-accent-200">/api/trial/status</a>.</p>
      </section>
    </div>
  );
};
