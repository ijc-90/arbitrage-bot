---
name: Spread Engine Design
description: Spread formula correctness, direction logic, and known limitations in spreadEngine.ts
type: project
---

Spread formula is CORRECT and directionally consistent. Uses bid/ask (not mid-price):
- Buy-A-sell-B direction: rawAB = (tickB.bidPrice - tickA.askPrice) / tickA.askPrice * 100
- Buy-B-sell-A direction: rawBA = (tickA.bidPrice - tickB.askPrice) / tickB.askPrice * 100

This correctly models: you pay the ask to buy, you receive the bid when selling. Denominator is the ask (cost basis). Formula is standard cross-exchange spread.

Net spread = raw - allInCost. Entry condition: net >= allInCost * entry_buffer_multiplier (2.0x). Effective threshold ~0.56% net.

Estimated PnL = (netSpreadPct / 100) * capitalUsdt — uses entry spread, not peak. Peak tracked separately. Both values correct per design decision.

Capital sizing: effectiveCapital = min(capital_per_trade_usdt, min(volA, volB) * 0.001). Caps at 0.1% of smallest exchange's 24h volume. Sound liquidity discipline.

Key limitation: slippage_estimate_pct is a flat constant (0.04%). No L2 order book walk. This is AT-5 gap — for alarm-only this is acceptable; for execution it underestimates impact on thin books.

max_net_spread_pct = 20% guard against bad data. Sound.
