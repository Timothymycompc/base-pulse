import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCountUp } from '../hooks/motion';

interface ServiceUsage {
  toolRuns24h: number;
  callers24h: number;
  otherCallers24h: number;
  otherToolRuns7d: number;
  otherCallers7d: number;
  pings24h: number;
  lastToolRunAt: string | null;
  tools: { endpoint: string; runs: number; otherCallers: number; lastRunAt: string }[];
  note: string;
}

const number = new Intl.NumberFormat();
const CountUp: React.FC<{ value: number }> = ({ value }) => <>{number.format(useCountUp(value))}</>;

export const ServiceUsagePanel: React.FC = () => {
  const [usage, setUsage] = useState<ServiceUsage | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/analytics/usage', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Usage counts are unavailable');
      setUsage(body);
      setUpdatedAt(new Date());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const stats = [
    { label: 'Tool runs in the last 24 hours', value: usage ? <CountUp value={usage.toolRuns24h} /> : '—' },
    { label: 'Callers besides you, 24 hours', value: usage ? <CountUp value={usage.otherCallers24h} /> : '—' },
    { label: `Runs by others this week, from ${usage ? number.format(usage.otherCallers7d) : '—'} callers`, value: usage ? <CountUp value={usage.otherToolRuns7d} /> : '—' },
    { label: 'Uptime pings, 24 hours', value: usage ? <CountUp value={usage.pings24h} /> : '—' },
  ];

  return (
    <section aria-labelledby="usage-heading" className="overflow-hidden rounded-2xl border border-line surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-2 pt-5 sm:px-6">
        <div>
          <h2 id="usage-heading" className="display text-[1.6rem] font-bold">Live usage</h2>
          <p className="mt-1 text-[13px] text-ink-500">Counted from real requests and refreshed every 15 seconds.</p>
        </div>
        <button onClick={() => void refresh()} aria-label="Refresh live usage" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-500 transition hover:bg-white/5 hover:text-ink-200">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : 'Refresh'}
        </button>
      </div>
      {failed && !usage ? <p role="status" className="px-6 py-6 text-[14px] text-ink-400">Live usage can't be loaded right now. It will appear once the usage service responds; refresh to try again.</p> : <>
        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {stats.map(({ label, value }) => <div key={label} className="flex flex-col-reverse justify-end bg-panel px-5 py-5 sm:px-6">
            <dt className="mt-1 text-[13px] leading-[1.45] text-ink-400">{label}</dt>
            <dd className="display text-[2rem] font-bold tabular-nums">{value}</dd>
          </div>)}
        </dl>
        <div className="px-5 py-5 sm:px-6">
          <h3 className="mb-2 flex items-baseline justify-between gap-3 text-[14px] font-semibold text-ink-200"><span>Most used tools this week</span><span className="text-[12px] font-normal text-ink-500">runs, and callers besides you</span></h3>
          {usage?.tools.length ? <ul className="grid gap-x-10 sm:grid-cols-2">
            {usage.tools.slice(0, 6).map((tool) => <li key={tool.endpoint} className="flex min-w-0 items-baseline justify-between gap-3 border-t border-line py-2">
              <code className="truncate font-mono text-[12.5px] text-ink-300">{tool.endpoint}</code>
              <span className="shrink-0 text-[13px] tabular-nums text-ink-400">{number.format(tool.runs)} <span className="text-ink-600">/</span> {number.format(tool.otherCallers)}</span>
            </li>)}
          </ul> : <p className="py-3 text-[13px] text-ink-500">{loading ? 'Loading tool counts…' : 'No tool runs recorded in the last 7 days.'}</p>}
          {usage?.note && <p className="mt-4 max-w-[80ch] text-[12.5px] leading-[1.55] text-ink-500">{usage.note}</p>}
        </div>
      </>}
    </section>
  );
};
