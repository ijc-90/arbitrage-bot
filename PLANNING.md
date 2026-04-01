# Storage & Display Planning

_Status: in discussion — no implementation decisions finalized_

---

## Current State

- JSONL files: `opportunities.jsonl` (OPENED/CLOSED), `prices.jsonl` (all ticks), `opp_{id}.jsonl` (per-opportunity ticks)
- Synchronous `fs.appendFileSync` in `Logger` class (`arbitrage-detector/logger.ts`)
- Zero stdout output — everything goes to files
- One opportunity open at a time

**Data captured per opportunity:**
- OPENED: `opp_id, pair, exchange_buy, exchange_sell, ask_buy, bid_sell, net_spread_pct, estimated_pnl_usdt`
- CLOSED: `opp_id, reason (CONVERGENCE|ERROR), duration_ms, peak_spread_pct, estimated_pnl_usdt`
- Ticks: `ask_buy, bid_sell, net_spread_pct` at fast poll interval while open

---

## Ideal Scenario (under discussion)

_Constraints relaxed: tests can be updated, JSONL logs can be kept in parallel_

### Storage: SQLite

`better-sqlite3` — synchronous like `appendFileSync`, fits the current I/O model with no async refactor.

**Schema sketch:**
```sql
opportunities (
  id TEXT PRIMARY KEY,
  pair TEXT,
  exchange_buy TEXT,
  exchange_sell TEXT,
  opened_at INTEGER,
  closed_at INTEGER,
  duration_ms INTEGER,
  open_ask_buy REAL,
  open_bid_sell REAL,
  open_net_spread_pct REAL,
  peak_spread_pct REAL,
  estimated_pnl_usdt REAL,
  close_reason TEXT,           -- CONVERGENCE | ERROR | null (open)

  -- Timing resolution / confidence
  -- How long since the pair was last scanned before detection (slow poll gap).
  -- True open time is somewhere in [opened_at - open_resolution_ms, opened_at].
  -- Captured by tracking lastScannedAt per pair in the main loop.
  open_resolution_ms INTEGER,

  -- Time between last tick and convergence detection (fast poll gap).
  -- True close time is somewhere in [closed_at - close_resolution_ms, closed_at].
  -- Derived from actual tick timestamps, not the configured interval.
  close_resolution_ms INTEGER
  -- Derived ranges (compute at query time, not stored):
  --   duration_min_ms = duration_ms - close_resolution_ms
  --   duration_max_ms = duration_ms + open_resolution_ms
)

ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opp_id TEXT,
  fetched_at_ms INTEGER,       -- when this tick was collected
  ask_cheap REAL,              -- ask price on the cheap exchange (buy side)
  bid_expensive REAL,          -- bid price on the expensive exchange (sell side)
  net_spread_pct REAL,
  -- Per-exchange resolution: when was each exchange's data last successfully fetched
  -- before this tick. Allows computing how stale each side was independently.
  -- open_resolution_ms on the opportunity = max(cheap_last_fetched_gap, expensive_last_fetched_gap)
  cheap_last_fetched_ms INTEGER,      -- ms since cheap exchange was last successfully fetched
  expensive_last_fetched_ms INTEGER   -- ms since expensive exchange was last successfully fetched
)

prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at_ms INTEGER,
  pair TEXT,
  exchange_cheap TEXT,         -- exchange with the lower ask at this moment
  exchange_expensive TEXT,     -- exchange with the higher bid at this moment
  ask_cheap REAL,
  bid_expensive REAL,
  net_spread_pct REAL,
  is_opportunity INTEGER,      -- 0/1
  cheap_last_fetched_ms INTEGER,
  expensive_last_fetched_ms INTEGER
)
```

Enables: filter by pair/exchange/date, aggregate pnl, avg duration, count, etc.
JSONL kept in parallel as audit log.

**Resolution in the dashboard:** show duration as a range when resolution is meaningful, e.g. `12ms – 5.2s` instead of a single misleading number. High-resolution closes (fast poll is tight) vs low-resolution opens (slow poll was slow) can be surfaced visually.

**Implementation note for open resolution:** `ExchangeClient` needs to track `lastSuccessfulFetchAt` per exchange (not per pair). The main loop passes these into `OpportunityTracker.open()` at detection time. `open_resolution_ms` on the opportunity = `max(cheap_gap, expensive_gap)` — worst case wins. First scan after startup = `NULL` (no prior fetch data, unknown resolution).

**Naming convention:** `exchange_cheap` / `exchange_expensive` used consistently across `prices` and `ticks` tables — more semantically stable than `exchange_buy` / `exchange_sell` (which are directional and only meaningful within an opportunity context).

### Display: Web Dashboard

Embedded Express server in the detector process (same library as `mock-exchanges/`).

**What it should show:**
- Live status bar: scanning / opportunity open (which pair, which direction, current spread)
- Table of recent closed opportunities: pair, direction (buy→sell), open spread, peak spread, pnl, duration, close reason
- Aggregate stats: total opps, total estimated pnl, avg duration, best spread seen
- Price monitor: latest tick per pair, which pairs are closest to threshold

**Routes:**
- `GET /` — dashboard HTML, auto-refreshes via polling
- `GET /api/snapshot` — live state (current opp + latest prices)
- `GET /api/opportunities` — paginated/filterable history from SQLite
- `GET /api/stats` — aggregated stats from SQLite

### Tests

Tests get a dedicated temp folder (e.g. `logs/test_run_{timestamp}/`) and clean it up on completion. No shared state between test runs and production logs.

---

## Decisions Made

- **SQLite** for structured storage (`better-sqlite3`, synchronous)
- **JSONL kept in parallel** as flat audit log
- **Tests** use a dedicated isolated logs folder, cleaned up after each run
- **Web dashboard** for display — live status + historical table + stats

## Open Questions

- Dashboard as read-only, or also expose controls (e.g. reload config, pause)?
- Price history retention: keep all ticks in SQLite forever, or rolling window?
- Dashboard detail view: what should "open opportunity detail" show? (tick-by-tick chart? table?)

---

## Next Steps (TBD)

1. Schema finalization
2. Dashboard scope (pages/views)
3. Test isolation approach
4. Implementation plan
5. Backlog/vision doc
