# Backlog

Alarm-only cross-exchange arbitrage detector. Tracks what's built, what's next, and open design decisions.

---

## Done

- **Pair fetcher** (`pair-fetcher/fetcher.ts`) — fetches 24h volume for all pairs per exchange (Binance `/api/v3/ticker/24hr`, Bybit `/v5/market/tickers?category=spot`); writes to `pair_snapshots` table in `arb.db`; runs on startup then every N hours (`--interval`). Mock endpoints added for both exchanges.
- **SQLite storage** via `better-sqlite3` — `opportunities`, `prices`, `ticks` tables; synchronous writes alongside JSONL audit logs (`arbitrage-detector/db.ts`, `logger.ts`)
- **Integration tests migrated to SQLite** — all 47 tests query the DB; each suite runs in an isolated `logs/` dir wiped before the run
- **Web dashboard** — independent Express process in `dashboard/`; reads DB readonly; polls `/api/snapshot` every 2s; shows live detector status, open opportunity, latest prices per pair, recent opportunities table, aggregate stats
- **`.gitignore`** — covers `node_modules/`, `logs/`, `dist/`, `*.db`, `.env`, `.DS_Store`
- **8 monitored pairs** in `config.yaml`: BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX (all binance+bybit)
- **Dashboard v2** — pairs table with sort (most opps / best spread / total PnL / volume 24h), symbol search, monitored-only vs all-pairs toggle; `GET /api/pairs` endpoint returns full pair universe from `pair_snapshots` enriched with spread+opp data for monitored pairs; unmonitored pairs shown dimmed with volume only; unified open+closed opportunities table (50 rows) with pair + status filters; opportunity detail panel (slide-in) with tick-by-tick SVG sparkline; `GET /api/opportunity/:id` endpoint
- **Docker / docker-compose** — `Dockerfile` in each service (`arbitrage-detector`, `dashboard`, `pair-fetcher`); `docker-compose.prod.yml` at root; shared named volume `arb-data` mounted at `/app/logs` in all three containers; exchange URLs injected via `.env.prod` (not baked into images); `.env.prod.example` committed as template
- **Dynamic pair detection** — detector uses bulk ticker endpoints (`GET /api/v3/ticker/bookTicker` for Binance, `GET /v5/market/tickers?category=spot` for Bybit) to fetch all pairs in 2 API calls per slow cycle; computes intersection of symbols present on all configured exchanges; filters by `min_volume_usdt` from `pair_snapshots` (skips filter if table empty — graceful startup); logs spread for every qualifying pair each cycle; when opportunity opens, `OpportunityTracker` fast-path polls only that pair at `fast_poll_interval_ms`; static `pairs:` in config still supported for test mode
- **Dead variable removed** — `hasPairSnapshots` in `detector.ts` was always `true` at assignment, never read, and had an inverted name. Deleted.
- **`min_net_spread_pct` removed** — redundant entry condition eliminated from `spreadEngine.ts`, `config.ts`, both config YAMLs, and tests. Entry is now gated solely by `net >= all_in_cost * entry_buffer_multiplier`. The removed condition was never binding (buffer threshold always exceeded it in both prod and test configs).

---

## Backlog

### Timing resolution
Track how precisely we know when an opportunity opened and closed.

**Close resolution** (`close_resolution_ms`): time between last tick and convergence detection — easy, derived from actual tick timestamps already stored.

**Open resolution** (`open_resolution_ms`): time since the pair was last scanned before detection. Requires `lastScannedAt: Map<string, number>` in the main detector loop, updated each scan, passed into `OpportunityTracker.open()`. First scan after startup = `NULL` (unknown).

Per-exchange granularity: track `lastSuccessfulFetchAt` per exchange in `ExchangeClient`. `open_resolution_ms` = `max(buy_gap, sell_gap)` — worst case wins.

Dashboard impact: show duration as a range (`12ms – 5.2s`) when resolution is low, rather than a single misleading number.

Schema columns to add to `opportunities`: `open_resolution_ms INTEGER`, `close_resolution_ms INTEGER`.

---

### Remove mock server and scenario infrastructure
Testing against real exchanges has proven faster and more reliable. The mock server (`mock-exchanges/`), scenario YAML files (`scenarios/`), `StepController` / `fastAdvance()` / `--steps` / `--advance-url` CLI flags, and integration test suites can all be deleted. The detector should become continuous-only (`ContinuousController`). Do not maintain backward compatibility with this infrastructure going forward.

---

### Dashboard enhancements (remaining)
- Price history retention policy — rolling window or prune by age to keep DB size bounded
- Duration range display once resolution tracking is implemented
- **Pair volume section** — surface `pair_snapshots` data: show 24h USDT volume per pair/exchange, flag pairs where our capital would exceed X% of daily volume (configurable threshold)
- **Pair view** — a dedicated view showing all symbols (BTC/USDT, ETH/USDT, …) with each symbol's routes listed beneath it (e.g. BTCUSDT: binance↔bybit, binance↔bingx, bybit↔bingx). Lets you compare spread performance across routes for the same symbol. Terminology: **pair** = two assets (BTCUSDT); **route** = a specific pair traded across two exchanges.

---

### Security — re-enable TLS certificate validation in production
**File:** `docker-compose.prod.yml`.
`NODE_TLS_REJECT_UNAUTHORIZED=0` is set on all three services. This disables TLS verification for all outbound HTTPS calls to exchange APIs, enabling man-in-the-middle attacks that could spoof price feeds and produce false arbitrage signals. Remove this env var from all services. The `dashboard` service has no outbound API calls and especially does not need it.

