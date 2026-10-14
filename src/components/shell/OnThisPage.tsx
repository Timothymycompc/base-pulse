import React, { useEffect, useState } from 'react';

type Heading = { id: string; text: string };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The page's section headings, with the one you're reading marked. Reads the h2s the page rendered, giving any
// heading without an id one made from its text, so every section can also be linked to.
export const OnThisPage: React.FC<{ path: string }> = ({ path }) => {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    const timer = window.setTimeout(() => {
      const els = Array.from(document.querySelectorAll<HTMLHeadingElement>('main h2'));
      const seen = new Set<string>();
      const list = els.map((el) => {
        let id = el.id || slug(el.textContent ?? '');
        while (seen.has(id)) id += '-2';
        seen.add(id);
        el.id = id;
        el.style.scrollMarginTop = '6rem';
        return { id, text: (el.textContent ?? '').replace(/^\d+\.\s*/, '') };
      });
      setHeadings(list);
      setCurrent(list[0]?.id ?? '');
      // The section whose heading most recently passed under the bar is the one being read.
      observer = new IntersectionObserver((entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      }, { rootMargin: '-90px 0px -65% 0px' });
      els.forEach((el) => observer!.observe(el));
    }, 60);
    return () => { window.clearTimeout(timer); observer?.disconnect(); };
  }, [path]);

  if (headings.length < 3) return null;
  return (
    <nav aria-label="On this page" className="hidden xl:block">
      <div className="sticky top-28 max-h-[calc(100vh-8rem)] overflow-y-auto border-l border-line">
        <p className="mb-2 pl-4 text-[12.5px] font-semibold text-tan-400">On this page</p>
        <ul className="space-y-0.5 text-[13.5px]">
          {headings.map((h) => (
            <li key={h.id}>
              <a href={`#${h.id}`} aria-current={current === h.id ? 'location' : undefined}
                onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#${h.id}`); setCurrent(h.id); }}
                className={`relative -ml-px block border-l py-1 pl-4 leading-snug transition-colors ${current === h.id ? 'border-accent-400 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-200'}`}>
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
};
