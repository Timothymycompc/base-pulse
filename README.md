# Base Pulse

Safety checks and honest on-chain reads for AI agents on [Base](https://base.org). Every answer comes from real chain data and names its source; when data is missing the answer says "unknown" instead of guessing. Read [PRINCIPLES.md](PRINCIPLES.md) first.

- **Live:** https://base-pulse-1021990235790.us-central1.run.app (once deployed)
- **MCP:** `POST /mcp` (Streamable HTTP) or `/mcp/sse`
- **HTTP:** `POST /api/tools/<name>` with a JSON body
- **Docs for every input and output:** `GET /api/tools` and `GET /api/tools/<name>`
- **Pricing:** every tool gives each caller 25 free calls a day, then $0.01 or $0.02 USDC per call, paid with [x402](https://x402.org) on Base. Calls that fail are never charged.

Built from the same plumbing as [Solana Pulse](https://github.com/Timothymycompc/solana-pulse-ai-agent-gateway): one tool registry drives MCP, HTTP, the docs, `llms.txt` and `/.well-known/mcp.json`.

## Tools

| Tool | What it answers | Status |
| --- | --- | --- |
| `token_safety` | Is this token a known trap? A simulated buy and sell on Uniswap v2, v3 or v4 (honeypots, hidden taxes), owner powers (mint, block wallets, fees, pause, sell caps), upgradeable code, verified source, liquidity and pool age. [Measured accuracy](tests/fixtures/token-safety/ACCURACY.md). | Built |
| `balance` | How much ETH and USDC does this wallet hold? | Built |

## Planned tools (not built yet)

The current piece of work. Each one is built, tested on recorded mainnet data and documented before the next starts.

| Tool | What it will answer |
| --- | --- |
| `check_tx` | What will this unsigned transaction do to each wallet, including approvals it grants? |
| `check_signature` | What does this signature request (Permit, Permit2, Seaport order) let someone take? |
| `approvals` | Which spenders can move this wallet's tokens right now? |
| `tx_matches` | Does this transaction send exactly the token, amount and recipient that was asked for? |
| `explain_tx` | What did this landed transaction do, and why did it fail? |
| `whats_this` | Is this address a wallet, a contract, a token or a proxy, and is its source verified? |
| `find_token` | Which contract is the real token for this ticker, and which are copycats? |
| `convert` | What is this human amount in the token's raw units, using its real decimals? |
| `gas` | What will this cost on Base, including the L1 data fee? |

## Running it

See [DEVELOPING.md](DEVELOPING.md). `npm test` runs the tests, `ship` (from `~/bin`) tests, commits, pushes and deploys.

## Setup in Google Cloud (project x300-506418)

| Secret | What it is |
| --- | --- |
| `BASE_PULSE_DATABASE_URL` | This project's database on the shared Cloud SQL instance `solana-pulse-db` (database `base_pulse`). Loaded into `DATABASE_URL`. |
| `BASE_RPC_URL` | Coinbase's Base node (CDP). Used for every read except simulations, which it refuses. |
| `BASE_SIMULATE_RPC_URL` (optional) | A node that allows `eth_simulateV1`, tried before the free public ones. |
| `ETHERSCAN_API_KEY` (optional) | Lets `token_safety` read source verified only on Basescan. Without it, only Sourcify is checked. |
| `OWNER_API_KEY`, `CALLER_HASH_SECRET`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Shared with Solana Pulse. |

## License

MIT