---

### Auto-Trading Gaps

The following items surface from the gap analysis in `TRADING_REVIEW.md`. None are prerequisites for alarm-only operation, but all are required before any live execution engine could be built on this codebase.

---

#### AT-1: Exchange order placement APIs
Add authenticated order submission to `ExchangeClient` for all three exchanges (Binance, Bybit, BingX). Requires API key management with HMAC-SHA256/ECDSA signing, `MARKET` and `LIMIT IOC/FOK` order types, fill confirmation via polling or WebSocket subscription, and cancel-on-miss logic for the open leg when the paired leg fails.

---

#### AT-2: Simultaneous dual-leg execution coordinator
Build an `ExecutionCoordinator` that submits both legs in parallel (`Promise.all`) within a latency budget (target < 50ms). Must handle partial fills, one-leg failures (cancel or hedge the open leg), and idempotent client order IDs for safe retries.

---

#### AT-3: Pre-positioned capital inventory manager
Track USDT and base-asset balances per exchange. Before accepting any execution opportunity, confirm free balance is sufficient on both the buy and sell sides. Trigger rebalancing when inventory imbalance exceeds a configured threshold. Without this, cross-exchange execution is impossible.

---

#### ~~AT-4: WebSocket real-time price feeds~~ ✓ DONE
`WsFeedManager` in `arbitrage-detector/wsFeed.ts`. Binance (combined-stream, 1024-symbol chunks) and Bybit (subscribe JSON + 20s ping) implemented. BingX deferred (gzip protocol). Exponential backoff reconnect (1s→30s). `getTick()` checks `staleness_threshold_ms` (config, default 2000ms); stale/missing → REST fallback. Detector caches qualifying pairs after REST discovery, then reads from WS cache each subsequent scan. Fast-path tracker (`opportunityTracker.ts`) also prefers WS tick. WsFeedManager only instantiated in production (`--steps` not set, WS URLs present). All 47 integration tests pass unchanged.

**To enable:** add to `.env` or `.env.prod`:
```
BINANCE_WS_URL=wss://stream.binance.com:9443
BYBIT_WS_URL=wss://stream.bybit.com
```

---

#### AT-5: Level-2 order book depth and dynamic slippage
Fetch top N order book levels (not just best bid/ask) for each candidate pair. Walk the book to compute expected average fill price given the intended notional. Replace the fixed `slippage_estimate_pct` constant with a per-trade computed value. Add a minimum-depth guard that skips or reduces position size when available quantity at best price is below threshold.

---

#### AT-6: Position tracking and risk controls
Add: maximum concurrent open positions, per-pair and per-exchange notional exposure limits, net delta tracking for partially-filled legs, per-trade stop-loss, maximum daily loss circuit breaker, and API rate-limit monitoring (Binance 1200 req/min weight budget). None of these exist today.

---

#### AT-7: Latency measurement and spread decay model
Instrument the full timing chain: detection → order submission → fill confirmation. Measure how much of the detected spread remains at fill time. Raise `min_net_spread_pct` (or the buffer threshold) by at least the average spread decay between detection and fill. Add a staleness guard that declines to trade against prices older than a configured threshold.

---

#### AT-8: Withdrawal and transfer automation for capital rebalancing
Model on-chain withdrawal fees (currently ignored entirely) and block confirmation times per asset/network. Add withdrawal API calls to `ExchangeClient`. Build a rebalancing trigger that batches withdrawals when inventory imbalance exceeds a threshold. Account for in-flight capital when computing available inventory.

---

#### AT-9: Realized PnL and fill audit log
Extend the DB schema with a `fills` table: actual fill price, quantity, actual exchange fee, fill timestamp, and exchange order ID. Compute realized PnL as `(fill_sell * qty - fee_sell) - (fill_buy * qty + fee_buy)`. Reconcile periodically against exchange balance APIs to catch discrepancies.

---

#### AT-10: Operational reliability for live execution
On restart, recover any PENDING orders by querying exchange order-status APIs. Add alerting (webhook/SMS/email) for circuit breaker triggers and unrecoverable errors. Add a heartbeat endpoint for external monitoring. Build a dry-run mode against exchange sandbox environments before enabling live capital.

---

## Design decisions on record

- **`capital_per_trade_usdt`** (config.yaml, default 500) is the hard maximum capital per trade. The actual deployed capital is `min(capital_per_trade_usdt, 0.1% of smaller exchange 24h volume)` — operating above 0.1% of daily volume risks meaningful price impact. This is computed per pair per cycle from `pair_snapshots` and passed into `computeSpread`. If volume data is unavailable the configured max is used.
- **Est. PnL is based on entry (opening) spread**, not peak. Peak spread is tracked separately (`peak_spread_pct`) but PnL reflects what you'd actually capture entering at the first observed price.
- **BingX uses hyphenated symbols** (`BTC-USDT`). Normalised to `BTCUSDT` in both the detector (`exchangeClient.ts`) and pair-fetcher before storage. Conversion back to BingX format happens in `getBookTicker` via `toBingXSymbol`.

- **JSONL kept in parallel** alongside SQLite as a flat audit log — human-readable, zero-dep recovery option
- **Dashboard is read-only** — no controls exposed via the web UI
- **Independent processes** — detector, dashboard, and mock-exchanges are three separate processes; dashboard reads SQLite directly, no IPC needed
- **`exchange_buy` / `exchange_sell`** field names kept in schema (matches detector internals); future rename to `exchange_cheap` / `exchange_expensive` deferred until resolution tracking is added (at which point the semantic distinction matters more)
