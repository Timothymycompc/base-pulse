import React from 'react';
import { Link } from '../router';
import { toolPath } from '../nav';
import { Code, CodeBlock, H2, P, PageHeader, Table } from '../components/docs/DocParts';
import { PricingView } from '../components/PricingView';
import { ServiceUsagePanel } from '../components/ServiceUsagePanel';

const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const NETWORK = 'eip155:8453';

const NextLink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <Link to={to} className="inline-block text-[15px] text-accent-300 underline decoration-accent-300/30 underline-offset-4 transition hover:decoration-accent-300">{children}</Link>
);

export const QuickstartPage: React.FC = () => (
  <article className="max-w-3xl">
    <PageHeader title="Quickstart" lead="Make a real call in under a minute. No account, no API key; every tool gives you 25 free calls a day." />

    <H2>1. Make your first call</H2>
    <P>Every tool is a <Code>POST</Code> to <Code>/api/tools/&lt;name&gt;</Code> with a JSON body. This one reads a wallet's ETH and USDC on Base:</P>
    <CodeBlock title="Terminal" code={`curl -X POST '${origin()}/api/tools/balance' \
  -H 'content-type: application/json' \
  -d '{"wallet":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'`} />
    <P>The answer gives both balances, the block they were read at, and the RPC calls used.</P>
    <NextLink to={toolPath('balance')}>Try it live</NextLink>

    <H2>2. Give the tools to your agent</H2>
    <P>Connect any MCP client (Claude, Cursor, your own agent) to <Code>/mcp</Code> and all tools appear automatically, each with a "use when" line so the model knows when to call it.</P>
    <NextLink to="/docs/connect">Connect an agent</NextLink>

    <H2>3. Pay for heavy use</H2>
    <P>After a tool's 25 free calls for the day, it answers <Code>402 Payment Required</Code>. An x402 client pays the few-cent USDC price from a Base wallet and retries automatically.</P>
    <NextLink to="/docs/pricing">Pricing and x402 setup</NextLink>
  </article>
);

