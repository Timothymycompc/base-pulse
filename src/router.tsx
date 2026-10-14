import React, { useEffect, useState } from 'react';
import { withViewTransition } from './hooks/motion';

// Minimal path router: real URLs (/docs/tools/token_safety) so every page can be linked, bookmarked and indexed.
// The server returns index.html for unknown paths, so deep links load directly.

const LEGACY: Record<string, string> = {
  '#playground': '/toolbox',
  '#mcp': '/docs/connect',
  '#pricing': '/docs/pricing',
};

function currentPath(): string {
  const legacy = LEGACY[window.location.hash];
  if (legacy) return legacy;
  let path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/docs') path = '/docs/quickstart';
  return path;
}

const listeners = new Set<(path: string) => void>();

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  withViewTransition(() => {
    window.history.pushState(null, '', to);
    listeners.forEach((fn) => fn(currentPath()));
  });
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    // Normalize legacy hash links and /docs to their new addresses without adding history entries.
    const normalized = currentPath();
    if (normalized !== window.location.pathname) window.history.replaceState(null, '', normalized);
    const onChange = (p: string) => setPath(p);
    const onPop = () => withViewTransition(() => setPath(currentPath()));
    listeners.add(onChange);
    window.addEventListener('popstate', onPop);
    return () => { listeners.delete(onChange); window.removeEventListener('popstate', onPop); };
  }, []);
  return path;
}

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };
export const Link: React.FC<LinkProps> = ({ to, onClick, children, ...rest }) => (
  <a
    href={to}
    onClick={(e) => {
      onClick?.(e);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    }}
    {...rest}
  >
    {children}
  </a>
);
