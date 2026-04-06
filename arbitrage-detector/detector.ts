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

  const client = new ExchangeClient(env, db)
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

        // Log per-exchange ticker counts for diagnostics
        const fetchSummary = configuredExchanges.map(ex => `${ex}:${tickerMaps.get(ex)!.size}`).join(' ')
        console.log(`[fetch] ${fetchSummary}`)

        // Build symbol → exchanges map: only need 2+ exchanges to arb
        const symbolExchanges = new Map<string, string[]>()
        for (const [ex, tickers] of tickerMaps) {
          for (const sym of tickers.keys()) {
            if (!symbolExchanges.has(sym)) symbolExchanges.set(sym, [])
            symbolExchanges.get(sym)!.push(ex)
          }
        }
        const candidates = [...symbolExchanges.keys()].filter(sym => symbolExchanges.get(sym)!.length >= 2)

        // Volume filter from pair_snapshots (skipped if min_volume_usdt = 0)
        const minVol = config.auto_pairs.min_volume_usdt
        const qualifying = minVol > 0
          ? candidates.filter(sym => meetsVolumeFloor(db, sym, minVol))
          : candidates

        console.log(`[auto] ${qualifying.length} pairs qualifying (${candidates.length} on 2+ exchanges, min_vol=${minVol})`)

        // Pre-load volume per (symbol, exchange) for capital sizing and completeness checks.
        // effective_capital = min(config.capital_per_trade_usdt, 0.1% of smaller exchange 24h volume)
        // We require BOTH exchanges to have volume data before logging or opening an opportunity.
        // If pair_snapshots is empty (pair-fetcher hasn't run yet), volPerExchange is empty
        // and the "both exchanges must have data" check is skipped (graceful startup).
        const volPerExchange = new Map<string, Map<string, number>>()  // symbol → exchange → vol
        try {
          const rows = db.prepare(`
            SELECT symbol, exchange, MAX(volume_24h_quote) AS max_vol
            FROM pair_snapshots
            WHERE id IN (SELECT MAX(id) FROM pair_snapshots GROUP BY exchange, symbol)
            GROUP BY symbol, exchange
          `).all() as Array<{ symbol: string; exchange: string; max_vol: number }>
          for (const row of rows) {
            if (!volPerExchange.has(row.symbol)) volPerExchange.set(row.symbol, new Map())
            volPerExchange.get(row.symbol)!.set(row.exchange, row.max_vol)
          }
        } catch {}

        // Track which exchanges have ANY volume data — we only require it for those.
        // If pair-fetcher hasn't run for bingx yet, bingx rows are absent and we don't penalise bingx pairs.
        const exchangesWithVolumeData = new Set<string>()
        for (const exMap of volPerExchange.values()) {
          for (const ex of exMap.keys()) exchangesWithVolumeData.add(ex)
        }

        // Phase 1: for each symbol, find best spread across all exchange pairs
        const spreads: Array<{ sym: string; spread: ReturnType<typeof computeSpread> }> = []
        for (const sym of qualifying) {
          const symExs = symbolExchanges.get(sym)!

          let best: ReturnType<typeof computeSpread> | null = null
          for (let i = 0; i < symExs.length; i++) {
            for (let j = i + 1; j < symExs.length; j++) {
              const exA = symExs[i], exB = symExs[j]

              // Require volume data only for exchanges that have it in pair_snapshots.
              // Exchanges not yet fetched by pair-fetcher are not excluded.
              if (exchangesWithVolumeData.size > 0) {
                const symVols = volPerExchange.get(sym)
                const missingA = exchangesWithVolumeData.has(exA) && !symVols?.has(exA)
                const missingB = exchangesWithVolumeData.has(exB) && !symVols?.has(exB)
                if (missingA || missingB) continue
              }

              const tickA = tickerMaps.get(exA)!.get(sym)!
              const tickB = tickerMaps.get(exB)!.get(sym)!
              // Skip zero or non-finite prices (suspended/delisted pairs)
              if (
                tickA.bidPrice <= 0 || tickA.askPrice <= 0 ||
                tickB.bidPrice <= 0 || tickB.askPrice <= 0 ||
                !isFinite(tickA.bidPrice) || !isFinite(tickA.askPrice) ||
                !isFinite(tickB.bidPrice) || !isFinite(tickB.askPrice)
              ) continue

              // Effective capital = min(configured max, 0.1% of smaller exchange's volume)
              const symVols = volPerExchange.get(sym)
              const volA = symVols?.get(exA)
              const volB = symVols?.get(exB)
              const effectiveCapital = (volA != null && volB != null)
                ? Math.min(config.capital_per_trade_usdt, Math.min(volA, volB) * 0.001)
                : config.capital_per_trade_usdt

              const s = computeSpread(exA, tickA, exB, tickB, config, effectiveCapital)
              if (Math.abs(s.netSpreadPct) > 100) continue  // symbol collision
              if (!best || s.netSpreadPct > best.netSpreadPct) best = s
            }
          }
          if (best) spreads.push({ sym, spread: best })
        }

        // Phase 2: log all prices in one transaction (single commit)
        db.transaction(() => {
          for (const { sym, spread } of spreads) {
            logger.logPrice(sym, spread)
          }
        })()

        // Phase 3: check for opportunities (outside transaction)
        for (const { sym, spread } of spreads) {
          if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
            const opp = tracker.open(spread, sym, [spread.exchangeBuy, spread.exchangeSell], client, config, logger, controller)
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
