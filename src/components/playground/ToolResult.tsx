import React, { useState } from 'react';
import { BookOpen, Check, Clock, Copy, Wallet } from 'lucide-react';
import { JsonView } from './JsonView';
import { useCountUp } from '../../hooks/motion';
import type { RunResult, ToolDoc } from '../../lib/toolsApi';
import { CheckLine, isCheckStatus, Stamp } from '../ui/verdict';

const checkTitle = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// The verdict as a stamp with its summary, then the checks behind it, as the tool videos show them.
function VerdictReport({ body }: { body: any }) {
  const verdict = typeof body?.verdict === 'string' ? body.verdict : null;
  if (!verdict) return null;
  const text = body.summary ?? body.explanation ?? '';
  const checks = Array.isArray(body.checks) ? body.checks.filter((c: any) => isCheckStatus(c?.result) && typeof c?.detail === 'string') : [];
  return (
    <div className="animate-scale-in rounded-xl border border-line bg-panel p-4">
      <Stamp verdict={verdict} />
      {text && <p className="mt-3 text-[13.5px] leading-[1.6] text-ink-200">{text}</p>}
      {checks.length > 0 && <ul className="mt-3 space-y-2 border-t border-line pt-3 text-[13px] leading-[1.55] text-ink-300">
        {checks.map((c: any, i: number) => <CheckLine key={`${c.name}-${i}`} status={c.result} title={c.name ? checkTitle(String(c.name)) : undefined}>{c.detail}</CheckLine>)}
      </ul>}
    </div>
  );
}

export function ToolResult({ tool, result, running, showFieldGuide = true }: { tool: ToolDoc; result: RunResult | null; running: boolean; showFieldGuide?: boolean }) {
  const [copied, setCopied] = useState(false);
  const latency = useCountUp(result?.latencyMs ?? 0, 500);
  const present = new Set(result && typeof result.body === 'object' && result.body ? Object.keys(result.body as object) : []);

  if (running) return (
    <div className="space-y-2.5 rounded-xl border border-white/10 surface-inset p-4" aria-busy="true" aria-label="Waiting for the live response">
      <div className="skeleton h-12 w-full rounded-lg" /><div className="skeleton h-3 w-3/4 rounded" /><div className="skeleton h-3 w-2/3 rounded" /><div className="skeleton h-3 w-5/6 rounded" />
    </div>
  );
  if (!result) return (
    <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-white/15 px-4 text-center">
      <p className="max-w-sm text-[13px] leading-[1.6] text-ink-400">Run the request to see the live response. The inputs are real mainnet data, so it works as it is.</p>
    </div>
  );

  const ok = result.status >= 200 && result.status < 300;
  const body: any = result.body;
  const copy = async () => {
    try { await navigator.clipboard.writeText(typeof body === 'string' ? body : JSON.stringify(body, null, 2)); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div key={result.latencyMs + String(result.status)} className="animate-fade-up space-y-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] font-bold ${ok ? 'border-success-500/30 bg-success-500/10 text-success-300' : result.status === 402 ? 'border-warning-500/30 bg-warning-500/10 text-warning-200' : 'border-danger-500/30 bg-danger-500/10 text-danger-300'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-success-400' : result.status === 402 ? 'bg-warning-300' : 'bg-danger-400'}`} />HTTP {result.status}
        </span>
        <div className="flex items-center gap-3 text-[12px] text-ink-300">
          {result.freeCallsRemaining !== null && <span className="text-success-300">{result.freeCallsRemaining} free calls left today for this tool</span>}
          <span className="inline-flex items-center gap-1 font-mono"><Clock className="h-3 w-3 text-ink-400" />{latency} ms</span>
          <button onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 transition hover:border-ink-600 hover:text-white">
            {copied ? <Check className="h-3 w-3 text-success-400" /> : <Copy className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {ok && <VerdictReport body={body} />}
      {result.status === 402 && (
        <div className="flex gap-3 rounded-xl border border-warning-400/30 bg-warning-500/10 p-3 text-warning-100">
          <Wallet className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-xs leading-5">
            <p className="font-bold">Payment required: today's free calls for this tool are used.</p>
            {result.payment && <p className="mt-0.5">The gateway asks for <span className="font-mono">{(Number(result.payment.amount) / 1e6).toFixed(3)} USDC</span> per call, paid with x402 to <span className="font-mono">{result.payment.payTo.slice(0, 6)}…</span>. An x402 client (see Pricing) pays and retries automatically.</p>}
          </div>
        </div>
      )}
      {!ok && result.status !== 402 && body?.error && (
        <div className="rounded-xl border border-danger-400/30 bg-danger-500/10 p-3 text-xs leading-5 text-danger-100">
          <p className="font-semibold">{body.error}</p>
          {body.fix && <p className="mt-0.5 opacity-90">Fix: {body.fix}</p>}
          {Array.isArray(body.issues) && <ul className="mt-1 list-disc pl-4">{body.issues.map((i: any) => <li key={i.field}><span className="font-mono">{i.field}</span>: {i.problem}</li>)}</ul>}
        </div>
      )}

      <JsonView value={body} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line surface-inset p-3 font-mono text-[12px] leading-[1.6] text-ink-200" />

      {ok && showFieldGuide && (
        <details className="group rounded-xl border border-line surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-semibold text-ink-200 [&::-webkit-details-marker]:hidden">
            <BookOpen className="h-4 w-4 text-accent-300" /> What every returned field is
            <span className="ml-auto text-[12px] font-normal text-ink-400 group-open:hidden">Show</span><span className="ml-auto hidden text-[12px] font-normal text-ink-400 group-open:inline">Hide</span>
          </summary>
          <div className="max-h-96 overflow-auto border-t border-line">
            <table className="data-table striped text-[12px]">
              <thead className="sticky top-0 z-10 text-[12px]"><tr><th className="px-3 py-2">Field</th><th className="px-3 py-2">What it is</th><th className="px-3 py-2">How it's worked out</th></tr></thead>
              <tbody>
                {tool.outputs.map((o) => (
                  <tr key={o.field} className={`align-top ${present.has(o.field.split(/[.[ ]/)[0]) ? '' : 'opacity-60'}`}>
                    <td className="px-3 py-2"><code className="font-mono text-accent-200">{o.field}</code><div className="text-[11.5px] text-ink-500">{o.type}</div></td>
                    <td className="px-3 py-2 text-ink-200">{o.is}</td>
                    <td className="px-3 py-2 text-ink-400">{o.howWorkedOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
