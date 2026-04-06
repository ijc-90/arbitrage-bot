# Arbitrage Trading Review

Reviewed: 2026-04-06
Scope: Full source review — `arbitrage-detector/`, `pair-fetcher/`, `scenarios/`, `docker-compose.prod.yml`, `config.yaml`, `config.test.yaml`

---

## Summary

The alarm-only detector is architecturally sound. The two-speed loop (slow scan + non-blocking OpportunityTracker fast-path), fee-inclusive spread engine, and volume-capped capital sizing are all correctly implemented. No calculation error would cause a false positive in production: every detected opportunity genuinely exceeds fees, slippage estimates, and the entry buffer multiplier. The scenario suite covers the critical edge cases (negative spread, below-fees, below-buffer, inversion, convergence). Five issues were found — one security-relevant, the rest low-severity or cosmetic — and none corrupt the financial record as it stands today.

The second section documents what would need to be built to convert this detector into a live execution engine. The gap is substantial: the entire execution layer, position management, capital inventory, risk controls, and exchange connectivity for order placement do not exist.

---

## Part 1 — Bugs and Discrepancies

### 1. TLS Certificate Validation Disabled in Production

**File:** `docker-compose.prod.yml`, all three services (`detector`, `pair-fetcher`, `dashboard`)
**Severity:** High (security)

```yaml
environment:
  - NODE_TLS_REJECT_UNAUTHORIZED=0
```

All HTTP calls from the detector and pair-fetcher to the real Binance, Bybit, and BingX APIs are made with TLS certificate verification disabled. A man-in-the-middle attacker on the network path could serve spoofed price feeds. Since the detector's entire purpose is to detect price differences between exchanges, spoofed prices produce false arbitrage signals — fake opportunities that don't exist on the real market. The `dashboard` service does not make outbound API calls and does not need this flag at all.

