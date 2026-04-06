# Auto-Trading Implementation Plan

Derived from the AT-1 through AT-10 gap analysis in BACKLOG.md and TRADING_REVIEW.md.
This is alarm-only today. The steps below trace the full path to live execution.

Each step includes: what it is, why it comes here in the sequence, what files/interfaces to touch, and a ready-to-paste Claude Code prompt.

---

## Sequencing rationale

```
Phase 1 — Real-time data        AT-4, AT-5
Phase 2 — Pre-execution         AT-3
Phase 3 — Execution engine      AT-1, AT-2
Phase 4 — Risk & observability  AT-6, AT-7, AT-9
Phase 5 — Operations            AT-10, AT-8
```

Dependencies flow top to bottom. You cannot place orders (Phase 3) without knowing balances (AT-3) or real prices (AT-4). You cannot measure latency (AT-7) without fills (AT-1, AT-2). Risk controls (AT-6) must exist before going live, so they gate Phase 5.

---

## Phase 1 — Real-time data infrastructure

### Step 1 — AT-4: WebSocket price feeds

**What:** Replace the REST polling loop (5 000ms slow / 200ms fast) with persistent WebSocket book-ticker streams for all monitored pairs. REST polling introduces up to 5s of stale-price exposure on every detected opportunity.

**Why first:** Every other component downstream depends on having current prices. Execution speed is irrelevant if the input prices are 5 seconds old.

**Scope:**
- Add `WsFeedManager` class in `arbitrage-detector/wsFeed.ts`
- One shared WebSocket connection per exchange (Binance: `wss://stream.binance.com`, Bybit: `wss://stream.bybit.com`, BingX: TBD)
- Subscribe to `<symbol>@bookTicker` for all auto-pairs after the first slow scan
- Reconnect with exponential backoff (base 1s, cap 30s); re-subscribe on reconnect
- Expose a `getTick(exchange, symbol): Tick | undefined` method replacing `getBookTicker` REST calls in the main loop
- Fall back to REST if no WS tick received within a staleness threshold (configurable, e.g. 2s)
- Update `detector.ts` main loop and `opportunityTracker.ts` fast-path to read from `WsFeedManager` instead of calling `exchangeClient.getBookTicker`
- Add `ws` or `ws` npm package; handle ping/pong keepalive per exchange spec

**Key risk:** Binance limits combined stream subscriptions. Check symbol count at startup and split into multiple streams if >1024 pairs.

**Claude Code prompt:**
```
Add a WebSocket book-ticker feed manager to the arbitrage detector.

Create `arbitrage-detector/wsFeed.ts` with a `WsFeedManager` class that:
- Accepts the list of (exchange, symbol) pairs to subscribe to
- Opens one persistent WebSocket per exchange (Binance: wss://stream.binance.com/stream, Bybit: wss://stream.bybit.com/v5/public/spot, BingX: documented endpoint)
- Subscribes to book-ticker channels on connect and re-subscribes on reconnect
- Reconnects with exponential backoff (1s base, 30s cap)
- Exposes getTick(exchange: string, symbol: string): Tick | undefined
- Tracks lastUpdatedAt per (exchange, symbol) so callers can detect stale ticks

Update detector.ts and opportunityTracker.ts to read ticks from WsFeedManager instead of calling exchangeClient.getBookTicker. Fall back to REST if the WS tick is older than a configurable staleness_threshold_ms (add to config.yaml).

Read the existing exchangeClient.ts, detector.ts, and opportunityTracker.ts before writing anything. The Tick interface is in spreadEngine.ts.
```

---

### Step 2 — AT-5: Level-2 order book depth and dynamic slippage

**What:** Replace the fixed `slippage_estimate_pct` constant with a per-trade value computed by walking the actual order book. Add a minimum-depth guard that reduces or skips position size when the available quantity at best price is insufficient.

**Why here:** Without depth, `estimated_pnl_usdt` is wrong for any trade above ~$5k notional on a thin pair. This must be correct before orders are placed.

