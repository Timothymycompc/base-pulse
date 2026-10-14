import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, Copy, Eraser, Play, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { CATEGORY_LABELS, loadExample, loadFreeCallsUsed, runTool, snippetFor, type RunResult, type ToolDoc, type ToolsIndex } from '../lib/toolsApi';
import { CATEGORY_ORDER, toolPath } from '../nav';
import { Link } from '../router';
import { ToolForm, toArguments } from '../components/playground/ToolForm';
import { ToolResult } from '../components/playground/ToolResult';
import { button } from '../components/ui/button';

// Every tool on one bench: pick any tool, edit any input (as a form or as raw JSON), run it on mainnet,
// and reopen any earlier call to change it and run it again. Drafts and calls stay in this browser.

type Values = Record<string, unknown>;
type Transport = 'http' | 'mcp';
type Call = { id: string; at: number; tool: string; transport: Transport; args: Values; result: RunResult };

const DRAFTS_KEY = 'pulse.toolbox.drafts';
const CALLS_KEY = 'pulse.toolbox.calls';
const MAX_CALLS = 40;
const MAX_BODY_CHARS = 40_000;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function readStore<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function writeStore(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the page still works, it just forgets */ }
}

// What a call keeps once saved: no headers, and no body if it is too large to keep.
function toStored(call: Call): Call {
  const { headers: _headers, ...result } = call.result;
  const size = JSON.stringify(result.body ?? '').length;
  return { ...call, result: { ...result, headers: {}, body: size > MAX_BODY_CHARS ? 'This response was too large to keep in the browser. Run the call again to see it.' : result.body } };
}

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
};
const argSummary = (args: Values) => Object.entries(args)
  .map(([k, v]) => `${k} ${typeof v === 'string' ? (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v) : JSON.stringify(v)}`)
  .join(', ') || 'no inputs';
const statusTone = (status: number) => status >= 200 && status < 300 ? 'bg-success-400' : status === 402 ? 'bg-warning-300' : 'bg-danger-400';

const Segmented = <T extends string>({ label, value, options, onChange, tone = 'ink' }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; tone?: 'ink' | 'wood' }) => (
  <div role="radiogroup" aria-label={label} className={`inline-flex rounded-md border p-0.5 text-[12px] ${tone === 'wood' ? 'border-tan-500/35 bg-wood-950/60' : 'border-line bg-code'}`}>
    {options.map(([v, text]) => (
      <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
        className={`rounded px-2 py-1 font-medium transition ${value === v ? (tone === 'wood' ? 'bg-gold-400/20 text-gold-200' : 'bg-white/10 text-white') : (tone === 'wood' ? 'text-tan-400 hover:text-tan-200' : 'text-ink-400 hover:text-white')}`}>{text}</button>
    ))}
  </div>
);

