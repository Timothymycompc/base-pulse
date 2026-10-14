// Caller classification on user agents seen in the gateway's request logs (October 2026). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClient } from "../server/callers";

const kindOf = (ua: string | null, mcp?: string) => {
  const c = classifyClient(ua, mcp);
  return `${c.kind}: ${c.name}`;
};

test("directory, uptime and x402 indexer bots are bots, named after themselves", () => {
  assert.equal(kindOf("mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)"), "bot: mcpbeat");
  assert.equal(kindOf("SentinelOracle/0.1 (+https://glimind.com/opt-out; liveness-only, never invokes tools)"), "bot: SentinelOracle");
  assert.equal(kindOf("PayAI-Bazaar/1.0 (+https://docs.payai.network/x402/facilitators/bazaar)"), "bot: PayAI-Bazaar");
  assert.equal(kindOf("InvokeRankBot/0.1 (+https://invokerank.com/bot; bot@invokerank.com)"), "bot: InvokeRankBot");
  assert.equal(kindOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), "bot: ClaudeBot");
  assert.equal(kindOf("Mozilla/5.0 (compatible; Agent402/1.0; +https://github.com/MikeyPetrillo/Agent402)"), "bot: Agent402");
  assert.equal(kindOf("mcp.market uptime check (+https://mcp.market/docs/rubric)"), "bot: mcp.market uptime check");
  assert.equal(kindOf("Pennywise-Candidate-Verifier/1.0"), "bot: Pennywise-Candidate-Verifier");
  assert.equal(kindOf("Enerlio GmbH FACTANKER marc@enerlio.de"), "bot: Enerlio GmbH FACTANKER");
  assert.equal(kindOf("Mozilla/5.0"), "bot: Unnamed crawler");
});

test("AI apps are told apart from the same company's crawlers", () => {
  assert.equal(kindOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)"), "ai_app: Claude");
  assert.equal(kindOf("claude-code/2.1 (mcp-probe)"), "ai_app: Claude Code");
  assert.equal(kindOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot)"), "bot: OAI-SearchBot");
  assert.equal(kindOf("Google-NotebookLM"), "ai_app: NotebookLM");
});

test("the MCP client name sent on initialize names the app behind a generic HTTP library", () => {
  assert.equal(kindOf("node", "claude-ai 0.1.0"), "ai_app: Claude");
  assert.equal(kindOf("python-httpx/0.28.1", "cursor-vscode 1.0.0"), "ai_app: Cursor");
  assert.equal(kindOf("node", "my-trading-agent 2.0"), "script: my-trading-agent 2.0 (Node.js fetch)");
  assert.equal(kindOf(null, "my-trading-agent 2.0"), "other: my-trading-agent 2.0");
});

test("HTTP libraries are scripts, browsers are browsers, the rest is named", () => {
  assert.equal(kindOf("curl/8.14.1"), "script: curl");
  assert.equal(kindOf("Python/3.11 aiohttp/3.14.4"), "script: Python aiohttp");
  assert.equal(kindOf("node"), "script: Node.js fetch");
  assert.equal(kindOf("Go-http-client/2.0"), "script: Go net/http");
  assert.equal(kindOf("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"), "browser: Chrome on Android");
  assert.equal(kindOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"), "browser: Safari on iOS");
  assert.equal(kindOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:127.0) Gecko/20100101 Firefox/127.0"), "browser: Firefox on macOS");
  assert.equal(kindOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36"), "bot: HeadlessChrome");
  assert.equal(kindOf("Helius-Webhook-Service/1.0"), "other: Helius-Webhook-Service");
  assert.equal(kindOf(""), "unknown: No user agent");
});
