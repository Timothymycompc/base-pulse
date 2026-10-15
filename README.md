# Base Pulse

Safety checks and honest on-chain reads for AI agents on [Base](https://base.org). Every answer comes from real chain data and names its source; when data is missing the answer says "unknown" instead of guessing. Read [PRINCIPLES.md](PRINCIPLES.md) first.

- **Live:** https://base-pulse-1021990235790.us-central1.run.app (once deployed)
- **MCP:** `POST /mcp` (Streamable HTTP) or `/mcp/sse`
- **HTTP:** `POST /api/tools/<name>` with a JSON body
- **Docs for every input and output:** `GET /api/tools` and `GET /api/tools/<name>`
- **Pricing:** every tool gives each caller 25 free calls a day, then $0.01 or $0.02 USDC per call, paid with [x402](https://x402.org) on Base. Calls that fail are never charged.

Built from the same plumbing as [Solana Pulse](https://github.com/Timothymycompc/solana-pulse-ai-agent-gateway): one tool registry drives MCP, HTTP, the docs, `llms.txt` and `/.well-known/mcp.json`.

## Tools

Safety checks give a verdict. "SAFE" means none of the traps we know about were found, not that something is safe (see [PRINCIPLES.md](PRINCIPLES.md)). Every tool is tested against recorded real Base mainnet cases in [tests/fixtures](tests/fixtures); the count is in the last column.

### Before money moves

| Tool | What it answers | Verdicts | Real cases |
| --- | --- | --- | --- |
| `token_safety` | Is this token a known trap? A simulated buy and sell on Uniswap v2, v3 or v4 (honeypots, hidden taxes), owner powers (mint, block wallets, fees, pause, sell caps), upgradeable code, verified source, liquidity and pool age. | SAFE / CAUTION / AVOID | 51, [measured accuracy](tests/fixtures/token-safety/ACCURACY.md) |
| `recipient_check` | Is this the right address to send to? Checks it against the sender's own history: paid before, a look-alike of someone they paid (address poisoning), or only seen through transfers the sender never signed. | SAFE / CAUTION / AVOID | 4 |
| `sanctions_check` | Is this address on OFAC's sanctions list, or has it traded directly with one that is? Uses Treasury's official list, refreshed every 12 hours. | CLEAR / NOT_LISTED / DIRECT_EXPOSURE / SANCTIONED | 4 |
| `x402_check` | Is this x402 payment request safe to pay? What it really costs in dollars, whether the asset is real USDC on Base, and who gets paid. | SAFE / CAUTION / AVOID | 7 |
| `check_signature` | What does this signature request let someone take? Permit, DAI permit, Permit2 (allowance and one-time transfer) and Seaport orders. | SAFE / CAUTION / AVOID | 7 |
| `tx_matches` | Does this transaction send exactly the token, amount and recipient that was asked for, and nothing else? | MATCH / MISMATCH | 4 |
| `check_tx` | What will this unsigned transaction do to each wallet? Simulated on the latest block: every token, NFT and ETH movement, every approval granted, and whether it would fail. | SAFE / CAUTION / AVOID | 6 |
| `approvals` | Who can move this wallet's tokens right now? Live ERC-20, Permit2 and NFT approve-all approvals, and who each spender is. | CLEAR / REVIEW / DANGER | 4 |

### Reads

| Tool | What it answers | Real cases |
| --- | --- | --- |
| `explain_tx` | What did this landed transaction do, and why did it fail? Function called, everything that moved, approvals granted, and the full fee including Base's L1 data fee. | 6 |
| `whats_this` | Is this address a wallet, a contract, a token, an NFT collection, a Safe or a proxy, and is its source verified? | 6 |
| `find_token` | Which contract is the real token for this ticker, and which are copycats? Names the real one only when the issuer or a curated list confirms it. | 5 |
| `convert` | What is this human amount in the token's raw units (or back), using its real decimals? Refuses instead of rounding. | 5 |
| `gas` | What will this cost on Base, including the L1 data fee, in ETH and dollars? | 3 |
| `balance` | How much ETH and USDC does this wallet hold? | 2 |

Only `token_safety` has been measured on a broad sample so far. The other verdict tools pass every recorded case, but a handful of hand-picked cases is not a measured accuracy; measuring each one on a larger real sample is the next piece of work.

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