**Fix:** Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` from all three services. If the real exchange APIs require it (they do not), investigate certificate chain issues rather than disabling validation globally.

---

### 2. Dead Variable with Inverted Logic and Misleading Comment

**File:** `arbitrage-detector/detector.ts`, line 143
**Severity:** Low (dead code, no runtime impact)

```typescript
const volPerExchange = new Map<string, Map<string, number>>()  // line 142
const hasPairSnapshots = volPerExchange.size === 0  // re-evaluated below  ← line 143
```

`volPerExchange` is a freshly initialized empty Map on line 142. On line 143, `volPerExchange.size` is always `0`, so `hasPairSnapshots` is always `true`. This is the inverted meaning of what the name implies ("has snapshots" should be `true` when data exists, not when the map is empty). The comment "re-evaluated below" is incorrect: the variable is never assigned again and is never read anywhere in the file. It is entirely dead code.

There is no functional impact today. The actual snapshot-presence check is correctly implemented via `exchangesWithVolumeData.size > 0` on line 176.

**Fix:** Delete line 143 entirely.

---

### 3. `min_net_spread_pct` Is Never the Binding Threshold in Production

**File:** `arbitrage-detector/config.yaml`
**Severity:** Low (misleading config, not a bug)

The opportunity entry condition in `spreadEngine.ts` is a conjunction of two checks:

```typescript
netAB >= config.min_net_spread_pct &&
netAB >= allInCostAB * config.entry_buffer_multiplier
```

In the production config:

```
taker_fee_pct: 0.10 per exchange  →  combined 0.20%
slippage_estimate_pct: 0.04 per exchange  →  combined 0.08%
all_in_cost = 0.28%
entry_buffer_multiplier = 2.0
buffer_threshold = 0.28 * 2.0 = 0.56%
min_net_spread_pct = 0.15%
```

The buffer threshold (0.56%) is always larger than `min_net_spread_pct` (0.15%), so the first condition is never the binding constraint. An operator could set `min_net_spread_pct` to any value below 0.56% and it would have zero effect on which opportunities are flagged. This creates a false sense of configurability and could mislead someone tuning the system.

In `config.test.yaml` the same situation holds: buffer = 0.20 * 1.5 = 0.30% > min_net = 0.10%.

`min_net_spread_pct` would only matter if `entry_buffer_multiplier` were set below `min_net / all_in_cost`, which for production values means below 0.536. At current values the parameter is purely decorative.

**Recommendation:** Either raise `min_net_spread_pct` to equal the buffer threshold (documenting that it acts as a sanity floor), or remove the parameter and consolidate entry logic to a single threshold.

---

### 4. Order Book Depth Not Used in Notional Size Validation

**File:** `arbitrage-detector/spreadEngine.ts`, `arbitrage-detector/exchangeClient.ts`
**Severity:** Medium (alarm quality, not a calculation error)

The `BookTick` type contains only `bidPrice` and `askPrice`. The system never fetches or evaluates the quantity available at the best bid/ask. The `effectiveCapital` sizing formula (`min(capital_per_trade_usdt, 0.1% of daily volume)`) uses 24-hour aggregate volume as a proxy for depth-at-price, which is a reasonable heuristic for liquid pairs but can over-report viable size in two scenarios:

- **Thin order books at the moment of detection:** A pair may have high daily volume but fragmented order books. A $500 USDT market order against a best-ask with only $80 available would walk the book and incur slippage well beyond the `slippage_estimate_pct`.
- **Momentarily stale top-of-book:** The `bookTicker` endpoint returns the single best level; actual fillable depth at that price may be much less.

Since this is an alarm-only system, no trades execute. However, opportunities are labeled with `estimatedPnlUsdt` derived from `capital_per_trade_usdt`, which implies that amount is actually tradeable at the quoted spread. If the book is thin, the reported PnL overstates what a human actor could capture.

This is noted in the BACKLOG design decision for `capital_per_trade_usdt`, but the risk is not surfaced in the opportunity record itself.

**Recommendation:** Add a `depth_confidence: 'volume_proxy'` annotation to logged opportunities to make the depth assumption explicit. For auto-trading, a real-time depth check against the `/depth` endpoint would be required.

---

### 5. `effectiveCapital` Not Threaded Into `OpportunityTracker.poll()`

**File:** `arbitrage-detector/opportunityTracker.ts`, line 93
**Severity:** Informational (no current data impact)

```typescript
const result = computeSpread(exchangeA, tickA, exchangeB, tickB, config)
```

During the fast-path polling loop, `computeSpread` is called without the `capitalUsdt` override. This means `result.estimatedPnlUsdt` inside the poll uses `config.capital_per_trade_usdt` rather than the volume-capped effective capital that was used when the opportunity was opened. For a pair where the volume cap reduces capital from 500 to, say, 80 USDT, tick-level spread results would carry an inflated `estimatedPnlUsdt`.

Currently this has **no data impact** because `logOpportunityTick` only writes `ask_buy`, `bid_sell`, and `net_spread_pct` to the `ticks` table — it does not store `estimatedPnlUsdt`. The opportunity-level PnL (`opp.estimatedPnlUsdt`) is set once at open from the correctly-sized spread and is never updated by the tracker. The inconsistency is therefore latent.

If `estimatedPnlUsdt` is ever added to the `ticks` schema, this mismatch would produce inflated per-tick PnL for illiquid pairs.

---

## Part 2 — Gap Analysis: Alarm Mode to Automatic Trading

The following describes every component that would need to be built or fundamentally changed to convert this detector into a live execution engine. Items are ordered roughly by dependency: you cannot build the later items without the earlier ones.

---

### Gap 1 — Exchange Order Placement APIs

**What is missing:** The system has no mechanism to place, modify, or cancel orders on any exchange. `ExchangeClient` only reads prices (GET endpoints). No POST or authenticated endpoints exist.

**What is required:**
- API key management with secret signing (HMAC-SHA256 for Binance and Bybit; ECDSA for BingX)
- Authenticated order submission: `POST /api/v3/order` (Binance), `POST /v5/order/create` (Bybit), `POST /openApi/spot/v1/trade/order` (BingX)
- Order type support: at minimum `MARKET` for guaranteed fill; `LIMIT` with IOC/FOK flag for controlled execution
- Order status polling or WebSocket subscription to confirm fill state
- Cancel-on-miss logic: if the leg-1 fill is confirmed but leg-2 is delayed or partially filled, the open leg must be cancelled or hedged

**Risk note:** Leg-1 fills but leg-2 does not (exchange downtime, rate limit, stale price) leaves a naked position. This is the primary execution risk in arbitrage.

---

### Gap 2 — Simultaneous Dual-Leg Execution

**What is missing:** Arbitrage requires buying on exchange A and selling on exchange B at the same time. The current architecture processes one exchange at a time and cannot coordinate parallel order submission.

**What is required:**
- Two orders must be submitted in parallel (`Promise.all` or equivalent), not sequentially
- A timing budget: both orders must be submitted within a window small enough that prices haven't moved (typically < 50ms for liquid pairs)
- Leg synchronization: track fill status for both legs together; if one leg fails, the other must be handled (cancel or counter-trade)
- Idempotent order IDs (client order IDs) so retried submissions don't double-fill

**Latency note:** The current slow_poll_interval_ms is 5000ms. By the time an opportunity is detected and acted upon under the current loop, the spread has almost certainly narrowed or disappeared for tight-margin trades. Execution latency must be reduced to the order of tens of milliseconds, requiring persistent WebSocket connections rather than polling.

---

### Gap 3 — Pre-Positioned Capital Inventory

**What is missing:** Cross-exchange spot arbitrage requires capital to be pre-positioned on both exchanges before an opportunity arises. The system currently has no model of available balances.

**What is required:**
- A balance manager that queries account balances on each exchange at startup and periodically
- Per-exchange, per-asset inventory tracking: USDT (to buy) and the target asset (to sell) must both be available on the correct exchanges
- Capital allocation logic: before accepting an opportunity, confirm that sufficient free balance exists on the buy exchange (USDT) and the sell exchange (base asset)
- Reserve management: some USDT must remain liquid for fees; some asset inventory must be maintained for future sell-legs
- Inventory rebalancing: after a round-trip, one exchange has more base asset and the other has more USDT. Rebalancing (via withdrawal or counter-trade) is required to remain operational

**Critical:** Without pre-positioned capital, cross-exchange arbitrage is not executable in real time. Asset transfers (withdrawal → deposit) take minutes to hours depending on the network and exchange processing times. This is entirely unsupported in the current system.

---

### Gap 4 — Real-Time Price Feed (WebSocket)

**What is missing:** The detector polls REST endpoints every 5 seconds (slow loop) or 200ms (fast loop). WebSocket book-ticker streams are available on all three exchanges and deliver updates in under 10ms.

**What is required:**
- WebSocket connections to all exchanges: Binance `wss://stream.binance.com:9443/ws/<symbol>@bookTicker`, Bybit `wss://stream.bybit.com/v5/public/spot`, BingX `wss://open-api-ws.bingx.com/market`
- An in-memory order book state updated on every message
- Reconnect logic with exponential backoff
- Message integrity checks (sequence numbers where available)

