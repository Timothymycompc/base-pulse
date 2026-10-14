import React from 'react';
import { Link } from '../router';
import { CATEGORY_ORDER, toolPath } from '../nav';
import { CATEGORY_LABELS, type ToolsIndex } from '../lib/toolsApi';
import { CodeBlock } from '../components/docs/DocParts';
import { button } from '../components/ui/button';
import { ServiceUsagePanel } from '../components/ServiceUsagePanel';

// A real balance result from Base mainnet (14 October 2026), set in the instrument case. On load the readings come in
// one by one. With reduced motion it is all there at once.
const reveal = (ms: number): React.CSSProperties => ({ animation: `fade-up var(--duration-slow) var(--ease-out-soft) ${ms}ms both` });
const Reading: React.FC = () => (
  <figure className="instrument-case">
    <div className="instrument-face">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-code/80 px-5 py-3.5">
        <div className="min-w-0 font-mono text-[12.5px] leading-6">
          <div className="text-ink-50">POST /api/tools/balance</div>
          <div className="truncate text-ink-500">{'{ "wallet": "0xd8dA…6045" }'}</div>
        </div>
        <span className="readout shrink-0 text-[13px] text-ink-500">Base mainnet</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 pb-6 pt-6">
        <div style={reveal(250)}><dt className="text-[13px] text-ink-500">ETH</dt><dd className="readout mt-1 text-[22px] text-ink-50">3.1288</dd></div>
        <div style={reveal(600)}><dt className="text-[13px] text-ink-500">USDC</dt><dd className="readout mt-1 text-[22px] text-ink-50">44.78</dd></div>
        <div className="col-span-2" style={reveal(950)}><dt className="text-[13px] text-ink-500">Source</dt><dd className="mt-1 text-[14px] leading-[1.55] text-ink-300">Base RPC: eth_getBalance and USDC balanceOf, both at block 52,582,171</dd></div>
      </dl>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-[13px] text-ink-500">
        <span>A real reading on Base mainnet, 14 October 2026</span>
        <Link to={toolPath('balance')} className="font-medium text-accent-300 hover:text-accent-200">Run it yourself</Link>
      </figcaption>
    </div>
  </figure>
);

const SectionTitle: React.FC<{ children: React.ReactNode; lead?: React.ReactNode }> = ({ children, lead }) => (
  <div className="mb-8 max-w-[60ch]">
    <h2 className="display text-[1.85rem] sm:text-[2.35rem]">{children}</h2>
    {lead && <p className="mt-3 text-[16px] leading-[1.65] text-ink-400">{lead}</p>}
  </div>
);

export const OverviewPage: React.FC<{ index: ToolsIndex | null }> = ({ index }) => {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="space-y-28">
      <section className="grid items-center gap-14 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,31rem)] lg:pt-10">
        <div>
          <h1 className="display text-[2.6rem] sm:text-[3.9rem] xl:text-[4.25rem]">Real answers for agents on Base.</h1>
          <p className="mt-7 max-w-[36rem] text-[18px] leading-[1.6] text-ink-300">
            Base Pulse reads the chain directly and names the source of every number, so your agent acts on facts instead of guesses. When data is missing, it says unknown. Safety checks for tokens, transactions and signatures are being built now, one at a time.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link to="/docs/connect" className={button('primary')}>Connect an agent</Link>
            <Link to="/toolbox" className={button('secondary')}>Open the toolbox</Link>
          </div>
          <p className="mt-7 max-w-[36rem] text-[14px] leading-[1.6] text-ink-500">
            Works over MCP and plain HTTP. Every tool gives 25 free calls a day, then costs one or two cents a call in USDC through x402. No account or API key.
          </p>
        </div>
        <Reading />
      </section>


      <section>
        <SectionTitle lead="Each tool page documents every input and returned field, and runs the tool live on mainnet data.">Every tool</SectionTitle>
        {!index && <div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-40 rounded-2xl" />)}</div>}
        {index && (
          <div className="grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {CATEGORY_ORDER.map((category) => {
              const tools = index.tools.filter((t) => t.category === category);
              if (!tools.length) return null;
              return (
                <div key={category} className="bg-panel p-5">
                  <h3 className="mb-3 text-[13px] font-semibold text-tan-400">{CATEGORY_LABELS[category]}</h3>
                  <ul className="space-y-0.5">
                    {tools.map((t) => (
                      <li key={t.name}>
                        <Link to={toolPath(t.name)} className="group -mx-2 flex items-baseline justify-between gap-4 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
                          <span className="min-w-0">
                            <span className="block text-[15px] text-ink-100 group-hover:text-white">{t.title}</span>
                            <code className="block font-mono text-[12px] text-ink-500">{t.name}</code>
                          </span>
                          <span className="readout shrink-0 text-[14px] text-ink-500">{t.price ?? 'Free'}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <Link to="/toolbox" className="group flex flex-col justify-end gap-2 bg-wood-950/80 p-5 transition-colors hover:bg-wood-900/80">
              <span className="text-[13px] font-semibold text-tan-400">Toolbox</span>
              <span className="text-[17px] font-semibold leading-snug text-tan-200 group-hover:text-gold-200">Run any of them on mainnet, change any input, and replay your calls.</span>
            </Link>
          </div>
        )}
      </section>

      <section className="grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <SectionTitle lead="Reads a wallet's ETH and USDC on Base, with the block it read them at.">Your first call</SectionTitle>
          <CodeBlock title="Terminal" code={`curl -X POST '${origin}/api/tools/balance' \\\n  -H 'content-type: application/json' \\\n  -d '{"wallet":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'`} />
        </div>
        <div className="min-w-0">
          <SectionTitle>When the free calls run out</SectionTitle>
          <p className="max-w-[58ch] text-[16px] leading-[1.7] text-ink-300">
            The tool answers <span className="font-mono text-[14px] text-ink-100">402 Payment Required</span> with its price. An agent with an x402 client pays from its Base wallet and retries, all within the same request. Calls that fail are never charged, and network fees are covered.
          </p>
          <Link to="/docs/pricing" className="mt-5 inline-block text-[15px] font-medium text-accent-300 underline decoration-accent-300/30 underline-offset-4 hover:decoration-accent-300">See prices and payment setup</Link>
        </div>
      </section>

      <section><ServiceUsagePanel /></section>
    </div>
  );
};