**Scope:**
- Add `fetchOrderBook(exchange, symbol, depth: number): Promise<{ bids: [price, qty][], asks: [price, qty][] }>` to `ExchangeClient`
- Add `computeEffectiveFill(levels: [price, qty][], notionalUsdt: number): { avgPrice: number, filledQty: number, slippagePct: number }` in a new `orderBook.ts`
- Update `computeSpread` (or add a wrapper) to accept effective ask/bid prices derived from book walking rather than best-price ticks
- Add config keys: `order_book_depth` (default 10), `min_fill_ratio` (default 0.9 — skip if less than 90% of intended notional can be filled at quoted levels)
- Log `depth_slippage_pct` alongside `net_spread_pct` in the `prices` table (new column, nullable for backward compat)
- Update the `prices` DB schema; no migration needed for existing rows (column is nullable)

**Claude Code prompt:**
```
Add level-2 order book depth fetching and dynamic slippage computation to the arbitrage detector.

1. In `arbitrage-detector/exchangeClient.ts`, add `fetchOrderBook(exchange: string, symbol: string, depth: number): Promise<{ bids: [number, number][], asks: [number, number][] }>`. Implement for Binance (/api/v3/depth), Bybit (/v5/market/orderbook), and BingX (document endpoint). Depth parameter maps to the `limit` query param.

2. Create `arbitrage-detector/orderBook.ts` with `computeEffectiveFill(levels: [number, number][], notionalUsdt: number): { avgPrice: number, filledUsdt: number, slippagePct: number }`. Walk the levels from best price outward, accumulate qty*price until notional is met. `slippagePct` = (avgPrice - bestPrice) / bestPrice * 100.

3. Add `order_book_depth: number` and `min_fill_ratio: number` to config.yaml and config.test.yaml, and to the Config interface in config.ts.

4. In the main scan loop in detector.ts, after fetching ticks, call fetchOrderBook for both exchanges, compute effective fill prices, and pass the adjusted ask/bid into computeSpread via the capitalUsdt override path. If filledUsdt / capitalUsdt < min_fill_ratio, skip the pair for this cycle (log a warning).

5. Add a nullable `depth_slippage_pct REAL` column to the `prices` table in db.ts. Write the computed value when available.

Read all files before writing. Do not change the SpreadResult interface shape — the effective prices are an input to computeSpread, not an output.
```

---

## Phase 2 — Pre-execution infrastructure

### Step 3 — AT-3: Inventory and balance manager

**What:** Track free USDT and base-asset balances per exchange in memory, refreshed periodically via balance REST APIs. Gate every execution opportunity on a balance check — if either leg cannot be funded, decline and log why.

**Why here:** You cannot place an order without knowing that the capital is there. This is the single hardest constraint for cross-exchange arb: capital must already be on the right exchange before detection, not moved on the fly.

**Scope:**
- Add `fetchBalances(exchange: string): Promise<Record<string, number>>` to `ExchangeClient` (authenticated — requires API keys)
- Add API key loading to `loadEnv()`: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BYBIT_API_KEY`, etc. in `.env` / `.env.prod`
- Create `arbitrage-detector/inventoryManager.ts`: `InventoryManager` class
  - `refresh()` — polls all exchange balance APIs, stores result in memory
  - `canFund(exchangeBuy, exchangeSell, symbol, notionalUsdt): boolean` — checks USDT on buy side, base-asset on sell side
  - `reserve(...)` / `release(...)` — optimistic lock to prevent double-spending during concurrent opportunity checks
  - Refresh on startup, then every `balance_refresh_interval_ms` (add to config)
- Wire into `OpportunityTracker.open()`: call `inventoryManager.canFund` before logging an opportunity; if false, do not open, log `skipped_reason: 'insufficient_balance'`
- Add `.env.prod.example` entries for all new key variables

**Key risk:** API key storage — never log or commit keys. Load exclusively from env vars.

**Claude Code prompt:**
```
Add an inventory and balance manager to the arbitrage detector. This is pre-execution infrastructure — it gates opportunity logging on having sufficient capital on both exchanges.

1. In `arbitrage-detector/exchangeClient.ts`, add authenticated `fetchBalances(exchange: string): Promise<Record<string, number>>` (asset → free balance). Sign requests with HMAC-SHA256 using keys from env vars (BINANCE_API_KEY/SECRET, BYBIT_API_KEY/SECRET, BINGX_API_KEY/SECRET). Implement for each exchange using their spot account balance endpoints.

