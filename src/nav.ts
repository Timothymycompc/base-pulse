import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, loadTools, type ToolDoc, type ToolsIndex } from './lib/toolsApi';

export type NavItem = { title: string; path: string; badge?: string; keywords?: string; external?: boolean };
export type NavSection = { title: string; items: NavItem[] };

export const REPO_URL = 'https://github.com/Timothymycompc/base-pulse';

const GUIDE_PAGES: NavItem[] = [
  { title: 'Overview', path: '/', keywords: 'home start intro' },
  { title: 'Quickstart', path: '/docs/quickstart', keywords: 'curl http first request example' },
  { title: 'Toolbox', path: '/toolbox', keywords: 'playground try run every tool edit inputs json history calls' },
  { title: 'What is a call?', path: '/docs/calls', keywords: 'api request response beginner restaurant glossary' },
  { title: 'Connect an agent', path: '/docs/connect', keywords: 'mcp claude claude-code chatgpt openai gemini antigravity cursor elizaos agentkit coinbase config agent' },
];
const PAYMENT_PAGES: NavItem[] = [
  { title: 'Pricing & x402', path: '/docs/pricing', keywords: 'price usdc pay payment free calls x402' },
  { title: 'Live usage', path: '/status', keywords: 'stats usage analytics callers' },
];
const RESOURCE_LINKS: NavItem[] = [
  { title: 'llms.txt', path: '/llms.txt', external: true },
  { title: 'mcp.json', path: '/.well-known/mcp.json', external: true },
  { title: 'Tool reference (JSON)', path: '/api/tools', external: true },
  { title: 'Request a tool / report an issue', path: `${REPO_URL}/issues`, external: true },
];

// The top bar: the menus and links people use most. Everything else is in search (⌘K).
export const TOP_LINKS: NavItem[] = [
  { title: 'Toolbox', path: '/toolbox' },
  { title: 'Connect', path: '/docs/connect' },
  { title: 'Pricing', path: '/docs/pricing' },
];
export const DOCS_MENU: { title: string; items: (NavItem & { about: string })[] }[] = [
  { title: 'Learn', items: [
    { title: 'Quickstart', path: '/docs/quickstart', about: 'A real call in under a minute' },
    { title: 'What is a call?', path: '/docs/calls', about: 'Requests and answers, explained with a restaurant' },
    { title: 'Live usage', path: '/status', about: 'Tool runs and callers, as they happen' },
  ] },
  { title: 'For machines', items: [
    { title: 'llms.txt', path: '/llms.txt', external: true, about: 'A plain-text guide for language models' },
    { title: 'mcp.json', path: '/.well-known/mcp.json', external: true, about: 'Tools, prices and payment details' },
    { title: 'Tool reference', path: '/api/tools', external: true, about: 'Every input and output, as JSON' },
  ] },
];
export const DOCS_PATHS = new Set(['/docs/quickstart', '/docs/calls', '/status']);

// The checks an agent runs before money moves, in the order it runs them. Menus show only the ones that are built.
export const SAFETY_CHECKS = [
  { name: 'token_safety', question: 'Is this token safe to buy or accept?', verdicts: ['SAFE', 'CAUTION', 'AVOID'] },
  { name: 'tx_matches', question: 'Does it do exactly what was asked, and nothing else?', verdicts: ['MATCH', 'MISMATCH'] },
  { name: 'check_tx', question: 'What will this transaction do to each wallet?', verdicts: ['OK', 'REVIEW', 'BLOCK'] },
];

export const toolPath = (name: string) => `/docs/tools/${name}`;
export const CATEGORY_ORDER: ToolDoc['category'][] = ['transactions', 'tokens', 'wallets', 'network', 'reference'];

export function buildSections(tools: ToolDoc[] | null): NavSection[] {
  const toolSections: NavSection[] = CATEGORY_ORDER.map((category) => ({
    title: CATEGORY_LABELS[category],
    items: (tools ?? []).filter((t) => t.category === category).map((t) => ({ title: t.title, path: toolPath(t.name), badge: t.price ?? 'Free', keywords: `${t.name} ${t.useWhen}` })),
  })).filter((s) => s.items.length);
  return [{ title: 'Get started', items: GUIDE_PAGES }, ...toolSections, { title: 'Payments', items: PAYMENT_PAGES }, { title: 'Resources', items: RESOURCE_LINKS }];
}

// Loads the tool registry once and shares it.
export function useToolsIndex() {
  const [index, setIndex] = useState<ToolsIndex | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { loadTools().then(setIndex).catch((e) => setError(e.message)); }, []);
  return { index, error };
}
