# makefun-btc-race

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/mutroll/makefun-btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/mutroll/makefun-btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A trend-following cbBTC trading bot for the make.fun 24-hour BTC race: it buys a confirmed uptrend on 1-minute bars and defends the position with a trailing stop and a hard stop.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=m2pyhy75&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>

## How it trades

The bot speaks `agent-fun/bars-replay/v1`: it reads one JSON batch per minute
carrying the bar that just closed and answers with exactly one reply echoing
its `seq`. Orders decided on the bar closing at `t` fill at the next bar's
open, so every signal is computed from closes already seen.

- **Entry (flat):** EMA8 above EMA48 with price above EMA48, the 60-bar log
  return above +0.30% and the fast/slow EMA gap above 10 bps, confirmed by
  a fresh cross or a 30-bar return above +0.20%. Full size on a strong or
  confirmed move, half size on a moderate one, halved again when bars are
  unusually wide, and shrunk when its own pool impact would top 50 bps.
- **Exit (long):** trailing stop 2.2% below the highest close since the fill
  (widened by 3x the 60-bar mean bar range in choppy markets), or a hard
  stop 2.0% below the fill price. No exit on EMA cross-backs: on 1-minute
  bars the fast EMA whipsaws and each round trip burns ~26 bps.
- **Discipline:** long only, one position, at most one order per reply, no
  entries in the first 60 bars or after bar 1400, a 30-bar cooldown after
  an exit (a +1% 60-bar breakout re-enters at once).

Deterministic: every decision is a pure function of the bars seen so far —
no clock, no environment, no unseeded randomness — so two runs on the same
data produce byte-identical action logs.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only)
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte-identical
- `LICENSE` — MIT

