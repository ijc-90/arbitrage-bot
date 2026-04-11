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
- **Mock server and scenario infrastructure removed** — `mock-exchanges/`, `scenarios/`, `arbitrage-detector/tests/`, `config.test.yaml`, `StepController`, `ContinuousController`, `LoopController`, `fastAdvance()`, `--steps`, `--advance-url` all deleted. Detector is now continuous-only. Testing approach TBD.
- **TLS certificate validation re-enabled** — removed `NODE_TLS_REJECT_UNAUTHORIZED=0` from `docker-compose.prod.yml` (was set on `detector` and `pair-fetcher`). All outbound HTTPS calls to exchange APIs now validate certificates.
- **Timing resolution** — `open_resolution_ms` and `close_resolution_ms` added to `opportunities` table. `open_resolution_ms`: gap since the symbol was last scanned before detection (NULL on first scan after startup). `close_resolution_ms`: gap between the penultimate fast-poll and the convergence-detection poll (≈ `fast_poll_interval_ms`). DB migration in `initDb()` handles existing DBs via `ALTER TABLE`. Dashboard shows duration as a range (`3.2s – 5.0s`) when `open_resolution_ms > 500ms`, single value otherwise.
- **Price retention** — `prices` table pruned to a configurable rolling window (`price_retention_hours`, default 6h) on startup and every hour. `VACUUM` runs after each prune to reclaim disk. `0` disables pruning. `ticks` and `opportunities` kept forever.
- **Liquidity flag** — Routes table highlights rows yellow when `capital_per_trade_usdt / min_exchange_volume > liquidity_flag_threshold_pct` (default 0.1%). Detector writes capital + threshold to `detector_settings` table on startup; dashboard reads it from DB so the threshold stays in one place (config.yaml).
- **`entrySpreadPct` hardened** — `Opportunity` interface now carries an immutable `entrySpreadPct` field set once at open. Logger uses it instead of `peakSpreadPct` for the OPENED event, eliminating a fragile dependency on initialization order. `peakSpreadPct` continues to track the running maximum.

---

## Backlog

### Dashboard enhancements (remaining)
- **Pair view** — a dedicated view showing all symbols (BTC/USDT, ETH/USDT, …) with each symbol's routes listed beneath it (e.g. BTCUSDT: binance↔bybit, binance↔bingx, bybit↔bingx). Lets you compare spread performance across routes for the same symbol. Terminology: **pair** = two assets (BTCUSDT); **route** = a specific pair traded across two exchanges.

---

### Auto-Trading — Execution Roadmap

Priority order based on domain review (2026-04-11). Hard dependency chain: AT-7 → AT-3 → AT-1 → AT-6 → AT-2 → AT-5 → AT-9 → AT-10 → AT-8.

---

#### ~~AT-4: WebSocket real-time price feeds~~ ✓ DONE
`WsFeedManager` in `arbitrage-detector/wsFeed.ts`. Binance (combined-stream, 1024-symbol chunks) and Bybit (subscribe JSON + 20s ping) implemented. BingX deferred (gzip protocol). Exponential backoff reconnect (1s→30s). `getTick()` checks `staleness_threshold_ms` (config, default 2000ms); stale/missing → REST fallback. Detector caches qualifying pairs after REST discovery, then reads from WS cache each subsequent scan. Fast-path tracker (`opportunityTracker.ts`) also prefers WS tick. WsFeedManager only instantiated in production (`--steps` not set, WS URLs present). All 47 integration tests pass unchanged.

**To enable:** add to `.env` or `.env.prod`:
```
BINANCE_WS_URL=wss://stream.binance.com:9443
BYBIT_WS_URL=wss://stream.bybit.com
```

---

#### ~~AT-7: Spread decay analysis~~ ✓ DONE
`GET /api/decay` endpoint in `dashboard/server.ts`. Joins `ticks` to closed `opportunities`, buckets ticks by time-after-open (200ms, 500ms, 1s, 2s, 5s), computes avg spread at each bucket, avg % of entry spread retained, and % of opportunities still showing positive spread. Dashboard "Spread Decay" section renders the table (hidden until first opportunity data exists). Refreshes every 60s. Answers: if execution takes N ms, how much of the detected spread is left?

---

