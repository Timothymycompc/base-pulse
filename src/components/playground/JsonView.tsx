import React, { useMemo } from 'react';

// Colorizes pretty-printed JSON by tokenizing it into spans (no HTML injection).
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export const JsonView: React.FC<{ value: unknown; className?: string }> = ({ value, className }) => {
  const parts = useMemo(() => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (typeof value === 'string') return [text];
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      const i = m.index ?? 0;
      if (i > last) out.push(text.slice(last, i));
      const [whole, str, colon, bool, nul, num] = m;
      const cls = str ? (colon ? 'json-key' : 'json-string') : bool ? 'json-boolean' : nul ? 'json-null' : num ? 'json-number' : '';
      out.push(<span key={i} className={cls}>{str ?? whole}</span>);
      if (colon) out.push(colon);
      last = i + whole.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [value]);
  return <pre className={className}>{parts}</pre>;
};