export const ConnectPage: React.FC = () => (
  <article className="max-w-3xl">
    <PageHeader title="Connect an agent" lead="Base Pulse is a Model Context Protocol (MCP) server. Connect once and every tool, with its documentation, is available to the model." />

    <H2>Endpoints</H2>
    <Table head={['Transport', 'URL']} minWidth={420} rows={[
      ['Streamable HTTP (recommended)', <Code>{`${origin()}/mcp`}</Code>],
      ['Server-Sent Events', <Code>{`${origin()}/mcp/sse`}</Code>],
    ]} />

    <H2>Claude</H2>
    <P>On claude.ai and in the Claude apps, open Customize, then Connectors, choose Add and then Add custom connector. Name it Base Pulse, paste the URL below, and pick No sign in. Free plans allow one custom connector.</P>
    <CodeBlock title="Connector URL" code={`${origin()}/mcp`} />
    <P>In Claude Code, run:</P>
    <CodeBlock title="Terminal" code={`claude mcp add --transport http base-pulse ${origin()}/mcp`} />

    <H2>ChatGPT</H2>
    <P>ChatGPT adds MCP servers as custom plugins, on the web only. It needs developer mode, which OpenAI offers on Business, Enterprise and Edu plans, and on Pro for read-only tools like these.</P>
    <ol className="mb-5 max-w-[68ch] list-decimal space-y-1.5 pl-5 text-[15px] leading-[1.7] text-ink-300 marker:text-ink-500">
      <li>Open ChatGPT Plugins, select the plus button and choose Add custom MCP server.</li>
      <li>Name it Base Pulse and paste the URL below as the Server URL.</li>
      <li>Set Authentication to No authentication, confirm the warning and select Create as a plugin.</li>
      <li>Install it from your plugins, then start a Work chat and type <Code>@</Code> to pick it.</li>
    </ol>
    <CodeBlock title="Server URL" code={`${origin()}/mcp`} />
    <P>ChatGPT calls tools from OpenAI's servers, so its users share the daily free calls, and it can't pay for calls beyond them itself.</P>

    <H2>Gemini CLI</H2>
    <P>Add the server for your user account, then check it shows as connected. Inside a session, <Code>/mcp</Code> lists its tools.</P>
    <CodeBlock title="Terminal" code={`gemini mcp add -s user --transport http base-pulse ${origin()}/mcp\ngemini mcp list`} />
    <P>Or add it by hand to <Code>~/.gemini/settings.json</Code>. Streamable HTTP servers use <Code>httpUrl</Code>, not <Code>url</Code>.</P>
    <CodeBlock title="settings.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { httpUrl: `${origin()}/mcp` } } }, null, 2)} />

    <H2>Antigravity</H2>
    <P>Antigravity CLI replaced Gemini CLI for free and Google One accounts. Type <Code>/mcp</Code> to open its MCP manager, or add the server to <Code>~/.gemini/config/mcp_config.json</Code> (or <Code>.agents/mcp_config.json</Code> for one project). Antigravity uses <Code>serverUrl</Code>; it ignores <Code>url</Code> and <Code>httpUrl</Code>. In the Antigravity editor, open the agent panel's menu, then MCP Servers, Manage MCP Servers and View raw config.</P>
    <CodeBlock title="mcp_config.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { serverUrl: `${origin()}/mcp` } } }, null, 2)} />

    <H2>Cursor</H2>
    <P>Add the server to <Code>~/.cursor/mcp.json</Code> (or <Code>.cursor/mcp.json</Code> for one project), then turn it on under Cursor Settings, MCP.</P>
    <CodeBlock title="mcp.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { url: `${origin()}/mcp` } } }, null, 2)} />

    <H2>VS Code (GitHub Copilot)</H2>
    <P>Run the command below, or add the server to <Code>.vscode/mcp.json</Code> in your project. VS Code uses <Code>servers</Code>, not <Code>mcpServers</Code>, and needs <Code>"type": "http"</Code>. The tools show up in Copilot Chat's agent mode.</P>
    <CodeBlock title="Terminal" code={`code --add-mcp '${JSON.stringify({ name: 'base-pulse', type: 'http', url: `${origin()}/mcp` })}'`} />
    <CodeBlock title=".vscode/mcp.json" code={JSON.stringify({ servers: { 'base-pulse': { type: 'http', url: `${origin()}/mcp` } } }, null, 2)} />

    <H2>Windsurf</H2>
    <P>Open Cascade's MCP settings and choose View raw config, or edit <Code>~/.codeium/windsurf/mcp_config.json</Code>. Windsurf uses <Code>serverUrl</Code>. Restart Windsurf after saving.</P>
    <CodeBlock title="mcp_config.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { serverUrl: `${origin()}/mcp` } } }, null, 2)} />

    <H2>Cline</H2>
    <P>Open Cline's MCP Servers panel, go to Configure and edit <Code>cline_mcp_settings.json</Code>. Without <Code>"type": "streamableHttp"</Code>, Cline treats the entry as a local command and fails to connect.</P>
    <CodeBlock title="cline_mcp_settings.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { type: 'streamableHttp', url: `${origin()}/mcp`, disabled: false } } }, null, 2)} />

    <H2>OpenAI Codex CLI</H2>
    <P>Add the server from the terminal, or put it in <Code>~/.codex/config.toml</Code>. Inside Codex, <Code>/mcp</Code> lists its tools.</P>
    <CodeBlock title="Terminal" code={`codex mcp add base-pulse --url ${origin()}/mcp\ncodex mcp list`} />
    <CodeBlock title="config.toml" code={`[mcp_servers.base-pulse]\nurl = "${origin()}/mcp"`} />

    <H2>Zed</H2>
    <P>Open your settings with <Code>zed: open settings file</Code>. Zed uses <Code>context_servers</Code>, not <Code>mcpServers</Code>; an entry with a <Code>url</Code> is a remote server.</P>
    <CodeBlock title="settings.json" code={JSON.stringify({ context_servers: { 'base-pulse': { url: `${origin()}/mcp` } } }, null, 2)} />

    <H2>OpenCode</H2>
    <P>Add the server to <Code>opencode.json</Code> in your project, or <Code>~/.config/opencode/opencode.json</Code> for every project.</P>
    <CodeBlock title="opencode.json" code={JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { 'base-pulse': { type: 'remote', url: `${origin()}/mcp` } } }, null, 2)} />

    <H2>Other clients that accept a URL</H2>
    <P>Most other MCP clients take the same shape. If a client only runs local commands, bridge it with <Code>npx mcp-remote {`${origin()}/mcp`}</Code>.</P>
    <CodeBlock title="mcp.json" code={JSON.stringify({ mcpServers: { 'base-pulse': { url: `${origin()}/mcp` } } }, null, 2)} />

    <H2>ElizaOS</H2>
    <P>Add the MCP plugin and this server to your character file. Every tool becomes an action your agent can call.</P>
    <CodeBlock title="character.json" code={JSON.stringify({ plugins: ['@elizaos/plugin-mcp'], settings: { mcp: { servers: { 'base-pulse': { type: 'streamable-http', url: `${origin()}/mcp` } } } } }, null, 2)} />

    <H2>An agent that can pay</H2>
    <P>Desktop apps can use every tool within its daily free calls. To go beyond them, build your agent with an x402-capable MCP client, which answers payment requests from a Base wallet holding USDC:</P>
    <CodeBlock title="TypeScript" code={`import { createx402MCPClient } from "@x402/mcp";\nimport { ExactEvmScheme } from "@x402/evm/exact/client";\nimport { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";\n\nconst client = createx402MCPClient({\n  name: "my-agent",\n  version: "1.0.0",\n  schemes: [{ network: "${NETWORK}", client: new ExactEvmScheme(signer) }],\n  autoPayment: true,\n});\nawait client.connect(new StreamableHTTPClientTransport(new URL("${origin()}/mcp")));\nconst result = await client.callTool("balance", { wallet: "<0x address>" });`} />

    <H2>Discovery files</H2>
    <Table head={['File', 'What it is']} minWidth={420} rows={[
      [<a className="font-mono text-[13px] text-accent-300 hover:text-accent-200" href="/.well-known/mcp.json">/.well-known/mcp.json</a>, 'Machine-readable manifest: tools, prices and payment details.'],
      [<a className="font-mono text-[13px] text-accent-300 hover:text-accent-200" href="/llms.txt">/llms.txt</a>, 'Plain-text guide for language models.'],
      [<a className="font-mono text-[13px] text-accent-300 hover:text-accent-200" href="/api/tools">/api/tools</a>, 'Every tool with full input and output documentation, as JSON.'],
    ]} />
  </article>
);