2. Update `arbitrage-detector/config.ts` loadEnv() to read and expose API keys from environment variables (not config.yaml — keys never go in YAML).

3. Create `arbitrage-detector/inventoryManager.ts` with class `InventoryManager`:
   - Constructor takes ExchangeClient and config
   - `refresh(): Promise<void>` — fetches balances for all configured exchanges
   - `canFund(exchangeBuy: string, exchangeSell: string, symbol: string, notionalUsdt: number): boolean` — checks free USDT >= notionalUsdt on buy exchange, free base asset >= notionalUsdt / askPrice on sell exchange
   - `reserve(id, ...)` and `release(id)` for optimistic locking
   - Runs refresh() on startup, then on a timer (add `balance_refresh_interval_ms` to config.yaml)

4. In `arbitrage-detector/opportunityTracker.ts`, inject InventoryManager and call canFund() in the open() method before creating a DB record. If insufficient, log a console warning with the reason and return without opening.

Read all existing files before writing. Never log or print API keys. Add placeholder entries to .env.prod.example.
```

---

## Phase 3 — Execution engine

### Step 4 — AT-1: Exchange order placement APIs

**What:** Add authenticated order submission to `ExchangeClient`: place a market or IOC limit order, receive a fill report, and cancel an open order by ID.

**Why here:** This is the first piece that touches real money. It requires Phase 1 (real prices) and Phase 2 (inventory gating) to already exist.

**Scope:**
- Add to `ExchangeClient`:
  - `placeOrder(exchange, symbol, side: 'BUY'|'SELL', type: 'MARKET'|'LIMIT_IOC', qty, price?): Promise<OrderResult>`
  - `cancelOrder(exchange, symbol, orderId: string): Promise<void>`
  - `getOrderStatus(exchange, symbol, orderId: string): Promise<OrderStatus>`
- `OrderResult`: `{ orderId, status, filledQty, avgPrice, fee, timestamp }`
- `OrderStatus`: `'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED'`
- Implement per exchange: Binance (`POST /api/v3/order`), Bybit (`POST /v5/order/create`), BingX
- Add `newClientOrderId` (UUID) to every order for idempotent retry safety
- Add `execution_enabled: false` flag to config.yaml — orders only placed when explicitly `true`; defaults to false (dry-run safe)
- Write integration tests against exchange sandbox environments (Binance testnet, Bybit testnet)

**Claude Code prompt:**
```
Add authenticated order placement to ExchangeClient in the arbitrage detector.

Add three methods to `arbitrage-detector/exchangeClient.ts`:
- `placeOrder(exchange, symbol, side: 'BUY'|'SELL', type: 'MARKET'|'LIMIT_IOC', qty: number, price?: number): Promise<OrderResult>`
- `cancelOrder(exchange, symbol, orderId: string): Promise<void>`
- `getOrderStatus(exchange, symbol, orderId: string): Promise<OrderStatus>`

Define in a new `arbitrage-detector/types.ts`:
- `OrderResult`: orderId, clientOrderId, status, filledQty, avgFillPrice, feeUsdt, timestamp
- `OrderStatus`: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED'

Implement for Binance (POST /api/v3/order, testnet: testnet.binance.vision), Bybit (POST /v5/order/create, testnet: api-testnet.bybit.com), and BingX. Each order must include a client order ID (uuid v4) for idempotent retries. Sign with HMAC-SHA256 using keys from env.

Add `execution_enabled: boolean` (default false) to config.yaml and Config interface. All order placement must check this flag and throw if false.

