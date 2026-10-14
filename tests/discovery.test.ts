// Discovery listings (x402 Bazaar extension) for every paid tool, checked with the extension's own validators,
// so a facilitator's directory accepts them. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { bazaarResourceServerExtension, declareDiscoveryExtension, sanitizeTags, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { discoveryFor } from "../server/x402";
import { TOOL_PRICES, TOOL_ROUTE_PREFIX } from "../server/pricing";
import { TOOLS_BY_NAME } from "../server/tools";

const PAID = Object.entries(TOOL_PRICES).filter(([, price]) => price).map(([name]) => name);

test("every paid tool has a listing within the directory limits", () => {
  assert.ok(PAID.length > 0);
  for (const name of PAID) {
    const { description, tags } = discoveryFor(name);
    assert.ok(description.length > 0 && description.length <= 500, `${name}: description is ${description.length} characters`);
    assert.ok(description.endsWith("."), `${name}: description is cut mid-sentence`);
    assert.deepEqual(sanitizeTags(tags), tags, `${name}: a tag would be dropped`);
  }
});

test("every listing example is a valid input for its tool", () => {
  for (const name of PAID) {
    const parsed = z.object(TOOLS_BY_NAME.get(name)!.inputs).safeParse(discoveryFor(name).example);
    assert.ok(parsed.success, `${name}: ${parsed.error?.message}`);
  }
});

test("HTTP and MCP listings pass the Bazaar schema check", () => {
  for (const name of PAID) {
    const { description, inputSchema, example } = discoveryFor(name);
    // The resource server adds the HTTP method from the request before sending the listing; do the same here.
    const path = `${TOOL_ROUTE_PREFIX}${name}`;
    const request = { method: "POST", routePattern: path, adapter: { getPath: () => path } };
    const http = bazaarResourceServerExtension.enrichDeclaration!(
      declareDiscoveryExtension({ bodyType: "json", input: example, inputSchema }).bazaar, request as any);
    const mcp = declareDiscoveryExtension({ toolName: name, description, transport: "streamable-http", inputSchema, example }).bazaar;
    for (const [kind, listing] of Object.entries({ http, mcp })) {
      const result = validateDiscoveryExtension(listing as any);
      assert.ok(result.valid, `${name} ${kind}: ${JSON.stringify(result.errors)}`);
    }
  }
});
