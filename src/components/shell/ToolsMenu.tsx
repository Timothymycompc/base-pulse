import React from 'react';
import { Link } from '../../router';
import { CATEGORY_ORDER, SAFETY_CHECKS, toolPath } from '../../nav';
import { CATEGORY_LABELS, type ToolDoc } from '../../lib/toolsApi';
import { Stamp } from '../ui/verdict';

// The Tools menu: the three safety checks first, in the order an agent runs them, then every other tool by category.
export const ToolsMenu: React.FC<{ tools: ToolDoc[] | null; path: string; onNavigate: () => void }> = ({ tools, path, onNavigate }) => {
  if (!tools) return <div className="grid gap-3 p-5 sm:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>;
  const byName = new Map<string, ToolDoc>(tools.map((t) => [t.name, t]));
  // Only the checks that are built; the panel appears once there are any.
  const checks = SAFETY_CHECKS.filter((c) => byName.has(c.name));
  const safety = new Set(checks.map((c) => c.name));
  const groups = CATEGORY_ORDER
    .map((category) => ({ category, tools: tools.filter((t) => t.category === category && !safety.has(t.name)) }))
    .filter((g) => g.tools.length);

  return (
    <div className={checks.length ? 'grid lg:grid-cols-[22rem_minmax(0,1fr)]' : ''}>
      {checks.length > 0 && <div className="wood-head p-5 lg:rounded-l-2xl" style={{ boxShadow: 'none' }}>
        <p className="text-[13px] font-semibold text-tan-300">Before money moves</p>
        <p className="mt-1 text-[13px] leading-snug text-tan-400">Run these in order, and sign only when they agree.</p>
        <ol className="mt-4 space-y-1.5">
          {checks.map((c, i) => {
            const t = byName.get(c.name);
            const active = path === toolPath(c.name);
            return (
              <li key={c.name}>
                <Link to={toolPath(c.name)} onClick={onNavigate}
                  className={`group grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 rounded-xl border p-3 transition-colors ${active ? 'border-gold-500/50 bg-wood-950/70' : 'border-transparent hover:border-tan-500/30 hover:bg-wood-950/50'}`}>
                  <span className="readout pt-0.5 text-[15px] text-gold-400">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[13px] text-gold-200">{c.name}</span>
                      <span className="readout text-[13px] text-tan-400">{t?.price ?? ''}</span>
                    </span>
                    <span className="mt-0.5 block text-[14px] leading-snug text-ink-100">{c.question}</span>
                    <span className="mt-2 flex flex-wrap gap-1.5">{c.verdicts.map((v) => <Stamp key={v} verdict={v} size="sm" />)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>}

      <div className="p-5">
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <div key={g.category}>
              <p className="mb-1.5 px-2 text-[12.5px] font-semibold text-tan-400">{CATEGORY_LABELS[g.category]}</p>
              <ul>
                {g.tools.map((t) => {
                  const active = path === toolPath(t.name);
                  return (
                    <li key={t.name}>
                      <Link to={toolPath(t.name)} onClick={onNavigate} aria-current={active ? 'page' : undefined}
                        className={`group flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04] ${active ? 'bg-white/[0.05]' : ''}`}>
                        <span className="min-w-0">
                          <span className={`block truncate text-[14.5px] ${active ? 'text-accent-200' : 'text-ink-100 group-hover:text-white'}`}>{t.title}</span>
                          <span className="block truncate font-mono text-[11.5px] text-ink-500">{t.name}</span>
                        </span>
                        <span className="readout shrink-0 text-[13px] text-ink-500">{t.price ?? 'Free'}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-[13.5px]">
          <Link to="/toolbox" onClick={onNavigate} className="font-medium text-accent-300 hover:text-accent-200">Run any tool in the toolbox</Link>
          <span className="text-ink-500">Every tool: 25 free calls a day, then a cent or two in USDC.</span>
        </div>
      </div>
    </div>
  );
};
