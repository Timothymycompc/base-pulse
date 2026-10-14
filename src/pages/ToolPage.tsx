import React from 'react';
import { ArrowLeft, ArrowRight, PiggyBank, ShieldCheck } from 'lucide-react';
import { Link } from '../router';
import { toolPath } from '../nav';
import { CATEGORY_LABELS, type ToolsIndex } from '../lib/toolsApi';
import { Code, H2, PageHeader, P, Table } from '../components/docs/DocParts';
import { TryItPanel } from '../components/playground/TryItPanel';

export const ToolPage: React.FC<{ name: string; index: ToolsIndex }> = ({ name, index }) => {
  const i = index.tools.findIndex((t) => t.name === name);
  const tool = index.tools[i];
  if (!tool) return <PageHeader title="Tool not found" lead={<>There is no tool called <Code>{name}</Code>. Use the sidebar or press ⌘K to search.</>} />;
  const prev = index.tools[i - 1];
  const next = index.tools[i + 1];

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <article className="min-w-0">
        <PageHeader
          kicker={<><span className="font-sans text-tan-400">{CATEGORY_LABELS[tool.category]}</span><span className="mx-2 text-ink-600">/</span>{tool.name}</>}
          title={tool.title}
          aside={<span className="mb-1.5 inline-flex flex-col items-end"><span className="readout text-[26px] leading-none text-accent-300">{tool.price ?? 'Free'}</span><span className="mt-1 text-[12.5px] text-ink-500">per call after 25 free a day</span></span>}
          lead={tool.description}
        />

        <div className="mb-10 grid max-w-[72ch] gap-4">
          <p className="text-[17px] leading-[1.65] text-ink-100">{tool.useWhen}</p>
          <div className="flex gap-3 rounded-2xl border border-accent-500/25 bg-gradient-to-br from-wood-950/80 to-panel p-5 text-[15px] leading-[1.6] text-ink-300">
            {tool.benefit.kind === 'money' ? <PiggyBank className="mt-0.5 h-5 w-5 shrink-0 text-accent-300" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-300" />}
            <span><strong className="font-semibold text-ink-50">{tool.benefit.kind === 'money' ? 'Saves money. ' : 'Keeps the model from guessing. '}</strong>{tool.benefit.text}</span>
          </div>
        </div>

        <H2 id="endpoints">Call it</H2>
        <Table head={['Transport', 'How']} minWidth={420} rows={[
          ['HTTP', <><Code>POST /api/tools/{tool.name}</Code> with a JSON body of the inputs below.</>],
          ['MCP', <><Code>tools/call</Code> with name <Code>{tool.name}</Code> on <Code>/mcp</Code>.</>],
        ]} />

        <H2 id="inputs">Inputs</H2>
        <Table head={['Name', "What it's looking for", 'Where to get it']} rows={tool.inputs.map((input) => [
          <><Code>{input.name}</Code><div className="mt-1 text-[12.5px] text-ink-500">{input.type}, {input.required ? 'required' : 'optional'}</div></>,
          input.lookingFor,
          input.whereToGet,
        ])} />

        <H2 id="returns">Returned fields</H2>
        <P>Every field the tool returns, what it is, and exactly how it's worked out.</P>
        <Table head={['Field', 'What it is', "How it's worked out"]} minWidth={640} rows={tool.outputs.map((o) => [
          <><Code>{o.field}</Code><div className="mt-1 text-[12.5px] text-ink-500">{o.type}</div></>,
          <span className="text-ink-200">{o.is}</span>,
          o.howWorkedOut,
        ])} />

        {tool.notes.length > 0 && (<>
          <H2 id="notes">Limits</H2>
          <ul className="mb-6 max-w-[72ch] list-disc space-y-2 pl-5 text-[15px] leading-[1.65] text-ink-300 marker:text-ink-600">{tool.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </>)}

        <nav aria-label="More tools" className="mt-16 grid gap-3 sm:grid-cols-2">
          {prev ? <Link to={toolPath(prev.name)} className="group rounded-2xl border border-line surface p-5 transition hover:border-accent-500/40"><span className="flex items-center gap-1 text-[12.5px] text-ink-500"><ArrowLeft className="h-3 w-3" />Previous tool</span><span className="mt-1 block text-[15px] font-medium text-ink-100 group-hover:text-white">{prev.title}</span></Link> : <span />}
          {next && <Link to={toolPath(next.name)} className="group rounded-2xl border border-line surface p-5 text-right transition hover:border-accent-500/40"><span className="flex items-center justify-end gap-1 text-[12.5px] text-ink-500">Next tool<ArrowRight className="h-3 w-3" /></span><span className="mt-1 block text-[15px] font-medium text-ink-100 group-hover:text-white">{next.title}</span></Link>}
        </nav>
      </article>

      <aside className="min-w-0 xl:sticky xl:top-24 xl:max-h-[calc(100vh-7rem)] xl:self-start xl:overflow-y-auto">
        <TryItPanel key={tool.name} tool={tool} freeCallsPerTool={index.freeCallsPerTool} />
      </aside>
    </div>
  );
};
