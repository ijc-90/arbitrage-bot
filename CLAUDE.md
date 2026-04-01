# arb-bot

Cross-exchange arbitrage detector. Alarm mode only — no execution.

## Structure
- `mock-exchanges/` — Express server mocking Binance, Bybit, Kraken on port 3000
- `arbitrage-detector/` — detector, polls pairs, writes to SQLite + JSONL logs
- `dashboard/` — read-only web UI, reads `arb.db` via SQLite, port 4000
- `pair-fetcher/` — fetches 24h volume for all pairs per exchange, writes `pair_snapshots` table to `arb.db`
- `scenarios/` — shared YAML scenario files for both test suites

## Dashboard
Independent process. Reads `arbitrage-detector/logs/arb.db` by default.
cd dashboard && npx ts-node server.ts
Override DB path: npx ts-node server.ts --db /path/to/arb.db --port 4000

## Pair fetcher
Fetches 24h volume for all pairs from each exchange. Runs on startup then every N hours.
Writes to `pair_snapshots` table in the same `arb.db`.
cd pair-fetcher && npx ts-node fetcher.ts
Options: --db /path/to/arb.db  --interval 1  (hours, default 1)  --env /path/to/.env

## Mock server
Scenario-based. POST /scenario/load/:name, POST /scenario/advance.
Step-based only — no time clock. Scenarios in `scenarios/` (project root).

## Detector
Two-speed loop. Main loop scans all pairs. OpportunityTracker follows open opportunity via setTimeout — non-blocking. StepController for test mode, ContinuousController for prod.

## Test mode
npx ts-node arbitrage-detector/detector.ts --config config.test.yaml --steps 4 --advance-url http://localhost:3000

## Running tests

Mock server integration tests (server behaviour, scenarios):
cd mock-exchanges && npx ts-node tests/integration/runner.ts

Detector integration tests (unit + full detector lifecycle):
cd arbitrage-detector/tests/integration && npx ts-node --project tsconfig.json runner.ts

## Key conventions
- Always use cat to read .ts files — file_editor may detect as binary
- Scenarios use block YAML style (one field per line), not inline
- config.yaml = financial params, .env = exchange URLs
- logs/ and arb.db created on startup if missing
- SIGINT/SIGTERM flush logs before exit

## See also
BACKLOG.md — what's built, what's next, design decisions on record