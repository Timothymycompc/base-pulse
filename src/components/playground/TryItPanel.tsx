import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, Copy, Play, RefreshCw } from 'lucide-react';
import { loadExample, loadFreeCallsUsed, runTool, snippetFor, type RunResult, type ToolDoc } from '../../lib/toolsApi';
import { Link } from '../../router';
import { ToolForm, toArguments } from './ToolForm';
import { button } from '../ui/button';
import { ToolResult } from './ToolResult';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// Live runner for one tool: preloaded with real mainnet inputs, every field editable.
export const TryItPanel: React.FC<{ tool: ToolDoc; freeCallsPerTool: number }> = ({ tool, freeCallsPerTool }) => {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [exampleState, setExampleState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [exampleError, setExampleError] = useState('');
  const [transport, setTransport] = useState<'http' | 'mcp'>('http');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [freeUsed, setFreeUsed] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);

  const fillExample = useCallback(async () => {
    setExampleState('loading');
    try { setValues(await loadExample(tool.name)); setExampleState('ready'); }
    catch (e: any) { setValues({}); setExampleState('error'); setExampleError(e.message); }
  }, [tool.name]);

  useEffect(() => { setResult(null); void fillExample(); if (tool.price) void loadFreeCallsUsed().then(setFreeUsed); }, [fillExample, tool.price]);

  const args = useMemo(() => toArguments(tool, values), [tool, values]);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try { setResult(await runTool(tool.name, args, transport)); }
    catch (e: any) { setResult({ status: 0, latencyMs: 0, body: { error: 'The browser could not reach the gateway.', fix: e.message }, headers: {}, freeCallsRemaining: null }); }
    finally { setRunning(false); if (tool.price) void loadFreeCallsUsed().then(setFreeUsed); }
  }, [tool, args, transport, running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = snippetFor(origin, tool.name, args, transport);
  const copySnippet = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  const freeLeft = tool.price ? Math.max(freeCallsPerTool - (freeUsed[tool.name] ?? 0), 0) : null;

  return (
    <section aria-label={`Try ${tool.name}`} className="overflow-hidden rounded-3xl border border-line surface shadow-[0_30px_70px_-40px_rgb(0_0_0/0.9)]">
      <div className="wood-head flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[15px] font-semibold text-tan-200">Try it on mainnet</h2>
          <Link to={`/toolbox?tool=${tool.name}`} className="text-[13px] text-gold-300 hover:text-gold-200">Open in the toolbox</Link>
        </div>
        <div role="radiogroup" aria-label="Transport" className="inline-flex rounded-lg border border-tan-500/35 bg-wood-950/60 p-0.5 text-[12px]">
          {(['http', 'mcp'] as const).map((t) => (
            <button key={t} role="radio" aria-checked={transport === t} onClick={() => setTransport(t)} className={`rounded-md px-2.5 py-1 font-medium transition ${transport === t ? 'bg-gold-400/20 text-gold-200' : 'text-tan-400 hover:text-tan-200'}`}>{t === 'http' ? 'HTTP' : 'MCP'}</button>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2 text-[12.5px]">
          <span className={exampleState === 'error' ? 'text-warning-200' : 'text-ink-400'}>
            {exampleState === 'loading' ? 'Loading a live mainnet example…' : exampleState === 'ready' ? 'Filled with a live mainnet example. Edit anything.' : `No example right now (${exampleError}). Fill the inputs yourself.`}
          </span>
          <button onClick={() => void fillExample()} disabled={exampleState === 'loading'} aria-label="Load a new example" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-ink-300 transition hover:border-ink-600 hover:text-white disabled:opacity-50">
            <RefreshCw className={`h-3 w-3 ${exampleState === 'loading' ? 'animate-spin' : ''}`} />Reload
          </button>
        </div>
        <ToolForm tool={tool} values={values} onChange={setValues} compact />

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void run()} disabled={running} className={button('primary', 'md', 'group flex-1 active:scale-[0.98] disabled:cursor-wait')}>
            {running ? <Activity className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{running ? 'Running…' : 'Run request'}
            {!running && <kbd className="ml-1 hidden rounded border border-white/25 bg-white/10 px-1 font-sans text-[9px] font-medium sm:inline">{isMac ? '⌘' : 'Ctrl'}↵</kbd>}
          </button>
          <button onClick={() => void copySnippet()} aria-label={transport === 'http' ? 'Copy cURL' : 'Copy MCP request'} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2.5 text-[13px] text-ink-300 transition hover:border-ink-600 hover:text-white">
            {copied ? <Check className="h-3.5 w-3.5 text-success-400" /> : <Copy className="h-3.5 w-3.5" />}{transport === 'http' ? 'cURL' : 'MCP'}
          </button>
        </div>
        <p className="text-[12.5px] text-ink-500">{tool.price ? `${freeLeft} of ${freeCallsPerTool} free calls left today, then ${tool.price} USDC per call.` : 'Free tool, rate-limited.'}</p>

        <ToolResult tool={tool} result={result} running={running} showFieldGuide={false} />
      </div>
    </section>
  );
};
