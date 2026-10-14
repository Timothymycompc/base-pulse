import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleDollarSign, Clock3, ExternalLink, Eye, KeyRound, LogOut, Radio, RefreshCw, Users, Wallet } from 'lucide-react';
import { PageHeader, H2 } from '../components/docs/DocParts';
import { button } from '../components/ui/button';
import { loadOwnerOverview, OwnerKeyError, ownerKeyStore, type CallerStats, type Kind, type OwnerOverview, type ToolStats } from '../lib/ownerApi';

// Owner dashboard: revenue per tool, who calls each tool, and real site visitors. Data needs the owner key.

const RANGES = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];

// Caller kinds in stack and legend order. "No user agent" folds into "Other". Colors are the --color-kind-* tokens in index.css.
type ShownKind = Exclude<Kind, 'unknown'>;
const SHOWN: ShownKind[] = ['you', 'bot', 'ai_app', 'script', 'browser', 'other'];
const LABEL: Record<ShownKind, string> = { you: 'You', bot: 'Indexer or uptime bot', ai_app: 'AI app', script: 'Script or SDK', browser: 'Browser', other: 'Other or unnamed' };
const COLOR: Record<ShownKind, string> = {
  you: 'var(--color-kind-you)', bot: 'var(--color-kind-bot)', ai_app: 'var(--color-kind-ai-app)',
  script: 'var(--color-kind-script)', browser: 'var(--color-kind-browser)', other: 'var(--color-kind-other)',
};
const shown = (k: Kind): ShownKind => (k === 'unknown' ? 'other' : k);
const byShownKind = (byKind: Record<Kind, number>) => SHOWN.map((k) => ({ kind: k, n: k === 'other' ? byKind.other + byKind.unknown : byKind[k] }));

const num = new Intl.NumberFormat();
const usd = (v: number) => (v === 0 ? '$0' : v < 1 ? `$${v.toFixed(2)}` : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
function ago(iso: string | null) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Hover tooltip shared by every chart on the page.
type Tip = { x: number; y: number; lines: React.ReactNode[] } | null;
const TipContext = React.createContext<(t: Tip) => void>(() => {});
const useTip = () => React.useContext(TipContext);
const tipHandlers = (setTip: (t: Tip) => void, lines: React.ReactNode[]) => ({
  onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, lines }),
  onMouseLeave: () => setTip(null),
});
const TipLayer: React.FC<{ tip: Tip }> = ({ tip }) => tip && (
  <div role="tooltip" className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-white/15 bg-ink-900/95 px-3 py-2 text-[11px] leading-5 text-ink-200 shadow-xl backdrop-blur"
    style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: tip.y + 14 }}>
    {tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'font-semibold text-white' : ''}>{l}</div>)}
  </div>
);

const Swatch: React.FC<{ kind: ShownKind }> = ({ kind }) => <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: COLOR[kind] }} />;

const Legend: React.FC = () => (
  <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-300">
    {SHOWN.map((k) => <li key={k} className="flex items-center gap-1.5"><Swatch kind={k} />{LABEL[k]}</li>)}
  </ul>
);

