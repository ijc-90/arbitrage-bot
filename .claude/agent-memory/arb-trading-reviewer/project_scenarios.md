---
name: Scenario coverage
description: What each integration test scenario covers and verified arithmetic (as of 2026-04-06)
type: project
---

**Scenario files** live in `scenarios/` at repo root. Used by mock-exchange server and integration test runner.

**Detector integration scenarios (used by arbitrage-detector/tests/integration/):**

| Scenario | What it tests | Key arithmetic |
|---|---|---|
| scenario_detector_001_no_opportunity | Main loop cycles, no opportunity fires | binance ask > bybit bid all 3 steps |
| scenario_detector_002_opportunity_opens | Opportunity detected and logged | step2: raw≈0.555%, net≈0.355% > buffer(0.30%) |
| scenario_detector_003_holdout | Full open→close lifecycle (ETH/USDT) | step1: raw=0.585%, net=0.385% > buffer(0.30%) → OPENED; step2: converges → CLOSED |
| scenario_detector_004_below_fees | Positive raw spread eaten by fees | raw=0.0116%, net=-0.188% → no opp (comment says 0.012%, close enough) |
| scenario_detector_005_below_buffer | Net above min_net but below buffer | raw=0.400%, net=0.200%, buffer=0.30% → no opp |
| scenario_detector_006_prices_intersect | No false positive at zero-spread crossing | exact intersection step: net=-0.200% |
| scenario_detector_007_inversion | Two opportunities, opposite directions | OPP A: raw=0.578%, net=0.378%; OPP B: raw=0.571%, net=0.371% |

**Arithmetic verified:** All scenario comments checked against formulas. scenario_004 comment says 0.012% for raw spread; actual is 0.01156% — illustrative rounding, not an error. All other scenario arithmetic is correct to 3 decimal places.

**Not covered by scenarios:**
- Exchange returning HTTP 5xx mid-opportunity (only UND_ERR_SOCKET retry tested in opportunityTracker code)
- Opportunity fires but one exchange has zero balance (no balance modeling)
- All three exchanges simultaneously present (only two-exchange pairs tested)
- BingX-specific symbol blacklisting behavior

**Config used in detector tests:** config.test.yaml (taker=0.06%, slip=0.04%, all_in=0.20%, buffer_multiplier=1.5, buffer_threshold=0.30%)