export const ToolboxPage: React.FC<{ index: ToolsIndex }> = ({ index }) => {
  const { tools, freeCallsPerTool } = index;
  const [name, setName] = useState(() => {
    const asked = new URLSearchParams(window.location.search).get('tool');
    return tools.some((t) => t.name === asked) ? asked! : tools[0].name;
  });
  const tool = tools.find((t) => t.name === name) ?? tools[0];

  const [drafts, setDrafts] = useState<Record<string, Values>>(() => readStore(DRAFTS_KEY, {}));
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [exampleState, setExampleState] = useState<Record<string, string>>({}); // 'loading' or an error message
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState('');
  const [rawArgs, setRawArgs] = useState<Values | null>(null);
  const [explain, setExplain] = useState(false);
  const [transport, setTransport] = useState<Transport>('http');
  const [running, setRunning] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, Call>>({});
  const [calls, setCalls] = useState<Call[]>(() => readStore(CALLS_KEY, []));
  const [freeUsed, setFreeUsed] = useState<Record<string, number>>({});
  const [rackQuery, setRackQuery] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<'all' | 'tool'>('all');
  const [clearArmed, setClearArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const benchRef = useRef<HTMLElement>(null);

  // The tool switcher closes on a click outside it or on Escape.
  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent) => { if (!switcherRef.current?.contains(e.target as Node)) setSwitcherOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSwitcherOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [switcherOpen]);

  useEffect(() => writeStore(DRAFTS_KEY, drafts), [drafts]);
  useEffect(() => writeStore(CALLS_KEY, calls), [calls]);
  useEffect(() => { void loadFreeCallsUsed().then(setFreeUsed); }, []);

  const fillExample = useCallback(async (toolName: string) => {
    setExampleState((e) => ({ ...e, [toolName]: 'loading' }));
    try {
      const args = await loadExample(toolName);
      setDrafts((d) => ({ ...d, [toolName]: args }));
      setExampleState(({ [toolName]: _done, ...rest }) => rest);
    } catch (e: any) { setExampleState((s) => ({ ...s, [toolName]: e.message })); }
  }, []);

  const resetJson = () => { setJsonText(null); setRawArgs(null); setJsonError(''); };

  // A tool opened for the first time starts from a live mainnet example; after that it keeps your edits.
  useEffect(() => {
    window.history.replaceState(null, '', `/toolbox?tool=${name}`);
    resetJson();
    if (!draftsRef.current[name]) void fillExample(name);
  }, [name, fillExample]);

  const values = drafts[name] ?? {};
  const setValues = (v: Values) => setDrafts((d) => ({ ...d, [name]: v }));
  const args = useMemo(() => (mode === 'json' && rawArgs ? rawArgs : toArguments(tool, values)), [mode, rawArgs, tool, values]);

  const onJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The inputs must be one JSON object, like {"address": "…"}.');
      setRawArgs(parsed);
      setValues(parsed);
      setJsonError('');
    } catch (e: any) { setJsonError(e instanceof SyntaxError ? `Not valid JSON yet: ${e.message}` : e.message); }
  };

  const run = useCallback(async (toolName: string, callArgs: Values, via: Transport) => {
    if (running) return;
    setRunning(toolName);
    let result: RunResult;
    try { result = await runTool(toolName, callArgs, via); }
    catch (e: any) { result = { status: 0, latencyMs: 0, body: { error: 'The browser could not reach the gateway.', fix: e.message }, headers: {}, freeCallsRemaining: null }; }
    const call: Call = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), tool: toolName, transport: via, args: callArgs, result };
    setShown((s) => ({ ...s, [toolName]: call }));
    setCalls((c) => [toStored(call), ...c].slice(0, MAX_CALLS));
    setRunning(null);
    void loadFreeCallsUsed().then(setFreeUsed);
  }, [running]);

  const blocked = mode === 'json' && Boolean(jsonError);
  const runCurrent = useCallback(() => { if (!blocked) void run(name, args, transport); }, [blocked, run, name, args, transport]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCurrent(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCurrent]);

  const pick = (toolName: string) => { setName(toolName); setSwitcherOpen(false); setRackQuery(''); };
  const openCall = (call: Call, again = false) => {
    setName(call.tool);
    setDrafts((d) => ({ ...d, [call.tool]: call.args }));
    setTransport(call.transport);
    setMode('form');
    resetJson();
    if (again) void run(call.tool, call.args, call.transport);
    else setShown((s) => ({ ...s, [call.tool]: call }));
    benchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const clearCalls = () => {
    if (!clearArmed) { setClearArmed(true); window.setTimeout(() => setClearArmed(false), 3000); return; }
    setCalls([]); setClearArmed(false);
  };
  const copySnippet = async () => {
    try { await navigator.clipboard.writeText(snippetFor(window.location.origin, name, args, transport)); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const freeLeft = (t: ToolDoc) => Math.max(freeCallsPerTool - (freeUsed[t.name] ?? 0), 0);
  const q = rackQuery.trim().toLowerCase();
  const groups = CATEGORY_ORDER
    .map((category) => ({ category, tools: tools.filter((t) => t.category === category && (!q || `${t.name} ${t.title} ${t.useWhen}`.toLowerCase().includes(q))) }))
    .filter((g) => g.tools.length);
  const example = exampleState[name];
  const current = shown[name];
  const list = scope === 'tool' ? calls.filter((c) => c.tool === name) : calls;

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <h1 className="display text-[2.3rem] sm:text-[3.2rem]">Toolbox</h1>
          <p className="mt-3 max-w-[60ch] text-[17px] leading-[1.6] text-ink-300">Pick any tool, change any input, run it on mainnet, and reopen any call to change it and run it again.</p>
        </div>
        <p className="text-[13px] text-ink-500 max-sm:hidden"><kbd className="rounded-md border border-line px-1.5 py-0.5 font-sans text-[11px] text-ink-300">{isMac ? '⌘' : 'Ctrl'} ↵</kbd> runs the tool</p>
      </header>

      {/* The console: which tool, how it's sent, then its inputs beside its answer. */}
      <section ref={benchRef} aria-label={`${tool.name} console`} className="scroll-mt-24 overflow-visible rounded-3xl border border-line surface shadow-[0_40px_90px_-50px_rgb(0_0_0/0.95)]">
        <div className="wood-head relative z-20 flex flex-wrap items-center gap-3 rounded-t-3xl px-4 py-3 sm:px-5">
          <div ref={switcherRef} className="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
            <button onClick={() => setSwitcherOpen((o) => !o)} aria-expanded={switcherOpen} aria-haspopup="listbox"
              className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-tan-500/30 bg-wood-950/60 px-3 py-2 text-left transition hover:border-gold-500/50 sm:w-auto">
              <span className="min-w-0">
                <span className="block truncate font-mono text-[15px] font-semibold text-gold-200">{tool.name}</span>
                <span className="block truncate text-[13px] text-tan-300">{tool.title}</span>
              </span>
              <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-tan-400 transition-transform ${switcherOpen ? 'rotate-180' : ''}`} />
            </button>
            {switcherOpen && (
              <div className="popup absolute left-0 top-[calc(100%+8px)] w-[min(40rem,calc(100vw-2.5rem))] origin-top-left animate-drop-in overflow-hidden rounded-2xl">
                <label className="flex items-center gap-2 border-b border-line px-4">
                  <Search className="h-4 w-4 shrink-0 text-gold-400" />
                  <input autoFocus value={rackQuery} onChange={(e) => setRackQuery(e.target.value)} placeholder="Find a tool by name or what it does" aria-label="Find a tool"
                    onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) pick(groups[0].tools[0].name); }}
                    className="h-12 w-full bg-transparent text-[15px] text-ink-50 outline-none placeholder:text-ink-500" />
                </label>
                <div role="listbox" aria-label="Tools" className="grid max-h-[60vh] gap-x-4 gap-y-3 overflow-y-auto p-3 sm:grid-cols-2">
                  {groups.map((g) => (
                    <div key={g.category}>
                      <p className="mb-1 px-2 text-[12.5px] font-semibold text-tan-400">{CATEGORY_LABELS[g.category]}</p>
                      {g.tools.map((t) => {
                        const active = t.name === name;
                        return (
                          <button key={t.name} role="option" aria-selected={active} onClick={() => pick(t.name)}
                            className={`flex w-full items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05] ${active ? 'bg-white/[0.06]' : ''}`}>
                            <span className="min-w-0">
                              <span className={`block truncate font-mono text-[13px] ${active ? 'text-gold-200' : 'text-ink-100'}`}>{t.name}</span>
                              <span className="block truncate text-[12.5px] text-ink-400">{t.title}</span>
                            </span>
                            <span className="readout shrink-0 text-[12.5px] text-ink-500">{t.price ? `${freeLeft(t)} free` : 'Free'}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {!groups.length && <p className="px-2 py-4 text-[13px] text-ink-500">No tool matches “{rackQuery}”.</p>}
                </div>
              </div>
            )}
          </div>
          <Segmented label="Transport" tone="wood" value={transport} onChange={setTransport} options={[['http', 'HTTP'], ['mcp', 'MCP']]} />
          <span className="readout text-[14px] text-tan-300" title={tool.price ? `${freeLeft(tool)} of ${freeCallsPerTool} free calls left today, then ${tool.price} USDC per call` : 'Free tool'}>
            {tool.price ? `${freeLeft(tool)}/${freeCallsPerTool} free, then ${tool.price}` : 'Free'}
          </span>
        </div>

        <div className="grid lg:grid-cols-2">
          {/* Inputs */}
          <div className="min-w-0 space-y-4 border-b border-line p-4 sm:p-5 lg:border-b-0 lg:border-r">
            <p className="max-w-[70ch] text-[14.5px] leading-[1.6] text-ink-300">{tool.useWhen} <Link to={toolPath(tool.name)} className="whitespace-nowrap font-medium text-accent-300 hover:text-accent-200">Read the docs</Link></p>

            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Edit as" value={mode} onChange={(m) => { setMode(m); resetJson(); }} options={[['form', 'Form'], ['json', 'JSON']]} />
              {mode === 'form' && (
                <button role="switch" aria-checked={explain} onClick={() => setExplain((x) => !x)} className={`rounded-lg border px-2.5 py-1 text-[12.5px] transition ${explain ? 'border-gold-500/50 text-gold-200' : 'border-line text-ink-400 hover:text-white'}`}>Explain inputs</button>
              )}
              <span className="ml-auto flex gap-2">
                <button onClick={() => { resetJson(); void fillExample(name); }} disabled={example === 'loading'} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink-300 transition hover:border-ink-600 hover:text-white disabled:opacity-50">
                  <RefreshCw className={`h-3 w-3 ${example === 'loading' ? 'animate-spin' : ''}`} />Live example
                </button>
                <button onClick={() => { resetJson(); setValues({}); }} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink-300 transition hover:border-ink-600 hover:text-white">
                  <Eraser className="h-3 w-3" />Clear
                </button>
              </span>
            </div>

            {example === 'loading' && <p className="text-[13px] text-ink-400">Loading a live mainnet example…</p>}
            {example && example !== 'loading' && <p className="text-[13px] text-warning-200">No live example right now ({example}). Fill the inputs yourself.</p>}

            {mode === 'form'
              ? <ToolForm tool={tool} values={values} onChange={setValues} compact={!explain} />
              : (
                <div className="space-y-1.5">
                  <label htmlFor="toolbox-json" className="text-[13px] text-ink-400">The exact inputs sent with the request. Anything you type here is sent as it is, so you can also test how the tool handles bad input.</label>
                  <textarea id="toolbox-json" spellCheck={false} rows={Math.min(Math.max((jsonText ?? JSON.stringify(args, null, 2)).split('\n').length + 1, 6), 22)}
                    value={jsonText ?? JSON.stringify(args, null, 2)} onChange={(e) => onJson(e.target.value)}
                    className={`w-full resize-y rounded-xl border surface-inset px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink-100 outline-none transition focus:ring-4 ${jsonError ? 'border-danger-400/60 focus:ring-danger-500/15' : 'border-line focus:border-accent-400/70 focus:ring-accent-500/15'}`} />
                  {jsonError && <p className="text-[13px] text-danger-300">{jsonError}</p>}
                </div>
              )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button onClick={runCurrent} disabled={Boolean(running) || blocked} className={button('primary', 'md', 'flex-1 active:scale-[0.98] disabled:cursor-wait')}>
                {running === name ? <Activity className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{running === name ? 'Running…' : `Run ${tool.name}`}
              </button>
              <button onClick={() => void copySnippet()} aria-label={transport === 'http' ? 'Copy as cURL' : 'Copy the MCP request'} className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3.5 py-2.5 text-[13.5px] text-ink-300 transition hover:border-ink-600 hover:text-white">
                {copied ? <Check className="h-3.5 w-3.5 text-success-400" /> : <Copy className="h-3.5 w-3.5" />}{transport === 'http' ? 'cURL' : 'MCP'}
              </button>
            </div>
          </div>

          {/* Response */}
          <div aria-label="Response" className="min-w-0 p-4 sm:p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-[14px] font-semibold text-ink-200">Response</h2>
              {current && <span className="text-[12.5px] text-ink-500">{ago(current.at)} over {current.transport.toUpperCase()}</span>}
            </div>
            <ToolResult tool={tool} result={current?.result ?? null} running={running === name} />
          </div>
        </div>
      </section>

      {/* Every call made from this browser. */}
      <section aria-label="Your calls" className="mt-8 overflow-hidden rounded-3xl border border-line surface">
        <div className="wood-head flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-tan-200">Your calls <span className="readout font-normal text-tan-400">{list.length}</span></h2>
          <Segmented label="Show calls for" tone="wood" value={scope} onChange={setScope} options={[['all', 'All tools'], ['tool', tool.name]]} />
          {calls.length > 0 && (
            <button onClick={clearCalls} className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] transition ${clearArmed ? 'bg-danger-500/15 text-danger-300' : 'text-tan-400 hover:text-tan-200'}`}>
              <Trash2 className="h-3 w-3" />{clearArmed ? 'Clear all calls?' : 'Clear'}
            </button>
          )}
        </div>
        {list.length ? (
          <ul className="max-h-[30rem] divide-y divide-line overflow-y-auto">
            {list.map((call) => {
              const open = current?.id === call.id && call.tool === name;
              return (
                <li key={call.id} className={`relative flex items-center gap-2 pr-3 transition-colors hover:bg-ink-800/40 ${open ? 'bg-wood-950/60' : ''}`}>
                  {open && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-gold-400" />}
                  <button onClick={() => openCall(call)} title="Open this call to change its inputs" className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-5 text-left">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone(call.result.status)}`} aria-label={`HTTP ${call.result.status}`} />
                    <span className="w-36 shrink-0 truncate font-mono text-[13px] text-ink-100 max-sm:w-28">{call.tool}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-500">{argSummary(call.args)}</span>
                    <span className="readout shrink-0 text-[12.5px] text-ink-500 max-sm:hidden">{call.result.status} {call.transport.toUpperCase()}</span>
                    <span className="w-20 shrink-0 text-right text-[12.5px] text-ink-500">{ago(call.at)}</span>
                  </button>
                  <button onClick={() => openCall(call, true)} disabled={Boolean(running)} aria-label={`Run this ${call.tool} call again`} title="Run again"
                    className="shrink-0 rounded-lg p-1.5 text-ink-400 transition hover:bg-white/5 hover:text-gold-300 disabled:opacity-40">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-5 py-6 text-[14px] leading-[1.6] text-ink-400">
            {calls.length ? `No calls to ${tool.name} yet.` : 'Calls you run appear here and stay in this browser. Open one to change its inputs and run it again.'}
          </p>
        )}
      </section>
    </div>
  );
};
