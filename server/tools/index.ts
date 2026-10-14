// The tool registry: one definition per tool drives MCP, HTTP, docs, llms.txt, mcp.json and the playground.
import { z } from "zod";
import { TOKEN_TOOLS } from "./tokens";
import { WALLET_TOOLS } from "./wallet";
import type { ToolDef } from "./types";
import { FREE_CALLS_TEXT, priceOf } from "../pricing";

export const TOOLS: ToolDef[] = [...TOKEN_TOOLS, ...WALLET_TOOLS];
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t] as [string, ToolDef]));

export const priceText = (name: string) => {
  const price = priceOf(name);
  return price ? `${FREE_CALLS_TEXT}, then ${price} USDC per call (x402)` : "Free (rate-limited)";
};

// What an MCP client sees: use-when line first, then what it does, inputs, and cost.
export function mcpDescription(tool: ToolDef): string {
  const inputs = tool.inputDocs.map((i) => `${i.name}${i.required ? "" : " (optional)"}: ${i.lookingFor}`).join(" ");
  return `${tool.useWhen} ${tool.description} Inputs: ${inputs} Cost: ${priceText(tool.name)}. Full field-by-field docs: GET /api/tools/${tool.name}.`;
}

// Public documentation for one tool (everything except the code).
export function toolDoc(tool: ToolDef) {
  return {
    name: tool.name, title: tool.title, category: tool.category, useWhen: tool.useWhen, benefit: tool.benefit, description: tool.description,
    price: priceOf(tool.name), priceText: priceText(tool.name),
    http: { method: "POST", path: `/api/tools/${tool.name}`, body: "JSON object with the inputs below" },
    mcp: { method: "tools/call", name: tool.name },
    inputs: tool.inputDocs, outputs: tool.outputs, notes: tool.notes ?? [],
    inputSchema: z.toJSONSchema(z.object(tool.inputs), { io: "input" }),
  };
}

export { ToolError } from "./types";
export type { ToolContext, ToolDef } from "./types";
