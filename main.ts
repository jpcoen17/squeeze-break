// Squeeze-break: a Bollinger-band breakout bot for cbBTC/USDC, one asset, long only.
//
// The idea: cbBTC trades in a thin on-chain pool minute by minute, and most minutes are flat. When a
// minute's close breaks above the upper band of the last 60 minutes (their mean plus 1.5 standard
// deviations), the pool has been pushed through the top of its recent range; the bot buys the break
// with everything and rides it. It sells when the close falls back inside the band (below the mean
// minus half a standard deviation) or when the position is 0.4% under its entry, so no single break
// costs more than its stop. Cash earns nothing, a flat book is dead money, and the round trip pays
// about 26 bps in fees, slippage and impact, so only a band break wide enough to cover that is a
// trade at all.
//
// Everything the bot knows is in the bars the harness sends: no clock, no network, no randomness. The
// same bars give the same orders on every run, so the two graded executions match byte for byte.
//
// Repository layout: main.ts (this file) at the root, vendor/makefun-bars.ts the kit's SDK shim,
// LICENSE MIT, README.md.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** The band's lookback in bars: three quarters of an hour behind the break. */
const BAND_BARS = 45;
/** Buy when the close is this many standard deviations over the lookback's mean: only wide breaks pay. */
const BREAK_SIGMA = 3.5;
/** Sell when the close is this many standard deviations under the mean: the break has failed. */
const EXIT_SIGMA = 0.25;
/** Sell when the position's mark is this far under its entry: the stop (the band exit fires first). */
const STOP = 0.004;
/** Every order caps its fill 1% from the close it was decided on: better no fill than a terrible one. */
const MAX_SLIPPAGE_BPS = 100;

/** The closes the strategy has seen, in order: the band reads the last BAND_BARS of them. */
const closes: bigint[] = [];

/** The band over the closes seen so far: their mean and standard deviation, or null before it has BAND_BARS. */
function band(): { mean: number; sd: number } | null {
  if (closes.length < BAND_BARS) return null;
  const w = closes.slice(closes.length - BAND_BARS);
  // Float64 on + - * / alone, each correctly rounded, so the same bars give the same band every run.
  let mean = 0;
  for (const c of w) mean += Number(c);
  mean /= BAND_BARS;
  let v = 0;
  for (const c of w) {
    const d = Number(c) - mean;
    v += d * d;
  }
  return { mean, sd: Math.sqrt(v / BAND_BARS) };
}

/** The orders decided on one bar: a sell of everything held, or a buy of everything free, never both. */
function decide(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
  if (bar === undefined) return [];
  // The band reads the 45 closes BEFORE this bar: the range the break has to clear.
  const b = closes.length >= BAND_BARS ? band() : null;
  closes.push(BigInt(bar.c));
  if (b === null) return []; // the first BAND_BARS batches build history; the scored window is far longer
  const px = BigInt(bar.c);
  const held = state.positions.get('CBBTC');
  const out: OrderInput[] = [];
  if (held !== undefined && held.qty > 0n) {
    // Mark the position at this close: the entry's fill price is what the sell compares against.
    const entry = state.value('CBBTC', 1n) > 0n ? px : px; // entry price tracking below, via cost basis
    // cost_quote_units includes the buy's fees: recover the fill price as cost per unit, then compare
    // the close against it. The stop is on price, not on PnL, so fees do not double-count.
    const qty = held.qty;
    const costPerUnit = Number(held.cost) / Number(qty);
    const stopHit = Number(px) <= costPerUnit * (1 - STOP);
    const exitHit = Number(px) < b.mean - EXIT_SIGMA * b.sd;
    if (stopHit || exitHit) {
      out.push({ side: 'sell', symbol: 'CBBTC', qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return out;
  }
  const breakHit = Number(px) > b.mean + BREAK_SIGMA * b.sd;
  if (breakHit) {
    // Buy with everything: the cap is 100% of equity and cash earns nothing while out of the market.
    const spend = state.cash;
    if (spend > 0n) {
      out.push({ side: 'buy', symbol: 'CBBTC', notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
  }
  return out;
}

await runBars({
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    return decide(state, batch);
  },
});
