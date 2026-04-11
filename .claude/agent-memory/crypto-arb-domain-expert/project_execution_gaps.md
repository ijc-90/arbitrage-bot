---
name: Execution Gap Analysis
description: Summary of what is missing to go from alarm-only to live automated trading, as assessed April 2026
type: project
---

Critical path to execution (dependency-ordered):

1. **Capital inventory manager (AT-3)** — no balance tracking exists. Cannot accept a trade without knowing available capital on both exchanges.
2. **Order placement APIs (AT-1)** — no authenticated order submission. Needs HMAC signing, MARKET/IOC/FOK order types per exchange.
3. **Dual-leg execution coordinator (AT-2)** — no parallel leg submission logic, no partial-fill handling, no cancel-on-miss.
4. **L2 order book + dynamic slippage (AT-5)** — flat 0.04% slippage constant is unreliable for execution sizing. Must walk book to estimate fill price given notional.
5. **Position tracking and risk controls (AT-6)** — no concurrent position limits, no per-pair exposure limits, no daily loss circuit breaker, no API rate-limit budget.
6. **Latency measurement (AT-7)** — no instrumentation of detection-to-fill chain. Spread decay between detection and fill is unknown.
7. **Realized PnL / fills audit (AT-9)** — no fills table, no actual vs. estimated reconciliation.
8. **Withdrawal/rebalancing automation (AT-8)** — no on-chain transfer modeling, no withdrawal fees.
9. **Operational reliability (AT-10)** — no order recovery on restart, no external alerting, no dry-run/sandbox mode.

BingX WS feed is also deferred (gzip protocol) — BingX always falls back to REST for opportunity tracking.

Single-opportunity-at-a-time is an alarm-only design choice; execution would need concurrent opportunity support.