**Why it matters for execution:** A 5-second polling interval means an opportunity may have been live for up to 5 seconds before detection, and may close a second later. For execution to be viable, the system must detect the opportunity within milliseconds of it opening, not seconds.

---

### Gap 5 — Order Book Depth at Execution Price

**What is missing:** The spread engine uses only the best bid/ask. It does not know how much quantity is available at that price. The slippage estimate (0.04%) is a fixed constant, not derived from actual book depth.

**What is required:**
- Level-2 order book data (top 5–20 levels) for each pair being actively monitored
- Fill simulation: given a capital amount, walk the order book to compute the expected average fill price and resulting effective spread
- Dynamic slippage: replace the fixed `slippage_estimate_pct` with a computed value based on actual depth
- Minimum viable depth check: if the available quantity at the best level is below a minimum threshold (e.g., 0.5 BTC for a BTC trade), skip or reduce position size

---

### Gap 6 — Position and Risk Controls

**What is missing:** The system has no position tracking, no loss limits, and no circuit breakers.

**What is required:**

**Position tracking:**
- Maximum concurrent open positions (currently any opportunity blocks others; for execution, track filled vs. unfilled legs separately)
- Per-pair and per-exchange notional exposure limits
- Net delta tracking: if leg-1 fills but leg-2 is delayed, the account has directional exposure

**Loss controls:**
- Maximum loss per trade (stop-loss on a partially filled leg)
- Maximum daily loss across all trades (circuit breaker that halts the engine)
- Maximum drawdown from peak balance

**Rate limiting:**
- Each exchange imposes API rate limits (Binance: 1200 req/min weight; Bybit: varies by endpoint). Execution-speed order placement could exhaust these limits
- Order submission must be throttled and rate-limit headers monitored

