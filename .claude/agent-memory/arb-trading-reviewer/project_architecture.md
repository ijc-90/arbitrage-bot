---
name: Project architecture
description: Service structure, exchanges monitored, key files, and design decisions for arb-bot
type: project
---

Three independent Node.js/TypeScript processes sharing a SQLite database (`arb.db`) via a named Docker volume (`arb-data`).

**Services:**
- `arbitrage-detector/` — main detector, writes to DB and JSONL logs
- `dashboard/` — read-only Express server on port 4000, reads DB directly
- `pair-fetcher/` — fetches 24h volume hourly, writes `pair_snapshots` table

**Exchanges monitored:** Binance, Bybit, BingX (hyphenated symbols normalised to canonical form e.g. BTC-USDT → BTCUSDT)

**Key files:**
- `arbitrage-detector/spreadEngine.ts` — all spread/fee/threshold logic
- `arbitrage-detector/detector.ts` — two-speed scan loop, capital sizing, opportunity dispatch
- `arbitrage-detector/opportunityTracker.ts` — fast-path non-blocking poll via setTimeout
- `arbitrage-detector/exchangeClient.ts` — REST-only price fetching, BingX blacklist
- `arbitrage-detector/config.yaml` — financial params (fees, capital, thresholds)
- `arbitrage-detector/.env` — exchange URLs (not committed)
- `docker-compose.prod.yml` — production service config

**Architecture decisions:**
- Two-speed loop: main loop scans all pairs (slow_poll_interval_ms=5000); OpportunityTracker fast-path polls only the active pair (fast_poll_interval_ms=200) via non-blocking setTimeout chains
- Only one open opportunity at a time (tracker blocks new opens while one is active)
- SIGINT/SIGTERM flush logs before exit (appendFileSync is synchronous, no buffer to flush)
- DB WAL mode allows concurrent dashboard reads while detector writes
- Abandoned opportunities marked on startup (restarts lose in-memory tracker state)
- Capital sizing: effectiveCapital = min(capital_per_trade_usdt, 0.1% of smaller exchange 24h volume). Volume proxy is from pair_snapshots; if table empty, uses configured max.
- PnL recorded at entry spread, not peak. Peak tracked separately as peak_spread_pct.

**Why:** Alarm-only, no trade execution. All findings here are based on full source review on 2026-04-06.
