import * as path from 'path'
import { Database } from 'better-sqlite3'
import { loadConfig, loadEnv } from './config'
import { ExchangeClient, BookTick } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { OpportunityTracker, LoopController } from './opportunityTracker'
import { initDb } from './db'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class StepController implements LoopController {
  private remaining: number

  constructor(steps: number, private advanceUrl: string) {
    this.remaining = steps
  }

  get hasSteps(): boolean {
    return this.remaining > 0
  }

  async advance(): Promise<void> {
    await fetch(`${this.advanceUrl}/scenario/advance`, { method: 'POST' })
    this.remaining--
  }

  async fastAdvance(): Promise<void> {
    return this.advance()  // test fast-path must advance the scenario to get fresh prices
  }
}

class ContinuousController implements LoopController {
  constructor(private intervalMs: number) {}

  get hasSteps(): boolean {
    return true
  }

  async advance(): Promise<void> {
    await sleep(this.intervalMs)
  }

  async fastAdvance(): Promise<void> {}  // no-op — don't delay the 200ms opportunity fast-path
}

function parseArgs(argv: string[]): { configPath: string; steps: number | null; advanceUrl: string | null; dbPath: string | null } {
  let configPath = 'config.yaml'
  let steps: number | null = null
  let advanceUrl: string | null = null
  let dbPath: string | null = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i]
    else if (argv[i] === '--steps' && argv[i + 1]) steps = parseInt(argv[++i], 10)
    else if (argv[i] === '--advance-url' && argv[i + 1]) advanceUrl = argv[++i]
    else if (argv[i] === '--db' && argv[i + 1]) dbPath = argv[++i]
  }

  return { configPath, steps, advanceUrl, dbPath }
}

function meetsVolumeFloor(db: Database, symbol: string, minVol: number): boolean {
  try {
    const row = db.prepare(
      `SELECT MAX(volume_24h_quote) AS max_vol FROM pair_snapshots WHERE symbol = ?`
    ).get(symbol) as { max_vol: number | null } | undefined
    if (!row || row.max_vol === null) return true  // no data yet — don't exclude
    return row.max_vol >= minVol
  } catch {
    return true  // table doesn't exist yet — don't exclude
  }
}

async function main(): Promise<void> {
  const { configPath, steps, advanceUrl, dbPath } = parseArgs(process.argv.slice(2))

  const config = loadConfig(path.resolve(process.cwd(), configPath))
  const env = loadEnv()

  const logsDir = path.resolve(process.cwd(), 'logs')
  const resolvedDbPath = dbPath ?? path.join(logsDir, 'arb.db')
  const db = initDb(resolvedDbPath)

  // Close any opportunities left open from a previous run (detector restart lost in-memory state)
  const now = Date.now()
  db.prepare(
    `UPDATE opportunities SET close_reason = 'ABANDONED', closed_at_ms = ?, duration_ms = ? - opened_at_ms WHERE close_reason IS NULL`
  ).run(now, now)

  const client = new ExchangeClient(env)
  const logger = new Logger(logsDir, db)
  const tracker = new OpportunityTracker()

  const controller: LoopController = steps !== null
    ? new StepController(steps, advanceUrl ?? 'http://localhost:3000')
    : new ContinuousController(config.slow_poll_interval_ms)

  process.on('SIGINT', () => { logger.flush(); process.exit(0) })
  process.on('SIGTERM', () => { logger.flush(); process.exit(0) })

  const configuredExchanges = Object.keys(config.exchanges)

  while (controller.hasSteps) {
    if (config.auto_pairs) {
      try {
        // Bulk fetch — 1 API call per exchange
        const tickerMaps = new Map<string, Map<string, BookTick>>()
        for (const ex of configuredExchanges) {
          tickerMaps.set(ex, await client.getAllBookTickers(ex))
        }

        // Intersection: symbols present on ALL configured exchanges
        const [firstEx, ...restExchanges] = configuredExchanges
        const candidates = [...tickerMaps.get(firstEx)!.keys()].filter(sym =>
          restExchanges.every(ex => tickerMaps.get(ex)!.has(sym))
        )

        // Volume filter from pair_snapshots (skipped if min_volume_usdt = 0)
        const minVol = config.auto_pairs.min_volume_usdt
        const qualifying = minVol > 0
          ? candidates.filter(sym => meetsVolumeFloor(db, sym, minVol))
          : candidates

        console.log(`[auto] ${qualifying.length} pairs qualifying (${candidates.length} in intersection, min_vol=${minVol})`)

        // Phase 1: compute all spreads (pure CPU, no IO)
        const spreads: Array<{ sym: string; spread: ReturnType<typeof computeSpread> }> = []
        for (const sym of qualifying) {
          const tickA = tickerMaps.get(firstEx)!.get(sym)!
          const tickB = tickerMaps.get(restExchanges[0])!.get(sym)!
          // Skip pairs with zero or non-finite prices (suspended/delisted pairs return 0,
          // which causes Infinity spread — SQLite stores Infinity/NaN as NULL)
          if (
            tickA.bidPrice <= 0 || tickA.askPrice <= 0 ||
            tickB.bidPrice <= 0 || tickB.askPrice <= 0 ||
            !isFinite(tickA.bidPrice) || !isFinite(tickA.askPrice) ||
            !isFinite(tickB.bidPrice) || !isFinite(tickB.askPrice)
          ) continue
          const spread = computeSpread(firstEx, tickA, restExchanges[0], tickB, config)
          // >100% spread = same ticker, different tokens across exchanges (symbol collision)
          if (Math.abs(spread.netSpreadPct) > 100) continue
          spreads.push({ sym, spread })
        }

        // Phase 2: log all prices in one transaction (365 inserts → single commit)
        db.transaction(() => {
          for (const { sym, spread } of spreads) {
            logger.logPrice(sym, spread)
          }
        })()

        // Phase 3: check for opportunities (outside transaction)
        for (const { sym, spread } of spreads) {
          if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
            const opp = tracker.open(spread, sym, [firstEx, restExchanges[0]], client, config, logger, controller)
            logger.logOpportunityOpened(opp)
          }
        }
      } catch (err) {
        console.error('[auto] scan cycle error:', err)
      }
    } else {
      // Static mode: config.pairs list (used in test mode / explicit override)
      for (const pair of config.pairs ?? []) {
        const [exA, exB] = pair.exchanges
        const [tickA, tickB] = await client.getPairTicks(pair.symbol, exA, pair.symbol, exB)
        const spread = computeSpread(exA, tickA, exB, tickB, config)
        logger.logPrice(pair.symbol, spread)

        if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
          const opp = tracker.open(spread, pair.symbol, [exA, exB], client, config, logger, controller)
          logger.logOpportunityOpened(opp)
        }
      }
    }

    await controller.advance()
  }

  logger.flush()
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