Do not wire this into the opportunity flow yet — that is the next step. Read all existing files first. Add sandbox base URLs alongside prod URLs in .env.prod.example.
```

---

### Step 5 — AT-2: Dual-leg execution coordinator

**What:** Build `ExecutionCoordinator` that takes an open opportunity and submits both legs simultaneously, handles the partial-fill and one-leg-failure cases, and records the outcome.

**Why here:** Depends on AT-1 (order placement), AT-3 (inventory), and AT-6 would ideally precede this — but a minimal risk guard (max 1 concurrent position) can be embedded here, with full AT-6 coming next.

**Scope:**
- Create `arbitrage-detector/executionCoordinator.ts`
  - `execute(opportunity: OpenOpportunity): Promise<ExecutionOutcome>`
  - Submit buy and sell legs in parallel via `Promise.allSettled`
  - If both fill: record success, release inventory reservation
  - If one fails: cancel or hedge the open leg (market order in reverse), record `partial_loss`
  - Retry a REJECTED order once with a fresh client order ID; do not retry FILLED or CANCELED
  - Latency budget: if `Date.now() - opportunity.detectedAt > max_execution_age_ms`, abort both legs before submitting
- Add `max_execution_age_ms: 500` to config
- Wire into `OpportunityTracker`: call `coordinator.execute()` immediately after `open()` if `execution_enabled: true`
- Persist outcome to a new `executions` table (opportunityId, leg, orderId, status, filledQty, avgPrice, feeUsdt, executedAt)

**Claude Code prompt:**
```
Build the dual-leg execution coordinator for the arbitrage detector.

Create `arbitrage-detector/executionCoordinator.ts` with class `ExecutionCoordinator`:
- Constructor takes ExchangeClient, InventoryManager, and Config
- `execute(opp: { id, exchangeBuy, exchangeSell, symbol, askBuy, bidSell, capitalUsdt }): Promise<ExecutionOutcome>`
  - Checks `Date.now() - detectedAt < config.max_execution_age_ms` — abort if stale
  - Submits buy (MARKET) and sell (MARKET) legs in parallel via Promise.allSettled
  - If both settle FILLED: release inventory, return success
  - If one fails: place a market order in the reverse direction on the filled leg to flatten the position, return partial_loss with details
  - Retries a REJECTED order exactly once with a new clientOrderId

Add `max_execution_age_ms: 500` to config.yaml and Config interface.

Create the `executions` table in db.ts: id, opportunity_id, leg ('buy'|'sell'), order_id, client_order_id, status, filled_qty, avg_fill_price, fee_usdt, executed_at.

Wire into opportunityTracker.ts: after open(), if config.execution_enabled is true, call coordinator.execute(). Log the outcome; do not throw on execution failure (log and continue monitoring).

Read all existing files before writing. Do not change the OpportunityTracker state machine — execution is a side effect of opening, not a new state.
```

---

## Phase 4 — Risk and observability

### Step 6 — AT-6: Position tracking and risk controls

**What:** Enforce hard limits before any order is submitted: max concurrent positions, per-exchange notional exposure, per-pair daily loss, and a global daily loss circuit breaker.

**Why here:** Risk controls must exist before going live. After Phase 3 is built against sandbox, Phase 4 is the gate before enabling `execution_enabled: true` on real capital.

**Scope:**
- Create `arbitrage-detector/riskManager.ts`
  - `RiskManager` holds live state: open positions count, per-exchange notional, cumulative daily PnL
  - `approve(opportunity): { ok: boolean, reason?: string }` — called before `coordinator.execute()`
  - `onFill(outcome)` — updates state after each execution
  - `onDayRollover()` — resets daily counters at UTC midnight
  - Circuit breaker: when `daily_loss_usdt` threshold is breached, set `halted = true`; must be manually reset or auto-resume next day
- Add to config.yaml: `max_concurrent_positions`, `max_notional_per_exchange_usdt`, `max_daily_loss_usdt`, `max_daily_loss_reset: 'manual' | 'midnight'`
- Add API rate-limit tracking per exchange: count requests in a rolling 60s window; warn at 80% of limit, pause at 95%
- Dashboard: add a `/api/risk` endpoint exposing current risk state; surface halted status and daily PnL prominently in the UI

**Claude Code prompt:**
```
Add position tracking and risk controls to the arbitrage detector.

Create `arbitrage-detector/riskManager.ts` with class `RiskManager`:
- In-memory state: openPositionsCount, perExchangeNotional (Map<exchange, usdt>), dailyRealizedPnl, halted (bool)
- `approve(opp): { ok: boolean, reason?: string }` — checks: not halted, openPositionsCount < max_concurrent_positions, per-exchange notional within limits
- `onOpen(opp)` — increments counters
- `onClose(outcome)` — decrements counters, updates dailyRealizedPnl; if dailyRealizedPnl < -max_daily_loss_usdt, set halted = true and log a CIRCUIT BREAKER alert
- `resetDay()` — resets daily PnL counter (call at UTC midnight via setInterval)

