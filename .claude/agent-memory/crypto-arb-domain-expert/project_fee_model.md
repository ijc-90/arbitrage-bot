---
name: Fee Model
description: Exchange fee configurations, threshold rationale, and fee-related design decisions
type: project
---

All three exchanges (Binance, Bybit, BingX) configured at 0.10% taker fee — matches standard tier as of project inception. No maker fee modeled (system assumes taker on both legs, which is correct for market orders in execution).

Slippage estimate: 0.04% per exchange (flat constant, not dynamic). Total all-in cost per round trip: 0.28% (0.10 + 0.10 + 0.04 + 0.04). Entry buffer multiplier is 2.0x, so effective entry threshold is 0.56% net spread. This is realistic for liquid pairs on these exchanges.

No withdrawal fees modeled anywhere. This is documented as AT-8 gap — material for capital rebalancing across exchanges.

min_volume_usdt floor: 100,000 USDT 24h volume. Reasonable filter to avoid illiquid phantom opportunities.

**Why:** Fees are symmetric taker-only because the system has no limit order placement capability. If maker orders are eventually used on one leg, fee savings of ~0.05% per leg would shift the break-even threshold.