export const CallsPage: React.FC = () => (
  <article className="max-w-3xl">
    <PageHeader title="What is a call?" lead="A call is one question you send to the gateway and the one answer you get back. Ask “how much ETH is in this wallet?” and you get the number. That round trip is one call." />

    <H2>What one looks like</H2>
    <P>Each kind of question has its own tool. You send the details as JSON, and the answer comes back as structured data a program or AI agent can read.</P>
    <CodeBlock title="The question" code={`POST ${origin()}/api/tools/balance\n{ "wallet": "<wallet_address>" }`} />
    <CodeBlock title="The answer" code={`{
  "wallet": "<wallet_address>",
  "network": "base",
  "eth": "1.5",
  "eth_wei": "1500000000000000000",
  "usdc": "25.0",
  "block": 36500000
}`} />
    <P>AI agents make the same calls over MCP: instead of a web address, the agent picks a tool by name, such as <Code>balance</Code>, and gets the same answer.</P>

    <H2>What calls cost</H2>
    <P>Every tool, including this balance call, gives each caller 25 free calls a day, then costs $0.01 in USDC ($0.02 for the three safety checks), paid with the request itself through x402. Calls that end in an error are never charged and never use up a free call.</P>

    <H2>How a call travels: think of a restaurant</H2>
    <Table head={['In a restaurant', 'In the gateway']} minWidth={480} rows={[
      [<><b className="text-ink-100">The customer</b> wants something</>, <><b className="text-ink-100">The client</b>: your app or AI agent</>],
      [<><b className="text-ink-100">The menu</b> lists every dish</>, <><b className="text-ink-100">The API</b>: the list of tools and how to ask</>],
      [<><b className="text-ink-100">A dish</b> has its own name</>, <><b className="text-ink-100">An endpoint</b>: one address, one job, like <Code>/api/tools/balance</Code></>],
      [<><b className="text-ink-100">The cashier</b> checks you can order</>, <><b className="text-ink-100">Free calls and payment</b>: counts free calls, then checks the x402 payment</>],
      [<><b className="text-ink-100">The chef</b> cooks</>, <><b className="text-ink-100">The logic</b>: validates inputs and does the work</>],
      [<><b className="text-ink-100">The supplier</b> delivers ingredients</>, <><b className="text-ink-100">The blockchain</b>: Base, read live</>],
      [<><b className="text-ink-100">The plate</b> arrives</>, <><b className="text-ink-100">The response</b>: structured JSON, usually in well under a second</>],
    ]} />

    <H2>Glossary</H2>
    <Table head={['Term', 'Meaning']} minWidth={420} rows={[
      [<b className="text-ink-100">API</b>, 'Everything the gateway can do and the format for asking.'],
      [<b className="text-ink-100">Endpoint</b>, 'A single address that does one job.'],
      [<b className="text-ink-100">Request / response</b>, 'What you send, and what comes back.'],
      [<b className="text-ink-100">MCP server</b>, 'A menu written for AI agents, so they can find and call tools themselves.'],
      [<b className="text-ink-100">x402</b>, 'An open standard for paying per request, here in USDC on Base.'],
    ]} />
    <NextLink to="/docs/quickstart">Make your first call</NextLink>
  </article>
);

export const PricingPage: React.FC = () => <PricingView />;

export const StatusPage: React.FC = () => (
  <article>
    <PageHeader title="Live usage" lead="Real tool runs, callers and uptime pings, counted without storing IP addresses. Tool inputs and results are kept for 30 days to improve the tools." />
    <ServiceUsagePanel />
  </article>
);

export const NotFoundPage: React.FC = () => (
  <article className="max-w-xl">
    <PageHeader title="Page not found" lead="That page doesn't exist. Use the sidebar, or press ⌘K to search every page and tool." />
    <NextLink to="/">Back to the overview</NextLink>
  </article>
);