// One tool's runs as a bar: length is total runs (against the busiest tool), segments are who made them.
const KindBar: React.FC<{ tool: ToolStats; max: number }> = ({ tool, max }) => {
  const setTip = useTip();
  const parts = byShownKind(tool.byKind).filter((p) => p.n > 0);
  const width = max ? Math.max(2, (tool.runs / max) * 100) : 0;
  if (!tool.runs) return <span className="text-[11px] text-ink-500">No runs</span>;
  return (
    <div className="flex h-5 items-center gap-[2px]" style={{ width: `${width}%` }} aria-label={parts.map((p) => `${LABEL[p.kind]} ${p.n}`).join(', ')}>
      {parts.map((p) => (
        <div key={p.kind} className="flex h-full min-w-[3px] items-center" style={{ flexGrow: p.n, flexBasis: 0 }}
          {...tipHandlers(setTip, [`${tool.tool} · ${LABEL[p.kind]}`, `${num.format(p.n)} of ${num.format(tool.runs)} runs (${Math.round((p.n / tool.runs) * 100)}%)`])}>
          <div className="h-2.5 w-full rounded-[3px]" style={{ background: COLOR[p.kind] }} />
        </div>
      ))}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ElementType }> = ({ label, value, sub, icon: Icon }) => (
  <div className="px-4 py-4 sm:px-5">
    <div className="flex items-center gap-2 text-[12.5px] text-ink-400"><Icon className="h-3.5 w-3.5 text-accent-300" />{label}</div>
    <div className="display mt-2 text-[1.9rem] font-bold tabular-nums">{value}</div>
    {sub && <div className="mt-1 text-[11px] text-ink-400">{sub}</div>}
  </div>
);

const StatRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-2 divide-x divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10 surface sm:grid-cols-4 sm:divide-y-0">{children}</div>
);

const Card: React.FC<{ title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, aside, children, className = '' }) => (
  <section className={`overflow-hidden rounded-xl border border-white/10 surface ${className}`}>
    {(title || aside) && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
      <h3 className="text-[14px] font-semibold text-ink-100">{title}</h3>{aside}
    </div>}
    {children}
  </section>
);

const KindTag: React.FC<{ kind: Kind }> = ({ kind }) => (
  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-300"><Swatch kind={shown(kind)} />{LABEL[shown(kind)]}</span>
);

