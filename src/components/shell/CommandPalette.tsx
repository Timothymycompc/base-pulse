import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CornerDownLeft, Search } from 'lucide-react';
import { navigate } from '../../router';
import type { NavItem, NavSection } from '../../nav';

// ⌘K / Ctrl+K (or "/") search over every page and tool.
export const CommandPalette: React.FC<{ open: boolean; onClose: () => void; sections: NavSection[] }> = ({ open, onClose, sections }) => {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const all = sections.flatMap((s) => s.items.map((item) => ({ ...item, section: s.title })));
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const words = q.split(/\s+/);
    return all
      .map((item) => {
        const hay = `${item.title} ${item.path} ${item.keywords ?? ''} ${item.section}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        return { item, score: hits === words.length ? (item.title.toLowerCase().startsWith(q) ? 3 : item.title.toLowerCase().includes(q) ? 2 : 1) : 0 };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [sections, query]);

  useEffect(() => { if (open) { setQuery(''); setCursor(0); window.setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);
  useEffect(() => { setCursor(0); }, [query]);

  if (!open) return null;
  const go = (item: NavItem) => {
    onClose();
    if (item.external) window.open(item.path, '_blank', 'noopener');
    else navigate(item.path);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && items[cursor]) { e.preventDefault(); go(items[cursor]); }
    else if (e.key === 'Escape') onClose();
  };

  return (
    <div className="popup-scrim fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] animate-fade-in" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} className="popup animate-scale-in w-full max-w-2xl overflow-hidden rounded-2xl">
        <div className="wood-head flex items-center gap-2 px-4">
          <Search className="h-4 w-4 text-gold-400" />
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search tools and docs" aria-label="Search tools and docs"
            className="h-14 flex-1 bg-transparent text-[16px] text-ink-50 placeholder:text-tan-500 outline-none" />
          <kbd className="rounded border border-tan-500/40 px-1.5 py-0.5 text-[11px] text-tan-400">Esc</kbd>
        </div>
        <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-400">Nothing matches “{query}”. Try a tool name such as balance, or a word like wallet.</li>}
          {items.map((item, i) => (
            <li key={item.path} role="option" aria-selected={i === cursor}>
              <button onMouseEnter={() => setCursor(i)} onClick={() => go(item)}
                className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${i === cursor ? 'bg-ink-800/70 text-ink-50' : 'text-ink-300'}`}>
                {i === cursor && <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-gold-400" />}
                <span className={`w-28 shrink-0 truncate text-[12px] ${i === cursor ? 'text-tan-300' : 'text-ink-500'}`}>{item.section}</span>
                <span className="flex-1 truncate">{item.title}</span>
                {item.badge && <span className="text-[12px] tabular-nums text-ink-500">{item.badge}</span>}
                {item.external ? <ArrowUpRight className="h-3.5 w-3.5 text-ink-500" /> : i === cursor && <CornerDownLeft className="h-3.5 w-3.5 text-ink-500" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[12px] text-ink-500 max-sm:hidden">
          <span><kbd className="font-sans text-ink-300">↑ ↓</kbd> move</span>
          <span><kbd className="font-sans text-ink-300">Enter</kbd> open</span>
          <span><kbd className="font-sans text-ink-300">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
};