Add to config.yaml and Config interface: max_concurrent_positions (default 1), max_notional_per_exchange_usdt (default 1000), max_daily_loss_usdt (default 50).

Add a rolling rate-limit tracker per exchange: count outbound requests in a 60s sliding window; log a warning at 80% of each exchange's documented limit.

Wire RiskManager into executionCoordinator.ts: call approve() before execute(), call onOpen/onClose around it.

Add GET /api/risk to dashboard/server.ts: returns halted, openPositionsCount, dailyRealizedPnl, perExchangeNotional. Show a red banner in the dashboard UI when halted = true.

Read all files before writing.
```

---

### Step 7 — AT-7: Latency measurement and spread decay model

**What:** Instrument the full timing chain from price detection to fill confirmation. Use observed fill latency to compute how much spread decays between detection and fill, and raise the buffer threshold accordingly.

**Why here:** After Phase 3 has run against sandbox, you have real latency data. This step uses it to calibrate the config before enabling live capital.

**Scope:**
- Add timestamps at each stage: `detectedAt`, `executionStartedAt`, `buyOrderSentAt`, `sellOrderSentAt`, `buyFilledAt`, `sellFilledAt`
- Store in `executions` table (add columns or a `latency_ms` JSON blob column)
- Add `computeSpreadAtFill(avgBuyPrice, avgSellPrice, allInCost): number` — realized net spread at fill prices vs. detected spread
- Log spread decay = `detectedNetSpread - realizedNetSpread` per trade
- Aggregate: mean, p50, p95 spread decay over rolling 100 trades
- Surface in a `/api/latency` dashboard endpoint; recommend new `entry_buffer_multiplier` as `ceil(all_in_cost * 2 + p95_spread_decay / all_in_cost)`

**Claude Code prompt:**
```
Add latency measurement and spread decay tracking to the arbitrage detector.

1. In executionCoordinator.ts, record timestamps at each stage: detectedAt (passed in from opportunity), executionStartedAt, buyOrderSentAt, sellOrderSentAt, buyFilledAt, sellFilledAt. Store these in the executions table — add nullable INTEGER columns for each.

2. After both legs fill, compute realized_net_spread_pct = (avgSellPrice - avgBuyPrice) / avgBuyPrice * 100 - allInCostPct. Compute spread_decay_pct = detectedNetSpreadPct - realized_net_spread_pct. Write both to the executions row.

3. Add a `LatencyStats` class (or module) in `arbitrage-detector/latencyStats.ts` that reads the last N executions from DB and returns: mean/p50/p95 of (buyFilledAt - detectedAt), and mean/p50/p95 of spread_decay_pct.

4. Add GET /api/latency to dashboard/server.ts: returns the stats object plus a suggested entry_buffer_multiplier based on p95 spread decay.

5. Add a staleness guard in opportunityTracker.ts fast-path: if the WS tick's lastUpdatedAt is older than a configurable price_staleness_threshold_ms (add to config.yaml, default 500ms), skip execution for that cycle.

Read all files before writing.
```

---

### Step 8 — AT-9: Realized PnL and fill audit log

**What:** Replace estimated PnL (computed at detection from quoted prices) with realized PnL (computed from actual fill prices). Reconcile periodically against exchange balance APIs to catch discrepancies.

**Why here:** Once AT-1/AT-2 are running and AT-7 has instrumented the fills, the data is available to compute accurate realized PnL.

**Scope:**
- The `fills` concept may already be embedded in the `executions` table from AT-2. If so, derive realized PnL from it: `(avgSellFill * filledQty - sellFee) - (avgBuyFill * filledQty + buyFee)`
- Add `realized_pnl_usdt` column to the `opportunities` table; populate it from `executions` on close
- Add reconciliation: every N hours, fetch balances via `InventoryManager.refresh()` and compare net balance delta (vs. session start snapshot) to sum of `realized_pnl_usdt`. Log a warning if they diverge by more than `reconciliation_tolerance_pct`
- Expose `realized_pnl_usdt` in the dashboard opportunities table (replace or supplement `estimated_pnl_usdt`)

**Claude Code prompt:**
```
Add realized PnL computation and periodic reconciliation to the arbitrage detector.

