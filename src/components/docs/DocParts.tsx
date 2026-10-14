import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Shared pieces for every docs page. Headlines are Inter Display; code and tool names are JetBrains Mono.

// kicker: a line above the title, used for the tool's own name (as the videos put it above the title).
export const PageHeader: React.FC<{ kicker?: React.ReactNode; title: React.ReactNode; lead?: React.ReactNode; aside?: React.ReactNode }> = ({ kicker, title, lead, aside }) => (
  <header className="mb-12 space-y-5 border-b border-line pb-10">
    {kicker && <p className="font-mono text-[14px] text-accent-300">{kicker}</p>}
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <h1 className="display text-[2.3rem] sm:text-[3.2rem]">{title}</h1>
      {aside}
    </div>
    {lead && <p className="max-w-[62ch] text-[18px] leading-[1.6] text-ink-300">{lead}</p>}
  </header>
);

export const H2: React.FC<{ id?: string; children: React.ReactNode }> = ({ id, children }) => (
  <h2 id={id} className="mb-4 mt-16 scroll-mt-28 text-[1.55rem] font-semibold tracking-[-0.015em] text-ink-50 first:mt-0" style={{ fontStretch: '112%' }}>{children}</h2>
);

export const P: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="mb-4 max-w-[68ch] text-[16px] leading-[1.7] text-ink-300">{children}</p>;

export const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className="rounded-md border border-line bg-code px-1.5 py-0.5 font-mono text-[0.86em] text-ink-100">{children}</code>
);

export const CodeBlock: React.FC<{ code: string; title?: string }> = ({ code, title }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  return (
    <div className="mb-6 overflow-hidden rounded-2xl border border-line bg-code shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2">
        <span className="flex items-center gap-2 text-[12.5px] text-ink-400"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-500/70" />{title ?? ''}</span>
        <button onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-400 transition hover:bg-white/5 hover:text-white" aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5 text-success-400" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 pb-4 pt-3 font-mono text-[12.5px] leading-[1.75] text-ink-200">{code}</pre>
    </div>
  );
};

export const Table: React.FC<{ head: string[]; rows: React.ReactNode[][]; minWidth?: number }> = ({ head, rows, minWidth = 560 }) => (
  <div className="table-scroll mb-8 rounded-2xl border border-line">
    <table className="data-table striped text-[14px]" style={{ minWidth }}>
      <thead className="text-[13px]">
        <tr>{head.map((h) => <th key={h} className="px-4 py-2.5">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="align-top">{cells.map((c, j) => <td key={j} className="px-4 py-3 text-[14.5px] leading-[1.6] text-ink-300">{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  </div>
);