const Solscan: React.FC<{ kind: 'tx' | 'account'; id: string; label?: string }> = ({ kind, id, label }) => (
  <a href={`https://solscan.io/${kind}/${id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-accent-300 hover:text-accent-200">
    {label ?? short(id)}<ExternalLink className="h-3 w-3 opacity-60" />
  </a>
);

const th = 'px-3 py-2';
const td = 'px-3 py-2.5 align-top';
const TableShell: React.FC<{ head: string[]; children: React.ReactNode; minWidth?: number }> = ({ head, children, minWidth = 640 }) => (
  <div className="table-scroll">
    <table className="data-table text-[12px] text-ink-300" style={{ minWidth }}>
      <thead className="text-[12px]"><tr>{head.map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

// ---------- Revenue and runs per tool ----------

const ToolRow: React.FC<{ tool: ToolStats; max: number; callers: CallerStats[]; days: number }> = ({ tool, max, callers, days }) => {
  const [open, setOpen] = useState(false);
  const toolCallers = useMemo(() => callers
    .map((c) => ({ c, runs: c.tools.find((t) => t.tool === tool.tool)?.runs ?? 0 }))
    .filter((x) => x.runs > 0).sort((a, b) => b.runs - a.runs), [callers, tool.tool]);
  return (
    <>
      <tr className={`row-button ${open ? 'row-open' : ''} ${tool.known ? '' : 'opacity-70'}`} onClick={() => setOpen((o) => !o)}>
        <td className={td}>
          <button aria-expanded={open} className="flex items-center gap-1.5 text-left font-mono text-[12px] text-ink-100">
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-500 transition ${open ? '' : '-rotate-90'}`} />{tool.tool}
          </button>
          <div className="ml-5 mt-0.5 text-[11.5px] text-ink-500">{tool.known ? `${tool.price ?? 'Free'} · ${num.format(tool.http)} HTTP · ${num.format(tool.mcp)} MCP` : 'Not a current tool'}</div>
        </td>
        <td className={`${td} tabular-nums`}>
          <div className="text-ink-100">{usd(tool.revenueWindowUsdc)}</div>
          <div className="text-[11.5px] text-ink-500">{usd(tool.revenueUsdc)} all time · {usd(tool.revenueOthersUsdc)} from others</div>
        </td>
        <td className={`${td} tabular-nums`}>
          <div className="text-ink-100">{num.format(tool.runs)}</div>
          <div className="text-[11.5px] text-ink-500">{num.format(tool.callers)} caller{tool.callers === 1 ? '' : 's'}</div>
        </td>
        <td className={`${td} w-[38%]`}><KindBar tool={tool} max={max} /></td>
        <td className={`${td} tabular-nums text-[11px] leading-5`}>
          <div>{num.format(tool.paymentsWindow)} paid</div>
          <div className="text-ink-500">{num.format(tool.freeCalls)} free · {num.format(tool.paymentAsked)} asked to pay{tool.errors ? ` · ${num.format(tool.errors)} errors` : ''}</div>
        </td>
      </tr>
      {open && <tr className="row-detail">
        <td colSpan={5} className="px-3 py-3">
          <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
            <dl className="space-y-1 text-[11px]">
              {byShownKind(tool.byKind).map((p) => <div key={p.kind} className="flex items-center justify-between gap-3"><dt className="flex items-center gap-1.5"><Swatch kind={p.kind} />{LABEL[p.kind]}</dt><dd className="tabular-nums text-ink-100">{num.format(p.n)}</dd></div>)}
              <div className="flex justify-between gap-3 border-t border-white/10 pt-1"><dt>Your owner-key calls</dt><dd className="tabular-nums text-ink-100">{num.format(tool.ownerCalls)}</dd></div>
              <div className="flex justify-between gap-3"><dt>Last run</dt><dd className="tabular-nums text-ink-100">{ago(tool.lastRunAt)}</dd></div>
            </dl>
            <div>
              <p className="mb-1.5 text-[12.5px] font-semibold text-ink-300">Who ran it in the last {days === 1 ? '24 hours' : `${days} days`}</p>
              {toolCallers.length ? <ul className="divide-y divide-white/[0.06] text-[12px]">
                {toolCallers.slice(0, 12).map(({ c, runs }) => <li key={c.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="flex min-w-0 items-center gap-2"><Swatch kind={shown(c.kind)} /><span className="truncate text-ink-100">{c.name}</span>{c.network && <span className="font-mono text-[11.5px] text-ink-500">net {c.network}</span>}</span>
                  <span className="shrink-0 text-[12px] tabular-nums">{num.format(runs)} run{runs === 1 ? '' : 's'}</span>
                </li>)}
              </ul> : <p className="text-[12px] text-ink-500">Nobody ran this tool in this period.</p>}
            </div>
          </div>
        </td>
      </tr>}
    </>
  );
};

const ToolsSection: React.FC<{ data: OwnerOverview }> = ({ data }) => {
  const [showIdle, setShowIdle] = useState(false);
  const max = Math.max(0, ...data.tools.map((t) => t.runs));
  const visible = data.tools.filter((t) => showIdle || t.runs > 0 || t.payments > 0);
  const idle = data.tools.length - data.tools.filter((t) => t.runs > 0 || t.payments > 0).length;
  return (
    <Card title="Revenue and callers per tool" aside={idle > 0 && <button onClick={() => setShowIdle((s) => !s)} className="text-[11px] text-ink-400 hover:text-white">{showIdle ? 'Hide' : 'Show'} {idle} tool{idle === 1 ? '' : 's'} with no runs</button>}>
      <div className="px-4 pt-3"><Legend /></div>
      <TableShell head={['Tool', 'Revenue', 'Runs', 'Who ran it', 'Calls']} minWidth={820}>
        {visible.map((t) => <ToolRow key={t.tool} tool={t} max={max} callers={data.callers} days={data.days} />)}
      </TableShell>
      <p className="px-4 py-3 text-[11.5px] leading-4 text-ink-500">Revenue is for the selected period; all-time and from-others totals are underneath. "Asked to pay" is a call that got the x402 price instead of running, which is how directory bots check prices. Click a tool for its callers.</p>
    </Card>
  );
};

// ---------- Callers ----------