#### ~~AT-3: Pre-positioned capital inventory manager~~ ✓ DONE
`InventoryManager` in `arbitrage-detector/inventoryManager.ts`. Caches free balances per exchange (refreshed on startup + every 5min background loop). `canTrade(buyEx, sellEx, baseAsset, capital, price)` checks USDT on buy side and base-asset on sell side before any opportunity is accepted; `deduct()` optimistically updates cache to prevent double-spend on concurrent detections. Authenticated balance queries in `ExchangeClient.getBalances()` for Binance (HMAC-SHA256 `X-MBX-APIKEY`), Bybit (HMAC-SHA256 `X-BAPI-SIGN`), BingX (HMAC-SHA256 `X-BX-APIKEY`). API keys loaded from `.env` (`BINANCE_API_KEY` / `BINANCE_API_SECRET` pattern). Fully optional — detector runs in alarm-only mode if no keys are present. `.env.prod.example` updated with key slots and WS URL examples.

---

#### AT-1: Exchange order placement APIs
Add authenticated order submission to `ExchangeClient` for all three exchanges (Binance, Bybit, BingX). Requires API key management with HMAC-SHA256 signing, `MARKET` and `LIMIT IOC/FOK` order types, fill confirmation via polling or WebSocket user-stream, and cancel-on-miss logic for the open leg when the paired leg fails. Use idempotent client order IDs (UUID) on every order for safe retry.

---

#### AT-6: Position tracking and risk controls
**Must be live before any real capital is deployed.** Add: maximum concurrent open positions, per-pair and per-exchange notional exposure limits, net delta tracking for partially-filled legs, per-trade stop-loss, maximum daily loss circuit breaker, and API rate-limit monitoring (Binance 1200 req/min weight budget). Without a daily loss circuit breaker, a retry bug can exhaust capital silently.

---

#### AT-2: Simultaneous dual-leg execution coordinator
Build an `ExecutionCoordinator` that submits both legs in parallel (`Promise.all`) within a latency budget (target < 50ms). Must handle partial fills, one-leg failures (cancel or hedge the open leg), and idempotent client order IDs for safe retries. `OpportunityTracker.open()` invokes the coordinator instead of just logging. New opportunity states: DETECTED → SUBMITTED → FILLED / PARTIAL_FILL → HEDGING → CLOSED.

---

#### AT-5: Level-2 order book depth and dynamic slippage
Fetch top N order book levels for each candidate pair. Walk the book to compute expected average fill price at the intended notional. Replace the fixed `slippage_estimate_pct` constant with a per-trade computed value. Add a minimum-depth guard that skips or reduces position size when available quantity at best price is below threshold.

---

#### AT-9: Realized PnL and fill audit log
Extend the DB schema with a `fills` table: actual fill price, quantity, actual exchange fee, fill timestamp, and exchange order ID. Compute realized PnL as `(fill_sell * qty - fee_sell) - (fill_buy * qty + fee_buy)`. Reconcile periodically against exchange balance APIs to catch discrepancies. Enable immediately on first live execution.

---

#### AT-10: Operational reliability for live execution
On restart, recover any PENDING orders by querying exchange order-status APIs. Add alerting (webhook/SMS/email) for circuit breaker triggers and unrecoverable errors. Add a heartbeat endpoint for external monitoring. Build a dry-run mode against exchange sandbox environments before enabling live capital.

---

#### AT-8: Withdrawal and transfer automation for capital rebalancing
Model on-chain withdrawal fees and block confirmation times per asset/network (USDT-TRC20 ~$1, ERC20 ~$15 — critical for sizing). Add withdrawal API calls to `ExchangeClient`. Build a rebalancing trigger that batches withdrawals when inventory imbalance exceeds a threshold. Account for in-flight capital when computing available inventory.

---

## Design decisions on record

- **`capital_per_trade_usdt`** (config.yaml, default 500) is the hard maximum capital per trade. The actual deployed capital is `min(capital_per_trade_usdt, 0.1% of smaller exchange 24h volume)` — operating above 0.1% of daily volume risks meaningful price impact. This is computed per pair per cycle from `pair_snapshots` and passed into `computeSpread`. If volume data is unavailable the configured max is used.
- **Est. PnL is based on entry (opening) spread**, not peak. Peak spread is tracked separately (`peak_spread_pct`) but PnL reflects what you'd actually capture entering at the first observed price.
- **BingX uses hyphenated symbols** (`BTC-USDT`). Normalised to `BTCUSDT` in both the detector (`exchangeClient.ts`) and pair-fetcher before storage. Conversion back to BingX format happens in `getBookTicker` via `toBingXSymbol`.

- **JSONL kept in parallel** alongside SQLite as a flat audit log — human-readable, zero-dep recovery option
- **Dashboard is read-only** — no controls exposed via the web UI
- **Independent processes** — detector, dashboard, and mock-exchanges are three separate processes; dashboard reads SQLite directly, no IPC needed
- **`exchange_buy` / `exchange_sell`** field names kept in schema (matches detector internals); future rename to `exchange_cheap` / `exchange_expensive` deferred until resolution tracking is added (at which point the semantic distinction matters more)
