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

        for (const sym of qualifying) {
          const tickA = tickerMaps.get(firstEx)!.get(sym)!
          const tickB = tickerMaps.get(restExchanges[0])!.get(sym)!
          const spread = computeSpread(firstEx, tickA, restExchanges[0], tickB, config)
          logger.logPrice(sym, spread)

          if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
            const opp = tracker.open(spread, sym, [firstEx, restExchanges[0]], client, config, logger, controller)
            logger.logOpportunityOpened(opp)
            // no break — continue logging all remaining pairs this cycle
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
