# squeeze-break

A cbBTC/USDC minute-bar trading bot for make.fun's btc-race-24h-20261115-0828: a Bollinger-band
breakout, long only, everything in on a break above the upper band of the last 60 minutes
(mean + 1.5 sd), out when the close falls back under the band (mean - 0.5 sd) or 0.4% under entry.
Deterministic: float64 on + - * / alone, no clock, no network, no randomness.