const CallersSection: React.FC<{ data: OwnerOverview }> = ({ data }) => {
  const [filter, setFilter] = useState<ShownKind | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const counts = SHOWN.map((k) => ({
    kind: k,
    callers: k === 'other' ? data.kinds.other.callers + data.kinds.unknown.callers : data.kinds[k].callers,
    runs: k === 'other' ? data.kinds.other.runs + data.kinds.unknown.runs : data.kinds[k].runs,
  }));
  const rows = data.callers.filter((c) => filter === 'all' || shown(c.kind) === filter);
  const chip = (active: boolean) => `rounded-full border px-2.5 py-1 text-[11px] transition ${active ? 'border-accent-400/60 bg-accent-500/15 text-white' : 'border-white/10 text-ink-400 hover:border-white/25 hover:text-ink-100'}`;
  return (
    <Card title={`${num.format(data.callerCount)} callers`}>
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <button className={chip(filter === 'all')} onClick={() => setFilter('all')}>All</button>
        {counts.map((c) => <button key={c.kind} className={`${chip(filter === c.kind)} inline-flex items-center gap-1.5`} onClick={() => setFilter(c.kind)}>
          <Swatch kind={c.kind} />{LABEL[c.kind]} <span className="tabular-nums text-ink-500">{num.format(c.callers)} · {num.format(c.runs)} runs</span>
        </button>)}
      </div>
      <TableShell head={['Caller', 'Kind', 'Tool runs', 'Other requests', 'Paid', 'Most used', 'Last seen']} minWidth={860}>
        {rows.slice(0, 80).map((c) => <React.Fragment key={c.id}>
          <tr className={`row-button ${openId === c.id ? 'row-open' : ''}`} onClick={() => setOpenId(openId === c.id ? null : c.id)}>
            <td className={td}>
              <div className="flex items-center gap-1.5 text-ink-100">
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-500 transition ${openId === c.id ? '' : '-rotate-90'}`} />
                <span className="max-w-[14rem] truncate">{c.name}</span>
                {c.homepage && <a href={c.homepage} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`${c.name} homepage`} className="text-ink-500 hover:text-accent-300"><ExternalLink className="h-3 w-3" /></a>}
              </div>
              <div className="ml-5 text-[11.5px] text-ink-500">{c.network ? `network ${c.network}` : 'many networks'}</div>
            </td>
            <td className={td}><KindTag kind={c.kind} /></td>
            <td className={`${td} tabular-nums text-ink-100`}>{num.format(c.runs)}{c.errors ? <span className="text-ink-500"> · {num.format(c.errors)} err</span> : null}</td>
            <td className={`${td} tabular-nums`}>{num.format(c.pings + c.reads)}</td>
            <td className={`${td} tabular-nums`}>{c.paidCalls ? `${usd(c.paidUsdc)} · ${num.format(c.paidCalls)}` : '—'}</td>
            <td className={`${td} font-mono text-[11px]`}>{c.tools.slice(0, 2).map((t) => `${t.tool} ${t.runs}`).join(', ') || '—'}</td>
            <td className={`${td} whitespace-nowrap`}>{ago(c.lastSeen)}</td>
          </tr>
          {openId === c.id && <tr className="row-detail"><td colSpan={7} className="space-y-1 px-3 py-3 text-[11px]">
            <div><span className="text-ink-500">User agent: </span><code className="break-all font-mono text-ink-200">{c.userAgent || 'none sent'}</code></div>
            {c.mcpClient && <div><span className="text-ink-500">MCP client name: </span><code className="font-mono text-ink-200">{c.mcpClient}</code></div>}
            <div><span className="text-ink-500">First seen </span>{new Date(c.firstSeen).toLocaleString()} · <span className="text-ink-500">MCP pings </span>{num.format(c.pings)} · <span className="text-ink-500">other reads </span>{num.format(c.reads)}</div>
            {c.tools.length > 0 && <div><span className="text-ink-500">Tools: </span><span className="font-mono">{c.tools.map((t) => `${t.tool} ${t.runs}`).join(' · ')}</span></div>}
          </td></tr>}
        </React.Fragment>)}
      </TableShell>
      <p className="px-4 py-3 text-[11.5px] leading-4 text-ink-500">A caller is a network plus the client it says it is; bots are grouped by name across all the networks they probe from. "You" is any network this dashboard was opened from, or a call made with the owner key. Networks are shown as the first characters of a keyed hash, never the IP address.</p>
    </Card>
  );
};

// ---------- Payments ----------

const PaymentsSection: React.FC<{ data: OwnerOverview }> = ({ data }) => (
  <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
    <Card title="Recent payments">
      {data.recentPayments.length ? <TableShell head={['When', 'Tool', 'Amount', 'Payer', 'Called by']} minWidth={620}>
        {data.recentPayments.map((p) => <tr key={p.txSignature}>
          <td className={`${td} whitespace-nowrap`} title={new Date(p.at).toLocaleString()}><Solscan kind="tx" id={p.txSignature} label={ago(p.at)} /></td>
          <td className={`${td} font-mono`}>{p.tool}</td>
          <td className={`${td} tabular-nums text-ink-100`}>{usd(p.amountUsdc)}</td>
          <td className={td}><Solscan kind="account" id={p.payer} />{p.mine && <span className="ml-1.5 text-[11.5px] text-ink-500">your wallet</span>}</td>
          <td className={td}>{p.caller ? <span className="flex items-center gap-1.5"><Swatch kind={shown(p.caller.kind)} /><span className="text-ink-100">{p.caller.name}</span></span> : <span className="text-ink-500">Before caller tracking</span>}</td>
        </tr>)}
      </TableShell> : <p className="px-4 py-6 text-[12px] text-ink-500">No payments yet.</p>}
    </Card>
    <Card title={`${num.format(data.revenue.payers)} payers`}>
      <ul className="divide-y divide-white/[0.06] text-[12px]">
        {data.payers.slice(0, 15).map((p) => <li key={p.payer} className="flex items-center justify-between gap-3 px-4 py-2">
          <span className="min-w-0"><Solscan kind="account" id={p.payer} />{p.mine && <span className="ml-1.5 text-[11.5px] text-ink-500">you</span>}
            <span className="block text-[11.5px] text-ink-500">{num.format(p.payments)} payment{p.payments === 1 ? '' : 's'} · {p.tools} tool{p.tools === 1 ? '' : 's'} · last {ago(p.lastAt)}</span></span>
          <span className="shrink-0 tabular-nums text-ink-100">{usd(p.usdc)}</span>
        </li>)}
        {!data.payers.length && <li className="px-4 py-6 text-ink-500">No payers yet.</li>}
      </ul>
    </Card>
  </div>
);

// ---------- Visitors ----------

const VisitorBars: React.FC<{ v: OwnerOverview['visitors'] }> = ({ v }) => {
  const setTip = useTip();
  const max = Math.max(1, ...v.series.map((s) => s.visitors));
  const label = (iso: string) => v.bucket === 'hour'
    ? new Date(iso).toLocaleTimeString([], { hour: 'numeric' })
    : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const ticks = [0, Math.floor((v.series.length - 1) / 2), v.series.length - 1];
  return (
    <div className="px-4 pb-3 pt-4">
      <div className="relative h-36">
        <div aria-hidden className="absolute inset-x-0 top-0 border-t border-dashed border-white/[0.07]" />
        <span aria-hidden className="absolute right-0 top-0 -translate-y-full pb-0.5 text-[11px] tabular-nums text-ink-500">{num.format(max)}</span>
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-white/15">
          {v.series.map((s) => (
            <div key={s.start} className="flex h-full min-w-0 flex-1 items-end"
              {...tipHandlers(setTip, [label(s.start), `${num.format(s.visitors)} visitor${s.visitors === 1 ? '' : 's'}`, `${num.format(s.views)} page view${s.views === 1 ? '' : 's'}`])}>
              <div className="w-full rounded-t-[4px]" style={{ height: s.visitors ? `${Math.max(2, (s.visitors / max) * 100)}%` : 0, background: 'var(--color-kind-bot)' }} />
            </div>
          ))}
        </div>
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] tabular-nums text-ink-500">
        {ticks.filter((t, i, a) => a.indexOf(t) === i).map((t, i) => <span key={t} className="absolute" style={i === 0 ? { left: 0 } : i === ticks.length - 1 ? { right: 0 } : { left: '50%', transform: 'translateX(-50%)' }}>{label(v.series[t].start)}</span>)}
      </div>
    </div>
  );
};

const RankList: React.FC<{ rows: { label: string; value: number; sub?: string }[]; empty: string }> = ({ rows, empty }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.length ? <ul className="space-y-2 px-4 py-3 text-[12px]">
    {rows.map((r) => <li key={r.label}>
      <div className="flex items-baseline justify-between gap-3"><span className="truncate text-ink-200">{r.label}</span><span className="shrink-0 font-mono text-ink-400">{num.format(r.value)}{r.sub ? ` · ${r.sub}` : ''}</span></div>
      <div className="mt-1 h-1.5 rounded-[3px]" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: 'var(--color-kind-bot)' }} />
    </li>)}
  </ul> : <p className="px-4 py-6 text-[12px] text-ink-500">{empty}</p>;
};

const VisitorsSection: React.FC<{ data: OwnerOverview }> = ({ data }) => {
  const v = data.visitors;
  const period = data.days === 1 ? '24 hours' : `${data.days} days`;
  return (
    <div className="space-y-4">
      <StatRow>
        <Stat label="On the site now" value={num.format(v.liveNow)} sub={`${num.format(v.last30Minutes)} in the last 30 minutes`} icon={Radio} />
        <Stat label="Visitors, 24 hours" value={num.format(v.visitors24h)} sub={`${num.format(v.views24h)} page views`} icon={Users} />
        <Stat label={`Visitors, ${period}`} value={num.format(v.visitors)} sub={`${num.format(v.views)} page views`} icon={Eye} />
        <Stat label="Phones and computers" value={`${num.format(v.mobile)} / ${num.format(v.desktop)}`} sub={`Left out: ${num.format(v.botViews)} bot, ${num.format(v.ownViews)} yours`} icon={Users} />
      </StatRow>
      <Card title={`Visitors per ${v.bucket}, last ${period}`}><VisitorBars v={v} /></Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Top pages"><RankList rows={v.pages.map((p) => ({ label: p.path, value: p.views, sub: `${num.format(p.visitors)} ppl` }))} empty="No visits yet." /></Card>
        <Card title="Came from"><RankList rows={v.referrers.map((r) => ({ label: r.host, value: r.views }))} empty="No visits yet." /></Card>
        <Card title="Browsers"><RankList rows={v.devices.map((d) => ({ label: d.name, value: d.visitors }))} empty="No visits yet." /></Card>
      </div>
      <Card title="Latest visits">
        {v.recent.length ? <TableShell head={['When', 'Page', 'Came from', 'Browser', 'Visitor']} minWidth={560}>
          {v.recent.slice(0, 15).map((r, i) => <tr key={i}>
            <td className={`${td} whitespace-nowrap`} title={new Date(r.at).toLocaleString()}>{ago(r.at)}</td>
            <td className={`${td} font-mono text-ink-100`}>{r.path}</td>
            <td className={td}>{r.referrer ?? '—'}</td>
            <td className={td}>{r.device}</td>
            <td className={`${td} tabular-nums text-ink-500`}>{r.visitor ?? '—'}</td>
          </tr>)}
        </TableShell> : <p className="px-4 py-6 text-[12px] text-ink-500">No visits recorded yet. Counting starts with this release.</p>}
      </Card>
      <p className="text-[11.5px] leading-4 text-ink-500">A visitor is one network seen running the site in a browser; crawlers that don't run the page's script never count, and bots that do are left out. Your own networks are left out too.</p>
    </div>
  );
};

// ---------- Recent runs ----------

const OUTCOME: Record<string, string> = { paid: 'Paid', payment_asked: 'Asked to pay', error: 'Error', free_call: 'Free call', owner_key: 'Owner key', ok: 'Ran' };
type Run = OwnerOverview['recentRuns'][number];
const pretty = (v: unknown) => (v === null || v === undefined ? 'Not saved' : JSON.stringify(v, null, 2));
const RunRow: React.FC<{ r: Run }> = ({ r }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={`row-button ${open ? 'row-open' : ''}`} onClick={() => setOpen((o) => !o)}>
        <td className={`${td} whitespace-nowrap`} title={new Date(r.at).toLocaleString()}>
          <button aria-expanded={open} className="flex items-center gap-1.5 text-left">
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-500 transition ${open ? '' : '-rotate-90'}`} />{ago(r.at)}
          </button>
        </td>
        <td className={`${td} font-mono text-ink-100`}>{r.tool}</td>
        <td className={`${td} text-[12px]`}>{r.transport.toUpperCase()}</td>
        <td className={td}>{OUTCOME[r.outcome] ?? r.outcome}{r.outcome === 'error' ? <span className="font-mono text-ink-500"> {r.status}</span> : null}</td>
        <td className={td}><span className="flex items-center gap-1.5"><Swatch kind={shown(r.caller.kind)} /><span className="truncate text-ink-100">{r.caller.name}</span></span></td>
      </tr>
      {open && <tr className="row-detail">
        <td colSpan={5} className="px-3 py-3">
          <div className="grid gap-4 md:grid-cols-2">
            {([['Input', r.input], ['Output', r.output]] as const).map(([label, value]) => <div key={label} className="min-w-0">
              <p className="mb-1.5 text-[12.5px] font-semibold text-ink-300">{label}</p>
              <pre className="max-h-80 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11.5px] leading-5 text-ink-100">{pretty(value)}</pre>
            </div>)}
          </div>
        </td>
      </tr>}
    </>
  );
};
const RecentRuns: React.FC<{ data: OwnerOverview }> = ({ data }) => (
  <Card title="Latest tool runs">
    {data.recentRuns.length ? <TableShell head={['When', 'Tool', 'Via', 'Result', 'Caller']} minWidth={560}>
      {data.recentRuns.slice(0, 25).map((r, i) => <RunRow key={`${r.at}-${i}`} r={r} />)}
    </TableShell> : <p className="px-4 py-6 text-[12px] text-ink-500">No tool runs in this period.</p>}
  </Card>
);

const SignIn: React.FC<{ error: string; onSubmit: (key: string, remember: boolean) => void }> = ({ error, onSubmit }) => {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  return (
    <form className="max-w-md space-y-3 rounded-xl border border-white/10 p-5 surface" onSubmit={(e) => { e.preventDefault(); if (key.trim()) onSubmit(key.trim(), remember); }}>
      <label className="block text-sm font-medium text-white" htmlFor="owner-key">Owner key</label>
      <input id="owner-key" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-accent-400" placeholder="OWNER_API_KEY" />
      <label className="flex items-center gap-2 text-[12px] text-ink-300"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Stay signed in on this device</label>
      {error && <p role="alert" className="text-[12px] text-danger-300">{error}</p>}
      <button type="submit" className={button('primary', 'md')}><KeyRound className="h-4 w-4" />Open dashboard</button>
      <p className="text-[11px] leading-5 text-ink-500">The key is the OWNER_API_KEY secret. Get it with <code className="font-mono">gcloud secrets versions access latest --secret=OWNER_API_KEY</code>. It stays in this browser and is only sent to this site.</p>
    </form>
  );
};

export const OwnerPage: React.FC = () => {
  const [key, setKey] = useState(ownerKeyStore.get);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<OwnerOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tip, setTip] = useState<Tip>(null);

  const refresh = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      setData(await loadOwnerOverview(key, days));
      setError('');
    } catch (e) {
      if (e instanceof OwnerKeyError) { ownerKeyStore.clear(); setKey(''); setData(null); }
      setError(e instanceof Error ? e.message : 'The dashboard could not load.');
    } finally {
      setLoading(false);
    }
  }, [key, days]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Keep this page out of search results.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots'; meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const signOut = () => { ownerKeyStore.clear(); setKey(''); setData(null); setError(''); };
  const r = data?.revenue;
  const period = days === 1 ? '24 hours' : `${days} days`;

  return (
    <TipContext.Provider value={setTip}>
      <article className="space-y-6">
        <PageHeader title="Owner dashboard"
          lead="Revenue per tool, who calls each one, and the people visiting the site. Only you can open this page."
          aside={key ? <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Period" className="flex overflow-hidden rounded-lg border border-white/10">
              {RANGES.map((o) => <button key={o.days} onClick={() => setDays(o.days)} aria-pressed={days === o.days}
                className={`px-2.5 py-1.5 text-[11px] transition ${days === o.days ? 'bg-white/10 text-white' : 'text-ink-400 hover:text-white'}`}>{o.label}</button>)}
            </div>
            <button onClick={() => void refresh()} aria-label="Refresh" className={button('secondary', 'sm')}><RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /></button>
            <button onClick={signOut} className={button('ghost', 'sm')}><LogOut className="h-3 w-3" />Sign out</button>
          </div> : undefined} />

        {!key ? <SignIn error={error} onSubmit={(k, remember) => { ownerKeyStore.set(k, remember); setError(''); setKey(k); }} />
          : !data ? (error ? <p role="alert" className="rounded-lg border border-danger-400/30 bg-danger-500/10 p-4 text-sm text-danger-100">{error}</p>
            : <div className="space-y-4"><div className="skeleton h-24 rounded-xl" /><div className="skeleton h-80 rounded-xl" /></div>)
          : <>
            {error && <p role="status" className="text-[12px] text-warning-300">Could not refresh: {error} Showing the last numbers.</p>}
            <p className="flex items-center gap-1.5 text-[11px] text-ink-500"><Clock3 className="h-3 w-3" />Updated {new Date(data.generatedAt).toLocaleTimeString()}. Refreshes every 30 seconds.</p>
            <StatRow>
              <Stat label={`Revenue from others, ${period}`} value={usd(r!.fromOthersWindowUsdc)} sub={`${usd(r!.windowUsdc)} with your test payments`} icon={CircleDollarSign} />
              <Stat label="Revenue from others, all time" value={usd(r!.fromOthersUsdc)} sub={`${usd(r!.allTimeUsdc)} in total · ${num.format(r!.payments)} payments`} icon={Wallet} />
              <Stat label="Revenue, 24 hours" value={usd(r!.last24hUsdc)} sub={`${num.format(r!.paymentsWindow)} payments in ${period}`} icon={CircleDollarSign} />
              <Stat label="Payers besides you" value={num.format(r!.otherPayers)} sub={`${num.format(r!.payers)} wallets have paid`} icon={Users} />
            </StatRow>

            <ToolsSection data={data} />

            <H2 id="callers">Callers</H2>
            <CallersSection data={data} />

            <H2 id="payments">Payments</H2>
            <PaymentsSection data={data} />

            <H2 id="visitors">Site visitors</H2>
            <VisitorsSection data={data} />

            <H2 id="runs">Latest tool runs</H2>
            <RecentRuns data={data} />
          </>}
      </article>
      <TipLayer tip={tip} />
    </TipContext.Provider>
  );
};
