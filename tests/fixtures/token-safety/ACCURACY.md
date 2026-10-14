# token_safety accuracy

Measured 2026-10-14 on 51 real Base tokens: 39 that got a new Uniswap pool against ETH or WETH in the previous ~100 minutes, 10 well-known tokens and 2 recorded cases. Each answer is recorded in this folder and replayed by `npm test`. Compared with GoPlus and honeypot.is, two independent checkers; neither is ground truth, so disagreements are listed for a person to judge.

## Verdicts

| Group | SAFE | CAUTION | AVOID | Error |
| --- | --- | --- | --- | --- |
| New tokens | 0 | 22 | 17 | 0 |
| Well known | 8 | 2 | 0 | 0 |
| Recorded cases | 0 | 0 | 2 | 0 |

## Sell test

Selling was simulated for 31 of 51 tokens (61%). The rest trade only on pools the test doesn't cover yet, or their buy failed.

Honeypot (can buy, can't sell): we and at least one other checker both answered for 28 tokens and agreed on 24.

Others flag as a honeypot, we don't:
- AMZN `0x9eba351a2648d0893d8e26232bf11caaa214335e`: our sell test sold fine
- KEYCAT `0x9a26F5433671751C3276a065f57e5a02D2817973`: our sell test sold fine
- POOLS `0xc0e6971f9b1271777b490a273d745ce1b222f67f`: our sell test sold fine
- SKI `0x768BE13e1680b5ebE0024C42c896E3dB59ec0149`: our sell test sold fine

Sell tax: both measured it for 23 tokens; within 2 percentage points for 23.

## Owner powers

Mint power: both could read it for 32 tokens; agreed on 25.
- AMZN: ours no mint function in the verified code, GoPlus is_mintable=1
- BASED: ours only a bridge mint (crosschainMint, ERC-7802), which GoPlus counts as mintable, GoPlus is_mintable=1
- LONK: ours warn, GoPlus is_mintable=0
- POOLS: ours no mint function in the verified code, GoPlus is_mintable=1
- USD𖼊: ours only a bridge mint (crosschainMint, ERC-7802), which GoPlus counts as mintable, GoPlus is_mintable=1
- USD𖼊: ours only a bridge mint (crosschainMint, ERC-7802), which GoPlus counts as mintable, GoPlus is_mintable=1
- ZZZ: ours only a bridge mint (crosschainMint, ERC-7802), which GoPlus counts as mintable, GoPlus is_mintable=1

## Verified source

Of 37 tokens, we found verified source for 34; GoPlus reports 36 as open source. The gap is contracts verified only on Basescan, which we read only when an Etherscan key is set.

## Recorded cases

- AMZN: GoPlus said honeypot; on chain 5 different wallets sold (4 had bought), so selling works; liquidity was pulled to $0. Our verdict: AVOID.
- POOLS: same pattern as AMZN, same day: sellable, liquidity pulled to $0. Our verdict: AVOID.

## False alarms on well-known tokens

None: no well-known token got AVOID.
