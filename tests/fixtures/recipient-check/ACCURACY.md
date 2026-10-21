# recipient_check accuracy

Measured 2026-10-15 on 116 real Base cases. Each answer is recorded in this folder and replayed by `npm test`. The right answer for each case comes from the chain, found by scripts/measure-recipient-check.ts with its own queries:

- **Poisoned address:** a third party signed a zero-value USDC transfer out of the victim's wallet to this address, which has the same first and last 4 characters as an address the victim really paid. Right answer: AVOID.
- **Address the victim really paid:** the address the poisoner imitated. Right answer: anything but AVOID.
- **Paying someone again:** a real USDC payment of at least $1 from the last hour, checked as if the sender were paying again. Right answer: anything but AVOID.
- **First payment to a real recipient:** a sender paired with a wallet that really received USDC from someone else and that the sender has never paid. Right answer: anything but AVOID.

| Case | Right answer | Cases | Right | SAFE | CAUTION | AVOID | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Poisoned address | AVOID | 28 | 28 | 0 | 0 | 28 | 0 |
| Address the victim really paid | not AVOID | 28 | 28 | 28 | 0 | 0 | 0 |
| Paying someone again | not AVOID | 30 | 30 | 30 | 0 | 0 | 0 |
| First payment to a real recipient | not AVOID | 30 | 30 | 30 | 0 | 0 | 0 |

The poisoned cases come from 2 different attacker wallets and 28 victims.

4 sampled case(s) were left out because the sender's history was too big to keep as a test fixture (busy bots and exchanges).

## Wrong answers

None.