1. Add `realized_pnl_usdt REAL` to the opportunities table in db.ts (nullable — null for alarm-only opportunities). After a completed execution, compute: realized_pnl = (avgSellFillPrice * filledQty - sellFeeUsdt) - (avgBuyFillPrice * filledQty + buyFeeUsdt) and write it to the opportunity row.

2. Update GET /api/opportunity/:id and GET /api/snapshot in dashboard/server.ts to return realized_pnl_usdt alongside estimated_pnl_usdt. In the UI, show realized PnL for executed opportunities and estimated PnL for alarm-only ones; label clearly which is which.

3. Add a reconciliation job in `arbitrage-detector/reconciler.ts` that runs every reconciliation_interval_hours (add to config.yaml, default 4):
   - Calls InventoryManager.refresh() to get current balances
   - Computes expected balance = session_start_balance + sum(realized_pnl_usdt) for each asset
   - Logs a WARNING if actual vs expected diverges by more than reconciliation_tolerance_pct (config, default 0.5%)

4. Wire the reconciler startup into detector.ts alongside InventoryManager.

Read all files before writing. The fills data is already in the executions table from AT-2/AT-1.
```

---

## Phase 5 — Operations

### Step 9 — AT-10: Operational reliability for live execution

**What:** Harden the system for unattended production operation: restart recovery, alerting, heartbeat, and a proper dry-run mode against exchange sandboxes.

**Why here:** This is the final gate before enabling live capital. Nothing here changes trading logic — it makes the existing logic survivable in production.

**Scope:**
- **Restart recovery:** On startup, query each exchange for any open orders placed by this bot (by client order ID prefix). Cancel any PENDING orders that are stale (> 60s old). Log reconciliation outcome.
- **Alerting:** Send a webhook (configurable URL, POST JSON) on: circuit breaker triggered, unrecoverable execution error, reconciliation divergence. Format: `{ event, severity, detail, timestamp }`. Also support a simple email alert via SMTP if configured.
- **Heartbeat:** Add `GET /health` to the dashboard (or a new thin HTTP server in the detector) returning `{ status: 'ok'|'halted', uptime, lastOpportunityAt, lastExecutionAt }`. Use for external uptime monitoring (e.g. UptimeRobot).
- **Dry-run mode:** When `execution_enabled: false` and `dry_run_sandbox: true`, submit orders to exchange testnet URLs instead of live URLs. Validate that the full execution path works against real API structure before enabling live capital.

**Claude Code prompt:**
```
Add operational reliability features to the arbitrage detector for production readiness.

1. Startup recovery in detector.ts: before starting the main loop, call a new `recoverPendingOrders()` function that queries each exchange for open orders (using a known client order ID prefix, e.g. "arb-"). Cancel any order older than 60s. Log a summary.

2. Alerting: create `arbitrage-detector/alerting.ts` with `sendAlert(event: string, severity: 'info'|'warn'|'critical', detail: object): Promise<void>`. If ALERT_WEBHOOK_URL is set in env, POST JSON to it. If ALERT_SMTP_* vars are set, send an email. Call sendAlert from: riskManager.ts on circuit breaker trigger, executionCoordinator.ts on unrecoverable error, reconciler.ts on divergence.

3. Heartbeat: add GET /health to dashboard/server.ts. Returns JSON: { status ('ok'|'halted'), uptime_seconds, last_opportunity_at (ISO), last_execution_at (ISO), open_positions }. No auth required.

4. Sandbox dry-run: add `dry_run_sandbox: boolean` to config.yaml. When true and execution_enabled is false, exchangeClient.ts routes order placement calls to testnet base URLs (BINANCE_TESTNET_URL, BYBIT_TESTNET_URL from env). Log "[DRY-RUN SANDBOX]" prefix on every order call.

