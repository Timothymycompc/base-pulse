# Later

Ideas parked on purpose. Nothing here goes in until the current work (measuring each safety tool on a larger real sample, then deploying) is done. New ideas go at the bottom.

- Other EVM chains (Ethereum, Arbitrum, Optimism, BNB, Polygon) as a `network` option on each tool, once Base is done.
- A Coinbase AgentKit example on the Connect page, after checking its Base wallet setup works as written.
- Per-payment failover between Coinbase's and PayAI's facilitators (also parked in Solana Pulse).
- Publish to the official MCP Registry and Coinbase's Bazaar once the first paid call settles.

- Unknown methods (PUT/PATCH) on /api/tools/<name> fall through to the web page with 200; answer 405 instead (seen 2026-11-16, harmless: no data or free calls leak).
- (2026-11-18, from the HoodStash check on Robinhood Chain) "Can anyone still change this contract?" in `address`: read owner()/pendingOwner(), then SIMULATE upgradeToAndCall(sameImpl) from the owner, the deployer and a random address (eth_call; OwnableUnauthorizedAccount = nobody can). Plus mint concentration for NFTs/tokens (share minted to the top wallet: 81 of 94 HoodStash boxes went to its own treasury). Test on real contracts (renounced vs live owner).
