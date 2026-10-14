import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, Compass, Search, Wrench, X } from 'lucide-react';
import { Link } from '../../router';
import { button } from '../ui/button';
import { DOCS_MENU, DOCS_PATHS, REPO_URL, TOP_LINKS, type NavSection } from '../../nav';
import type { ToolDoc } from '../../lib/toolsApi';
import { CommandPalette } from './CommandPalette';
import { ToolsMenu } from './ToolsMenu';
import { OnThisPage } from './OnThisPage';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
type Menu = 'tools' | 'docs' | null;

// The mark: a gauge face with a pulse across it, in brass.
export const PulseMark: React.FC<{ className?: string }> = ({ className = 'h-7 w-7' }) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <circle cx="16" cy="16" r="14.5" fill="var(--color-ink-900)" stroke="var(--color-accent-400)" strokeWidth="1.5" />
    <circle cx="16" cy="16" r="11" fill="none" stroke="var(--color-accent-700)" strokeWidth="1" strokeDasharray="1.2 3.1" />
    <path d="M7 17.5h4.2l2.3-6 3.4 11 2.4-7.2 1.4 2.2H25" fill="none" stroke="var(--color-accent-300)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const navItem = (active: boolean) =>
  `relative inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[14px] font-medium transition-colors ${active ? 'text-ink-50' : 'text-ink-300 hover:text-ink-50'}`;
const ActiveTick: React.FC = () => <span aria-hidden className="absolute inset-x-3 -bottom-[9px] h-px bg-gradient-to-r from-transparent via-accent-400 to-transparent" />;

const DocsMenu: React.FC<{ path: string; onNavigate: () => void }> = ({ path, onNavigate }) => (
  <div className="grid gap-6 p-5 sm:grid-cols-2">
    {DOCS_MENU.map((group) => (
      <div key={group.title}>
        <p className="mb-2 px-2 text-[12.5px] font-semibold text-tan-400">{group.title}</p>
        <ul className="space-y-0.5">
          {group.items.map((item) => {
            const inner = (
              <>
                <span className="flex items-center gap-1.5 text-[14.5px] font-medium text-ink-100 group-hover:text-white">
                  {item.title}{item.external && <ArrowUpRight className="h-3.5 w-3.5 text-ink-500" />}
                </span>
                <span className="mt-0.5 block text-[13px] leading-snug text-ink-400">{item.about}</span>
              </>
            );
            const cls = `group block rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.04] ${path === item.path ? 'bg-white/[0.04]' : ''}`;
            return <li key={item.path}>{item.external
              ? <a href={item.path} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
              : <Link to={item.path} onClick={onNavigate} className={cls}>{inner}</Link>}</li>;
          })}
        </ul>
      </div>
    ))}
  </div>
);

