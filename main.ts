// Trend-following cbBTC bot for agent-fun/bars-replay/v1.
//
// The bot reads the hello once, then answers every batch (one 1-minute bar)
// with exactly one reply echoing its seq. Orders decided on the bar closing
// at t fill at the next bar's open, so every signal is computed from closes
// the bot has already seen and nothing peeks at the bar being filled into.
//
// Strategy: ride a confirmed uptrend, sit out everything else.
//   * Entry (flat): EMA8 above EMA48, price above EMA48, the 60-bar log
//     return above +0.30% and the fast/slow EMA gap above 10 bps, with a
//     fresh cross or a 30-bar return above +0.20% confirming the move is
//     still going. Size is full on a strong/confirmed move, half on a
//     merely moderate one, and halved again when the bar range is unusually
//     wide; the order is also shrunk when its own price impact on the pool
//     depth would exceed 50 bps. No entry in the first 60 bars (history),
//     none after bar 1400, and a 30-bar cooldown after an exit unless a
//     +1% 60-bar breakout says the trend restarted at once.
//   * Exit (long): a trailing stop 2.2% below the highest close since the
//     fill (widened by 3x the 60-bar mean high-low range when the market
//     is choppy), or a hard stop 2.0% below the fill price. No exit on an
//     EMA cross-back: on 1-minute bars the fast EMA whipsaws across the
//     slow one all day and each round trip burns ~26 bps.
//   * A full-size round trip costs ~26 bps in fee, slippage and impact, so
//     the bot trades rarely and only for moves materially larger than that.
//     Long only, one position, at most one order per reply.
//
// Deterministic: every decision is a pure function of the bars seen so far.
// No clock, no environment, no unseeded randomness.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuned constants (chosen on the dev window, kept coarse and round) ---
const EMA_FAST_SPAN = 8;
const EMA_SLOW_SPAN = 48;
const HISTORY_BARS = 60; // bars of history before the first entry
const LAST_ENTRY_BAR = 1400; // stop opening new trades near the window end
const MOM60_ENTRY = 0.003; // 60-bar log return above +0.30% to enter
const MOM60_STRONG = 0.006; // above +0.60% the move is strong
const MOM30_ENTRY = 0.002; // 30-bar log return above +0.20% confirms
const MOM30_STRONG = 0.003; // above +0.30% the move is confirmed
const GAP_MIN = 0.001; // fast/slow EMA gap above 10 bps
const STOP_MIN = 0.022; // trailing stop: 2.2% below the peak close
const STOP_ATR_MULT = 3; // ...widened by 3x the 60-bar mean bar range
const HARD_STOP = 0.02; // hard stop: 2.0% below the fill price
const COOLDOWN_BARS = 30; // bars to wait after an exit before re-entering
const BREAKOUT_BYPASS = 0.01; // +1% 60-bar return re-enters at once
const PARTIAL_FRAC_NUM = 1n; // moderate entries take half the cash
const PARTIAL_FRAC_DEN = 2n;
const VOLATILE_ATR = 0.003; // mean bar range above 30 bps: halve the size
const MAX_IMPACT_BPS = 50n; // shrink an order whose own impact tops this
const MAX_SLIPPAGE_BPS = 250; // 2.5% from the latest close, either way
const MIN_NOTIONAL = 1000000n; // $1, the harness minimum for a buy

const FAST_ALPHA = 2 / (EMA_FAST_SPAN + 1);
const SLOW_ALPHA = 2 / (EMA_SLOW_SPAN + 1);

// --- state, all of it a function of the bars seen so far ---
const closes: number[] = []; // log closes, every bar in order
const hlRanges: number[] = []; // log high-low ranges, last 60 bars
let hlSum = 0;
let emaFast = 0;
let emaSlow = 0;
let haveEma = false;
let prevGap = 0;
let entryLog = Number.NaN; // log fill price of the open position
let peakLog = Number.NaN; // highest log close since the fill
let lastExitSeq = -1000000;
let warmupBars = 0;

await runBars({
  onHello(state) {
    warmupBars = state.warmupBars;
  },

  onBatch(state, batch) {
    // Learn the fills first: they arrive in the batch after the orders
    // were decided, and they set the entry price a stop is measured from.
    // This runs even on a batch with no bar, so a fill is never missed.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryLog = Math.log(Number(fill.price));
        peakLog = entryLog;
      } else {
        entryLog = Number.NaN;
        peakLog = Number.NaN;
        lastExitSeq = state.seq;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // a gap minute: no bar, no orders

    const closeLog = Math.log(Number(bar.c));
    const rangeLog = Math.log(Number(bar.h)) - Math.log(Number(bar.l));

    if (!haveEma) {
      emaFast = closeLog;
      emaSlow = closeLog;
      haveEma = true;
    } else {
      emaFast += FAST_ALPHA * (closeLog - emaFast);
      emaSlow += SLOW_ALPHA * (closeLog - emaSlow);
    }
    const gap = emaFast - emaSlow;

    hlRanges.push(rangeLog);
    hlSum += rangeLog;
    if (hlRanges.length > 60) hlSum -= hlRanges.shift() as number;
    const atr = hlSum / hlRanges.length;

    closes.push(closeLog);
    const n = closes.length;

    if (state.warmingUp) {
      prevGap = gap;
      return []; // warm-up batches build history; trading is closed
    }

    const position = state.positions.get(SYMBOL);
    const qty = position === undefined ? 0n : position.qty;
    const idx = state.seq - warmupBars; // index inside the scored window

    if (qty > 0n) {
      // Long: defend the position, never add to it.
      if (closeLog > peakLog) peakLog = closeLog;
      const stopDist = Math.max(STOP_MIN, STOP_ATR_MULT * atr);
      const trailHit = closeLog < peakLog - stopDist;
      const hardHit = Number.isFinite(entryLog) && closeLog < entryLog - HARD_STOP;
      prevGap = gap;
      if (trailHit || hardHit) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for a confirmed uptrend worth buying. The cross is read
    // off the previous bar's gap before it is overwritten below.
    const crossedUp = prevGap <= 0 && gap > 0;
    prevGap = gap;
    if (n < HISTORY_BARS + 1 || idx > LAST_ENTRY_BAR) return [];
    const mom60 = closeLog - closes[n - 1 - 60];
    const mom30 = closeLog - closes[n - 1 - 30];
    const trendUp = emaFast > emaSlow && closeLog > emaSlow;
    if (!trendUp || mom60 <= MOM60_ENTRY || gap <= GAP_MIN) return [];
    if (!crossedUp && mom30 <= MOM30_ENTRY) return [];
    if (state.seq - lastExitSeq < COOLDOWN_BARS && mom60 <= BREAKOUT_BYPASS) return [];

    // Size by confirmation: full on a strong move, half on a moderate one,
    // halved again in unusually volatile bars, shrunk when the pool impact
    // of the order itself would be large.
    let fracNum = 1n;
    let fracDen = 1n;
    const strong = mom60 > MOM60_STRONG || (mom30 > MOM30_STRONG && gap > GAP_MIN);
    if (!strong) {
      fracNum = PARTIAL_FRAC_NUM;
      fracDen = PARTIAL_FRAC_DEN;
    }
    if (atr > VOLATILE_ATR) fracDen *= 2n;
    let notional = (state.cash * fracNum) / fracDen;
    const impact = state.impactBps(SYMBOL, notional);
    if (impact !== null && impact > MAX_IMPACT_BPS) {
      notional = (notional * MAX_IMPACT_BPS) / impact;
    }
    if (notional < MIN_NOTIONAL) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
