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

### Dashboard enhancements (remaining)
- Price history retention policy — rolling window or prune by age to keep DB size bounded
- Duration range display once resolution tracking is implemented
- **Pair volume section** — surface `pair_snapshots` data: show 24h USDT volume per pair/exchange, flag pairs where our capital would exceed X% of daily volume (configurable threshold)

---

## Design decisions on record

- **JSONL kept in parallel** alongside SQLite as a flat audit log — human-readable, zero-dep recovery option
- **Dashboard is read-only** — no controls exposed via the web UI
- **Independent processes** — detector, dashboard, and mock-exchanges are three separate processes; dashboard reads SQLite directly, no IPC needed
- **`exchange_buy` / `exchange_sell`** field names kept in schema (matches detector internals); future rename to `exchange_cheap` / `exchange_expensive` deferred until resolution tracking is added (at which point the semantic distinction matters more)