Read all files before writing. No changes to trading logic — this is purely operational hardening.
```

---

### Step 10 — AT-8: Withdrawal and transfer automation for rebalancing

**What:** When inventory imbalance exceeds a threshold (e.g. one exchange holds >70% of total USDT), initiate a cross-exchange transfer. This requires modeling on-chain withdrawal fees and confirmation times.

**Why last:** This is the most operationally complex and highest-risk feature. It moves funds autonomously across exchanges and chains. It must only be built after the entire execution and risk stack is stable and proven in live operation.

**Scope:**
- Add `initiateWithdrawal(exchange, asset, amount, toAddress, network): Promise<WithdrawalRecord>` to `ExchangeClient`
- Maintain a `withdrawals` DB table: id, fromExchange, toExchange, asset, amount, network, fee, txHash, status, initiatedAt, confirmedAt
- Add withdrawal fee and estimated confirmation time tables per (exchange, asset, network) — loaded from config or a static JSON file
- `InventoryManager.rebalance()`: triggered when max imbalance threshold is breached, computes optimal transfer (smallest fee, fastest confirmation), calls `initiateWithdrawal`, marks funds as in-flight in inventory state
- Block new position opens on the destination exchange while in-flight capital is unconfirmed
- Manual override: `POST /admin/rebalance` endpoint (admin-only, requires a shared secret header)

**Claude Code prompt:**
```
Add withdrawal and cross-exchange rebalancing to the arbitrage detector. This is the highest-risk feature — only implement after the full execution stack is stable in production.

1. Add `initiateWithdrawal(exchange, asset, amount, toAddress, network): Promise<{ withdrawalId, fee, estimatedMinutes }>` to exchangeClient.ts. Implement for Binance (/sapi/v1/capital/withdraw/apply), Bybit (/v5/asset/withdraw/create), BingX. Sign with HMAC.

2. Add a `withdrawals` table to db.ts: id, from_exchange, to_exchange, asset, amount_gross, fee_usdt, network, tx_hash, status ('PENDING'|'PROCESSING'|'SUCCESS'|'FAILED'), initiated_at, confirmed_at.

3. Create `arbitrage-detector/withdrawalFees.ts` — a static map of (exchange, asset, network) → { fee_usdt_estimate, avg_confirm_minutes }. Load from a JSON file at `arbitrage-detector/withdrawal-fees.json` (manually maintained, reviewed before use).

4. In InventoryManager, add `checkRebalanceNeeded(): boolean` (imbalance > max_imbalance_ratio, config default 0.70) and `rebalance(): Promise<void>` that selects the cheapest/fastest transfer route and calls initiateWithdrawal. Mark funds as in-flight; canFund() must treat in-flight funds as unavailable.

5. Add a status polling loop: every 5 minutes, call the exchange withdrawal-status endpoint for each PENDING withdrawal and update the DB row.

6. Add POST /admin/rebalance to dashboard/server.ts (requires X-Admin-Secret header matching env var ADMIN_SECRET). Returns current imbalance state and triggers rebalance() if threshold is met.

Read all existing files before writing. Never auto-rebalance without explicit config opt-in (`rebalancing_enabled: false` by default).
```

---

## Summary table

| Step | AT# | Phase | Key output | Depends on |
|------|-----|-------|-----------|------------|
| 1 | AT-4 | Data | `WsFeedManager`, sub-second price ticks | — |
| 2 | AT-5 | Data | `orderBook.ts`, dynamic slippage | Step 1 |
| 3 | AT-3 | Pre-exec | `InventoryManager`, balance gating | Step 1 |
| 4 | AT-1 | Exec | `placeOrder` / `cancelOrder` / `getOrderStatus` | Steps 2, 3 |
| 5 | AT-2 | Exec | `ExecutionCoordinator`, dual-leg parallel submit | Step 4 |
| 6 | AT-6 | Risk | `RiskManager`, circuit breaker, rate limits | Step 5 |
| 7 | AT-7 | Observability | Latency chain, spread decay, calibrated buffer | Step 5 |
| 8 | AT-9 | Observability | Realized PnL, reconciliation | Steps 5, 7 |
| 9 | AT-10 | Ops | Recovery, alerting, heartbeat, dry-run | Steps 6, 8 |
| 10 | AT-8 | Ops | Withdrawal automation, rebalancing | Step 9 |