export const AppShell: React.FC<{ sections: NavSection[]; path: string; tools: ToolDoc[] | null; children: React.ReactNode }> = ({ sections, path, tools, children }) => {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [sheet, setSheet] = useState<'tools' | 'more' | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setMenu(null); setPaletteOpen((o) => !o); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setPaletteOpen(true); }
      else if (e.key === 'Escape') { setMenu(null); setSheet(null); }
    };
    const onDown = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setMenu(null); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, []);
  useEffect(() => { setMenu(null); setSheet(null); }, [path]);

  const toggle = (m: Exclude<Menu, null>) => setMenu((cur) => (cur === m ? null : m));
  const close = () => { setMenu(null); setSheet(null); };
  const onToolPage = path.startsWith('/docs/tools/');
  const docsActive = DOCS_PATHS.has(path);
  const withOutline = path.startsWith('/docs/') && !onToolPage;

  return (
    <div className="relative isolate min-h-screen bg-ink-950 text-ink-100">
      <div aria-hidden className="video-backdrop pointer-events-none fixed inset-0 -z-10" />

      {/* The floating bar, and the menus that open from it. */}
      <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-4">
        <div ref={barRef} className="relative mx-auto max-w-[78rem]">
          <div className="instrument-bar flex h-14 items-center gap-1 rounded-2xl pl-3 pr-2">
            <Link to="/" className="mr-3 flex shrink-0 items-center gap-2.5 rounded-lg" aria-label="Base Pulse home">
              <PulseMark />
              <span className="whitespace-nowrap text-[16px] font-semibold tracking-[-0.01em] text-ink-50" style={{ fontStretch: '112%' }}>Base Pulse</span>
            </Link>

            <nav aria-label="Main" className="hidden items-center md:flex">
              <button onClick={() => toggle('tools')} aria-expanded={menu === 'tools'} aria-haspopup="true" className={navItem(onToolPage || menu === 'tools')}>
                Tools<ChevronDown className={`h-3.5 w-3.5 text-ink-500 transition-transform duration-200 ${menu === 'tools' ? 'rotate-180' : ''}`} />
                {onToolPage && <ActiveTick />}
              </button>
              {TOP_LINKS.map((item) => (
                <Link key={item.path} to={item.path} aria-current={path === item.path ? 'page' : undefined} className={navItem(path === item.path)}>
                  {item.title}{path === item.path && <ActiveTick />}
                </Link>
              ))}
              <button onClick={() => toggle('docs')} aria-expanded={menu === 'docs'} aria-haspopup="true" className={navItem(docsActive || menu === 'docs')}>
                Docs<ChevronDown className={`h-3.5 w-3.5 text-ink-500 transition-transform duration-200 ${menu === 'docs' ? 'rotate-180' : ''}`} />
                {docsActive && <ActiveTick />}
              </button>
            </nav>

            <button onClick={() => { setMenu(null); setPaletteOpen(true); }} aria-label="Search tools and docs"
              className="ml-auto flex h-9 items-center gap-2 rounded-xl border border-line bg-code/60 px-2.5 text-[13.5px] text-ink-400 transition hover:border-line-strong hover:text-ink-200 lg:w-60">
              <Search className="h-4 w-4 shrink-0" /><span className="hidden flex-1 text-left lg:inline">Search</span>
              <kbd className="hidden rounded-md border border-line px-1.5 py-0.5 font-sans text-[11px] text-ink-500 lg:inline">{isMac ? '⌘' : 'Ctrl'} K</kbd>
            </button>
            <Link to="/docs/connect" className={button('primary', 'sm', 'ml-2 shrink-0 max-sm:hidden')}>Connect an agent</Link>
          </div>

          {menu && (
            <div className={`popup absolute top-[calc(100%+8px)] max-h-[calc(100vh-6rem)] origin-top animate-drop-in overflow-y-auto rounded-2xl ${menu === 'tools' ? 'inset-x-0' : 'left-1/2 w-[34rem] max-w-full -translate-x-1/2 md:left-auto md:right-48 md:translate-x-0'}`}>
              {menu === 'tools' ? <ToolsMenu tools={tools} path={path} onNavigate={close} /> : <DocsMenu path={path} onNavigate={close} />}
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-[78rem] px-4 pb-32 pt-24 sm:px-6 md:pb-16 lg:pt-28">
        <div className={withOutline ? 'grid gap-12 xl:grid-cols-[minmax(0,1fr)_13rem]' : ''}>
          <main key={path} style={{ viewTransitionName: 'page' }} className="min-w-0 animate-fade-in">{children}</main>
          {withOutline && <OnThisPage path={path} />}
        </div>

        <footer className="mt-24 grid gap-8 border-t border-line pt-8 text-[14px] text-ink-400 sm:grid-cols-[1fr_auto]">
          <div className="flex items-start gap-3">
            <PulseMark className="h-6 w-6 shrink-0" />
            <p className="max-w-[44ch] leading-relaxed">Base Pulse checks what an AI agent is about to sign, before money moves. Open source under the MIT license.</p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Link to="/docs/quickstart" className="hover:text-ink-100">Quickstart</Link>
            <Link to="/status" className="hover:text-ink-100">Live usage</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-ink-100">Source on GitHub</a>
            <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className="hover:text-ink-100">Request a tool or report an issue</a>
          </div>
        </footer>
      </div>

      {/* Phones: a dock at the thumb, and sheets that rise from it. */}
      <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-40 md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="instrument-bar grid h-16 grid-cols-4 rounded-2xl bg-ink-900 px-1">
          {([
            ['tools', 'Tools', Wrench],
            ['/toolbox', 'Toolbox', Compass],
            ['search', 'Search', Search],
            ['more', 'Docs', BookOpen],
          ] as const).map(([key, label, Icon]) => {
            const active = key === 'tools' ? sheet === 'tools' || onToolPage : key === 'more' ? sheet === 'more' || docsActive : key === '/toolbox' ? path === '/toolbox' : false;
            const cls = `flex flex-col items-center justify-center gap-1 rounded-xl text-[11.5px] font-medium transition-colors ${active ? 'text-accent-300' : 'text-ink-400'}`;
            const content = <><Icon className="h-5 w-5" strokeWidth={1.75} />{label}</>;
            if (key === '/toolbox') return <Link key={key} to={key} className={cls} aria-current={active ? 'page' : undefined}>{content}</Link>;
            return <button key={key} className={cls} aria-expanded={key === 'search' ? undefined : sheet === key}
              onClick={() => (key === 'search' ? (setSheet(null), setPaletteOpen(true)) : setSheet((s) => (s === key ? null : key)))}>{content}</button>;
          })}
        </div>
      </nav>
      {sheet && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-label={sheet === 'tools' ? 'Tools' : 'Docs'}>
          <div className="popup-scrim absolute inset-0 animate-fade-in" onClick={() => setSheet(null)} />
          <div className="popup absolute inset-x-0 bottom-0 max-h-[82vh] animate-sheet-up overflow-y-auto rounded-t-3xl pb-28">
            <div className="sticky top-0 z-10 flex items-center justify-between bg-ink-900/95 px-5 pb-2 pt-3 backdrop-blur">
              <span aria-hidden className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-ink-700" />
              <span className="pt-3 text-[16px] font-semibold text-ink-50">{sheet === 'tools' ? 'Tools' : 'Docs'}</span>
              <button onClick={() => setSheet(null)} aria-label="Close" className="mt-2 rounded-lg p-1.5 text-ink-400 hover:bg-white/5 hover:text-ink-100"><X className="h-5 w-5" /></button>
            </div>
            {sheet === 'tools' ? <ToolsMenu tools={tools} path={path} onNavigate={close} /> : (
              <>
                <div className="flex flex-col gap-1 px-5 pt-2">
                  {TOP_LINKS.map((item) => <Link key={item.path} to={item.path} onClick={close} className="rounded-lg py-2 text-[17px] font-medium text-ink-100">{item.title}</Link>)}
                </div>
                <DocsMenu path={path} onNavigate={close} />
                <div className="px-5"><Link to="/docs/connect" onClick={close} className={button('primary', 'md', 'w-full')}>Connect an agent</Link></div>
              </>
            )}
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} sections={sections} />
    </div>
  );
};