**Exchange counterparty controls:**
- Withdrawal limits per 24h on each exchange constrain rebalancing
- KYC tier affects withdrawal ceilings; verify that available limits support intended trading volume

---

### Gap 7 — Latency Measurement and Opportunity Decay Model

**What is missing:** The system does not measure how quickly opportunities expire in practice, and therefore cannot know whether detected opportunities are still actionable by the time an order could be submitted.

**What is required:**
- Per-opportunity latency attribution: detection time → order submission → fill confirmation
- Spread decay tracking: measure how much of the spread remains at fill time vs. detection time (this requires historical execution data)
- Minimum executable spread: the `min_net_spread_pct` threshold must account for the spread decay between detection and fill, not just fees. If the average spread decays by 0.10% between detection and fill, the threshold should be raised by at least that amount
- Staleness guard: if time since last price update exceeds a threshold (e.g., 200ms), decline to submit orders against that price

---

### Gap 8 — Withdrawal and Transfer Automation (for Capital Rebalancing)

**What is missing:** When the buy-side exchange accumulates base asset and the sell-side accumulates USDT, capital must be moved between exchanges to restore the inventory needed for future trades. This is entirely manual today.

**What is required:**
- Withdrawal API integration for each exchange
- Network fee awareness: on-chain withdrawal fees reduce effective PnL; these are not modeled anywhere
- Transfer time model: block confirmation times vary by asset and network (USDT-TRC20: ~1 min; USDT-ERC20: 5–15 min; BTC: 10–60 min)
- Rebalancing trigger: decide when inventory imbalance is large enough to warrant a withdrawal (minimize transfer fees by batching)

**Risk note:** During a transfer, the capital is in transit and unavailable. If a large opportunity appears while funds are in flight, the engine cannot act on it.

---

### Gap 9 — Execution Audit Log and PnL Attribution

**What is missing:** The current opportunity log records estimated PnL based on the entry spread and configured capital. There is no record of actual fill prices, actual fees charged, or realized PnL.

**What is required:**
- Fill receipt storage: actual fill price, fill quantity, actual fee charged (in quote asset or fee token), timestamp of fill confirmation
- Realized PnL calculation: `(fill_price_sell * qty_sell - fee_sell) - (fill_price_buy * qty_buy + fee_buy)`, in a common currency (USDT)
- Slippage attribution: compare estimated spread at detection time to realized spread at fill, per trade
- Cumulative account balance reconciliation: periodically query actual exchange balances and reconcile against the internal model

---

### Gap 10 — Operational Reliability Infrastructure

**What is missing:** The current system recovers from a restart by marking open opportunities as ABANDONED. This is appropriate for an alarm bot. For live execution, unrecovered state means open positions and unresolved order legs.

**What is required:**
- Persistent order state: all submitted orders stored to DB with exchange order ID, leg (buy/sell), status, and timestamps
- Recovery on restart: on startup, query exchange order status APIs for any orders marked as PENDING in the DB and resolve their state
- Alerting: SMS/email/webhook notifications for circuit breaker triggers, unexpected errors, and large losses
- Health monitoring: heartbeat endpoint that an external monitor can poll; alert if the detector is silent for more than N seconds
- Dry-run mode: execute the full order flow against exchange sandbox environments before enabling live capital

---

## Summary Table

| Area | Current State | Status for Execution |
|---|---|---|
| Spread calculation | Correct, fee-inclusive | Ready |
| Fee modeling | Taker fees + slippage | Partial — no withdrawal fees, no maker fee option |
| Capital sizing | Volume-proxy cap | Partial — no actual book depth, no balance check |
| Exchange connectivity | Read-only REST polling | Missing — no auth, no order placement, no WebSocket |
| Dual-leg coordination | Not applicable | Missing entirely |
| Pre-positioned inventory | Not modeled | Missing entirely |
| Position / risk controls | Not applicable | Missing entirely |
| Order book depth | Not fetched | Missing — fixed slippage estimate only |
| Latency model | Not measured | Missing — polling interval is 5–200ms, too slow |
| Realized PnL | Not applicable | Missing — only estimated PnL at entry |
| Withdrawal / rebalancing | Not modeled | Missing — withdrawal fees and transfer time ignored |
| Operational reliability | Restart marks open opps ABANDONED | Insufficient — no order recovery |
| TLS security | Disabled in prod | Bug — must be re-enabled |
