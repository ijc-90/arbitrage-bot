---
name: Fee and spread model
description: Exact fee values, spread formula, dual-threshold entry logic, and a known redundancy in config
type: project
---

**Fee values (config.yaml — production):**
- Binance: taker_fee_pct=0.10, slippage_estimate_pct=0.04
- Bybit: taker_fee_pct=0.10, slippage_estimate_pct=0.04
- BingX: taker_fee_pct=0.10, slippage_estimate_pct=0.04
- Combined all_in_cost for any two-exchange pair: 0.28% (both taker fees + both slippage estimates)

**Fee values (config.test.yaml):**
- Binance: taker_fee=0.06, slippage=0.04
- Bybit: taker_fee=0.06, slippage=0.04
- all_in_cost: 0.20%

**Spread formula (spreadEngine.ts):**
- raw_spread = (bid_sell - ask_buy) / ask_buy * 100
- net_spread = raw_spread - all_in_cost
- Both directions computed (buy A/sell B and buy B/sell A); best profitable direction wins

**Entry conditions (dual threshold — both must be true):**
1. net_spread >= min_net_spread_pct (prod: 0.15%)
2. net_spread >= all_in_cost * entry_buffer_multiplier (prod: 0.28 * 2.0 = 0.56%)

**Known redundancy:** In both prod and test configs, condition 2 (buffer) always exceeds condition 1 (min_net), so min_net_spread_pct is never the binding constraint. The effective entry threshold is entirely determined by entry_buffer_multiplier. min_net would only matter if entry_buffer_multiplier < (min_net / all_in_cost), i.e. < 0.536 in prod.

**Effective entry threshold in prod:** net_spread >= 0.56%, meaning gross spread >= 0.84% (all_in + buffer = 0.28 + 0.56).

**PnL formula:** estimatedPnlUsdt = (netSpreadPct / 100) * capitalUsdt
This is correct: profit on buy-side deployed capital after round-trip costs.
Note: does NOT model total capital commitment (also need base asset on sell side).

**How to apply:** When reviewing threshold changes, confirm which condition is binding. When someone asks why an opportunity didn't fire, calculate both conditions explicitly.
