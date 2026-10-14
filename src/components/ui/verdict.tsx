import React from 'react';
import { CircleAlert, CircleCheck, CircleX, Info } from 'lucide-react';

// The videos' result vocabulary: a verdict stamp over a list of checks, each marked pass, fail, warn or info.
// Verdict colors are used for verdicts and nothing else.

const PASS = new Set(['OK', 'SAFE', 'MATCH', 'SUCCESS', 'PASS']);
const WARN = new Set(['REVIEW', 'CAUTION', 'WARN', 'PARTIAL']);
export type Tone = 'pass' | 'warn' | 'block';
export const verdictTone = (verdict: string): Tone => (PASS.has(verdict) ? 'pass' : WARN.has(verdict) ? 'warn' : 'block');

const TONE_TEXT: Record<Tone, string> = { pass: 'text-success-400', warn: 'text-warning-400', block: 'text-danger-400' };

export const Stamp: React.FC<{ verdict: string; size?: 'sm' | 'md' | 'lg'; className?: string; style?: React.CSSProperties }> = ({ verdict, size = 'md', className = '', style }) => {
  // Small stamps (lists of possible verdicts) stay quiet: outline only, so the one big stamp on a page leads.
  const sizes = { sm: 'stamp-quiet px-2 py-[3px] text-[11px]', md: 'px-3 py-1.5 text-[15px]', lg: 'px-4 py-2 text-[22px]' };
  return <span className={`stamp ${sizes[size]} ${TONE_TEXT[verdictTone(verdict)]} ${className}`} style={style}>{verdict}</span>;
};

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info';
const MARK: Record<CheckStatus, { Icon: React.ElementType; color: string; label: string }> = {
  pass: { Icon: CircleCheck, color: 'text-success-400', label: 'Passed' },
  fail: { Icon: CircleX, color: 'text-danger-400', label: 'Failed' },
  warn: { Icon: CircleAlert, color: 'text-warning-400', label: 'Warning' },
  info: { Icon: Info, color: 'text-ink-400', label: 'Note' },
};
export const isCheckStatus = (s: unknown): s is CheckStatus => typeof s === 'string' && s in MARK;

export const CheckLine: React.FC<{ status: CheckStatus; title?: React.ReactNode; children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ status, title, children, className = '', style }) => {
  const { Icon, color, label } = MARK[status];
  return (
    <li className={`flex gap-3 ${className}`} style={style}>
      <Icon aria-label={label} className={`mt-[0.2em] h-[1.15em] w-[1.15em] shrink-0 ${color}`} strokeWidth={2.25} />
      <span className="min-w-0">{title && <span className="font-semibold text-ink-50">{title}: </span>}{children}</span>
    </li>
  );
};
