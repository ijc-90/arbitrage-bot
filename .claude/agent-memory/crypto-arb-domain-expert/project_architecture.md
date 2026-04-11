---
name: Architecture Snapshot
description: What is built in the arb-bot as of April 2026 — subsystems, their state, and key quirks
type: project
---

As of 2026-04-11:

**Detector (arbitrage-detector/):** Two-speed loop. Slow loop (5s) scans all qualifying pairs. Fast loop (200ms, OpportunityTracker via setTimeout) follows open opportunity. WS feeds for Binance and Bybit (bookTicker streams). BingX WS deferred (gzip protocol). Staleness fallback to REST at 2000ms. Re-discovery every 10 min. Single OpportunityTracker — only one opportunity tracked at a time.

**Price data:** Best bid/ask from WS (with REST fallback). No L2 depth. No volume-at-price. No bid/ask sizes stored anywhere.

**Storage:** SQLite (better-sqlite3, WAL mode) + JSONL audit log. Tables: opportunities, prices, ticks, detector_settings, exchange_symbol_blacklist, pair_snapshots.

**Pair fetcher (pair-fetcher/):** Fetches 24h volume per exchange, writes pair_snapshots. Runs on startup + every N hours.

**Dashboard (dashboard/):** Read-only Express app. Reads arb.db. Pair table with volume/spread/opp stats. Opportunity detail panel with tick sparkline. Liquidity flag. Docker-compose'd with shared arb-data volume.

**Exchange quirks:**
- BingX uses hyphenated symbols (BTC-USDT), normalized to BTCUSDT internally
- BingX has a blacklist for 100204 errors (symbol not available for individual lookup), persisted to DB
- Binance WS: combined-stream, 1024-symbol chunks
- Bybit WS: tickers.{SYMBOL} topic, 20s ping required

**OpportunityTracker:** Tracks one opportunity at a time. On open, arms a setTimeout chain at fast_poll_interval_ms. Closes on CONVERGENCE, TIMEOUT (5min), or ERROR. Abandoned opportunities marked on restart. No concurrent opportunity support.
