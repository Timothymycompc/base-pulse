// Who is calling: sorts a request's user agent (and, for MCP, the client name it sent on initialize) into a kind
// the owner dashboard can count. Directory and uptime bots make most of the traffic; the rest is people and their code.

export type CallerKind = "bot" | "ai_app" | "script" | "browser" | "other" | "unknown";
export type CallerInfo = { kind: CallerKind; name: string; homepage: string | null };

export const KIND_LABELS: Record<CallerKind | "you", string> = {
  you: "You",
  bot: "Indexer or uptime bot",
  ai_app: "AI app",
  script: "Script or SDK",
  browser: "Browser",
  other: "Other named client",
  unknown: "No user agent",
};

// AI apps and agent frameworks, checked before bots: "Claude-User" is a person using Claude, "ClaudeBot" is a crawler.
const AI_APPS: [RegExp, string][] = [
  [/claude[- ]?code/i, "Claude Code"],
  [/claude[- ]?desktop/i, "Claude Desktop"],
  [/claude-user|claude-ai|^claude\b|anthropic/i, "Claude"],
  [/chatgpt-user|openai-mcp|^openai|chatgpt/i, "ChatGPT"],
  [/gemini/i, "Gemini"],
  [/perplexity-user/i, "Perplexity"],
  [/cursor/i, "Cursor"],
  [/windsurf|codeium/i, "Windsurf"],
  [/\bcline\b/i, "Cline"],
  [/\bgoose\b/i, "Goose"],
  [/\bzed\b/i, "Zed"],
  [/copilot|visual studio code|vscode/i, "VS Code"],
  [/mcp-remote/i, "mcp-remote"],
  [/elizaos|eliza/i, "ElizaOS"],
  [/agentkit|coinbase/i, "AgentKit"],
  [/langchain|langgraph/i, "LangChain"],
  [/\bn8n\b/i, "n8n"],
  [/notebooklm/i, "NotebookLM"],
];
const NOT_AN_APP = /bot\b|bot\/|crawler|spider|searchbot/i;

// Anything that says it is a bot, probe, crawler or monitor, or leaves a homepage or contact address the way bots do.
const BOT = /bot\b|bot\/|bot;|crawl|spider|probe|collector|monitor|uptime|liveness|health|check|scan|harvest|research|registry|census|verif|watch|tripwire|observatory|index|archive|rank|trust|bazaar|headless|lighthouse|slurp|preview|fetcher|whatsapp|facebookexternalhit|\(\+|\+https?:|\+mailto|mailto:|[\w.-]+@[\w-]+\.\w+/i;

const SCRIPTS: [RegExp, string][] = [
  [/^curl\//i, "curl"],
  [/^wget\//i, "Wget"],
  [/python-requests/i, "Python requests"],
  [/python-httpx|^httpx/i, "Python httpx"],
  [/aiohttp/i, "Python aiohttp"],
  [/python-urllib/i, "Python urllib"],
  [/^python\b/i, "Python"],
  [/^node$|^node\//i, "Node.js fetch"],
  [/^undici/i, "Node.js undici"],
  [/^node-fetch/i, "node-fetch"],
  [/^axios/i, "axios"],
  [/^got\b/i, "got"],
  [/^deno\//i, "Deno"],
  [/^bun\//i, "Bun"],
  [/go-http-client/i, "Go net/http"],
  [/okhttp/i, "OkHttp"],
  [/^java\/|apache-httpclient/i, "Java"],
  [/^ruby|faraday/i, "Ruby"],
  [/guzzle|^php/i, "PHP"],
  [/reqwest/i, "Rust reqwest"],
  [/^dalvik\//i, "Android app"],
  [/postmanruntime/i, "Postman"],
  [/insomnia/i, "Insomnia"],
  [/httpie/i, "HTTPie"],
];

const homepageOf = (ua: string) => ua.match(/https?:\/\/[^\s;)]+/)?.[0] ?? null;

// The product name a client calls itself: "mcpbeat/1.2 (+https://…)" → "mcpbeat", "…; compatible; ClaudeBot/1.0; …" → "ClaudeBot".
function productName(ua: string): string {
  // Ignore URLs and contact addresses, so ".../bot" in a homepage link is not taken as the name.
  const botToken = ua.replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+/g, "").match(/\b([A-Za-z][\w.-]{2,}bot)\b/i)?.[1];
  if (botToken) return botToken;
  const headless = ua.match(/\b(Headless\w+)/)?.[1];
  if (headless) return headless;
  const compatible = ua.match(/compatible;\s*([^;/)]+)/i)?.[1]?.trim();
  if (/^mozilla/i.test(ua) && compatible) return compatible.slice(0, 40);
  return ua.replace(/\s*[\w.+-]+@[\w.-]+/g, "").split(/\s*[/(]/)[0].trim().slice(0, 40) || ua.slice(0, 40);
}

function browserName(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /CrOS/.test(ua) ? "ChromeOS"
    : /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "macOS" : /Linux|X11/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const isMobile = (ua: string | null) => /Mobile|Android|iPhone|iPod/.test(ua ?? "");

function fromName(text: string): CallerInfo | null {
  if (!NOT_AN_APP.test(text)) {
    const app = AI_APPS.find(([re]) => re.test(text));
    if (app) return { kind: "ai_app", name: app[1], homepage: null };
  }
  if (BOT.test(text)) return { kind: "bot", name: productName(text), homepage: homepageOf(text) };
  return null;
}

// mcpClient is the clientInfo name an MCP client sent on initialize ("claude-ai", "cursor-vscode"); it names the
// app better than a generic HTTP library user agent does.
export function classifyClient(userAgent: string | null | undefined, mcpClient?: string | null): CallerInfo {
  const ua = (userAgent ?? "").trim();
  const viaApp = ua ? fromName(ua) : null;
  if (viaApp) return viaApp;
  const viaMcp = mcpClient ? fromName(mcpClient) : null;
  if (viaMcp) return viaMcp;
  if (!ua) return mcpClient ? { kind: "other", name: mcpClient.slice(0, 40), homepage: null } : { kind: "unknown", name: "No user agent", homepage: null };
  const script = SCRIPTS.find(([re]) => re.test(ua));
  if (script) return { kind: "script", name: mcpClient ? `${mcpClient.slice(0, 30)} (${script[1]})` : script[1], homepage: null };
  if (/^Mozilla\/5\.0 \((Windows|Macintosh|X11|Linux|iPhone|iPad|Android|CrOS)/.test(ua) && /(Chrome|Safari|Firefox)\//.test(ua)) {
    return { kind: "browser", name: browserName(ua), homepage: null };
  }
  // "Mozilla/5.0 (compatible)" and similar with nothing else to go on are automated.
  if (/^mozilla\/[\d.]+( \(compatible\))?$/i.test(ua)) return { kind: "bot", name: "Unnamed crawler", homepage: null };
  return { kind: "other", name: productName(ua), homepage: homepageOf(ua) };
}
