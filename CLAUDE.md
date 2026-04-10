# arb-bot

Cross-exchange arbitrage detector. Alarm mode only — no execution.

## Structure
- `arbitrage-detector/` — detector, polls pairs, writes to SQLite + JSONL logs
- `dashboard/` — read-only web UI, reads `arb.db` via SQLite, port 4000
- `pair-fetcher/` — fetches 24h volume for all pairs per exchange, writes `pair_snapshots` table to `arb.db`

## Dashboard
Independent process. Reads `arbitrage-detector/logs/arb.db` by default.
cd dashboard && npx ts-node server.ts
Override DB path: npx ts-node server.ts --db /path/to/arb.db --port 4000

## Pair fetcher
Fetches 24h volume for all pairs from each exchange. Runs on startup then every N hours.
Writes to `pair_snapshots` table in the same `arb.db`.
cd pair-fetcher && npx ts-node fetcher.ts
Options: --db /path/to/arb.db  --interval 1  (hours, default 1)  --env /path/to/.env

## Detector
Two-speed loop. Main loop scans all pairs. OpportunityTracker follows open opportunity via setTimeout — non-blocking. Continuous-only; no test/step mode.

## Running tests
No automated test suite currently. Testing approach TBD.

## Key conventions
- Always use cat to read .ts files — file_editor may detect as binary
- config.yaml = financial params, .env = exchange URLs
- logs/ and arb.db created on startup if missing
- SIGINT/SIGTERM flush logs before exit

## Backlog discipline
On every task or iteration, read BACKLOG.md and update it to reflect what was just completed (move items to Done) and any new work or design decisions that surfaced. Always keep BACKLOG.md current.

## See also
BACKLOG.md — what's built, what's next, design decisions on record