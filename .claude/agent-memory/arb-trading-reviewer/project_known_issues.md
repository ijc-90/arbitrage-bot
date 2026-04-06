---
name: Known bugs and issues
description: Confirmed bugs and discrepancies found during 2026-04-06 full source review
type: project
---

**1. TLS disabled in production (HIGH — security)**
File: docker-compose.prod.yml
`NODE_TLS_REJECT_UNAUTHORIZED=0` on all three services (detector, pair-fetcher, dashboard).
Disables certificate validation on all outbound HTTPS calls to exchange APIs. Enables price-feed spoofing.
Fix: remove the env var from all services.

**2. Dead variable with inverted logic (LOW — dead code)**
File: arbitrage-detector/detector.ts line 143
`const hasPairSnapshots = volPerExchange.size === 0`
volPerExchange is freshly created empty on line 142, so size is always 0, making hasPairSnapshots always true. The variable is never read again. The comment "re-evaluated below" is wrong. No functional impact.
Fix: delete line 143.

**3. min_net_spread_pct is never the binding threshold (LOW — misleading config)**
In both prod and test configs, entry_buffer_multiplier produces a threshold larger than min_net_spread_pct. The min_net check never fires. See project_fee_spread_model.md for details.

**4. effectiveCapital not passed to OpportunityTracker.poll() (INFORMATIONAL)**
File: arbitrage-detector/opportunityTracker.ts line 93
computeSpread called without capitalUsdt override during fast-path polling.
Currently no data impact: logOpportunityTick only writes netSpreadPct (not estimatedPnlUsdt) to ticks table. Would become a real bug if estimatedPnlUsdt is ever added to the ticks schema.

**5. Order book depth not used in notional sizing (MEDIUM — alarm quality)**
BookTick type only has best bid/ask, no quantity. effectiveCapital uses 0.1% of 24h volume as a proxy for depth. Reported notional may exceed actual fillable size at best price. Not labeled in opportunity records.

**How to apply:** Reference when reviewing changes to detector.ts line 143, docker-compose.prod.yml, or any code that calls computeSpread in opportunityTracker.
