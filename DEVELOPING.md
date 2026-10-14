# Developing Base Pulse

## Where things live

```
server/            the backend (Express + MCP), bundled to dist/server.cjs
  index.ts         routes, MCP server, discovery files (llms.txt, mcp.json, sitemap)
  tools/           the tool registry: one definition per tool; chain.ts holds networks, addresses and the RPC client
  pricing.ts       price of every tool and the free-call allowance
  x402.ts          x402 payment setup (facilitator, payout wallet, settle hook)
  meter.ts         who may call: free tool, owner key, free call, or payment
  db.ts            database tables and inserts
  callers.ts       sorts callers into bots, AI apps, scripts and browsers by user agent
  owner.ts         owner dashboard data: revenue per tool, callers, visitors
  auth.ts          reads the owner key from a request
  secrets.ts       loads secrets from Google Secret Manager
src/               the website (React + Tailwind)
  index.css        colors and shared styles
  components/ui/   shared UI helpers (button styles, verdict stamps and check lines)
  pages/           one file per page type (OwnerPage.tsx is the dashboard at /owner)
  nav.ts           sidebar sections and links
scripts/           deploy, tool check
tests/             metering, dashboard and listing tests (recorded mainnet data arrives with the first safety tool)
```

## Set up on a new device

```bash
git clone git@github.com:Timothymycompc/base-pulse.git
cd base-pulse
nvm use            # Node 20 (see .nvmrc)
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum
npm run dev            # http://localhost:3000
```

To deploy from the new device, install the Google Cloud CLI, run `gcloud auth login` and `gcloud config set project x300-506418`. Secrets stay in Secret Manager, so nothing else needs copying.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the site and API locally |
| `npm run check` | Type check plus the tool check (prices, docs) |
| `npm test` | The test suite (offline) |
| `npm run build` | Check, then bundle everything into `dist/` |
| `npm run deploy -- --check-only` | Check setup and code without uploading |
| `npm run deploy` | Back up, deploy hidden, test, then go live |

## Add a tool

1. Pick the file in `server/tools/` that matches the category (today `wallet.ts`), or create a new one.
2. Write a `ToolDef` (copy an existing one such as `balance` in `wallet.ts`). Fill in every field: `useWhen` tells agents when to call it, `inputDocs` says how to get each input, `outputs` says what each field means and how it is computed, and `example` builds real mainnet inputs for the playground.
3. Add it to that file's list at the bottom (for example `WALLET_TOOLS`). New files also need adding to `TOOLS` in `server/tools/index.ts`.
4. Give it a price in `server/pricing.ts` (`null` means free). A paid tool also needs a fixed, real example input in `LISTING_EXAMPLES` in `server/x402.ts`; x402 directories show it in the tool's listing.
5. Run `npm run check`. It fails if the price, a paid tool's listing example, an input's docs, or an output's docs are missing.

That is all. The MCP tool, `POST /api/tools/<name>`, the docs page, the playground, `llms.txt`, `mcp.json` and the sitemap update by themselves.

A new category also needs adding to `ToolCategory` in `server/tools/types.ts` and `CATEGORY_LABELS` in `src/lib/toolsApi.ts`.

## Change a price

Edit `server/pricing.ts`. The x402 offer, docs, pricing page and MCP descriptions all read from it. `FREE_CALLS_PER_TOOL` sets the daily free calls each caller gets per paid tool.

## Change colors

Edit the `@theme` block at the top of `src/index.css`. `accent` is the brand color, `ink` the greys, and `success`, `warning`, `danger` and `info` the status colors. Every page uses these names, so one edit changes the whole site.

## Change buttons

Use `button('primary' | 'secondary' | 'ghost', 'sm' | 'md')` from `src/components/ui/button.ts`:

```tsx
<Link to="/docs/quickstart" className={button('primary')}>Quickstart</Link>
```

Edit that file to restyle every button at once.

## Add a page

Write the page in `src/pages/`, add its path to `App.tsx`, add a sidebar link in `src/nav.ts`, and add the path to the sitemap list in `server/index.ts`.
