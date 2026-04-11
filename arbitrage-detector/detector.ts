import * as path from 'path'
import { Database } from 'better-sqlite3'
import { loadConfig, loadEnv } from './config'
import { ExchangeClient, BookTick } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { OpportunityTracker } from './opportunityTracker'
import { initDb } from './db'
import { WsFeedManager } from './wsFeed'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseArgs(argv: string[]): { configPath: string; dbPath: string | null } {
  let configPath = 'config.yaml'
  let dbPath: string | null = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i]
    else if (argv[i] === '--db' && argv[i + 1]) dbPath = argv[++i]
  }

  return { configPath, dbPath }
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
  const { configPath, dbPath } = parseArgs(process.argv.slice(2))

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

  const retentionHours = config.price_retention_hours ?? 6
  function prunePrices(): void {
    if (retentionHours <= 0) return
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000
    const { changes } = db.prepare(`DELETE FROM prices WHERE fetched_at_ms < ?`).run(cutoff)
    if (changes > 0) {
      console.log(`[prune] deleted ${changes} price rows older than ${retentionHours}h`)
      db.exec('VACUUM')
    }
  }

  prunePrices()
  setInterval(prunePrices, 60 * 60 * 1000)

  // Publish config values the dashboard needs for display logic
  const writeSettings = db.prepare(`INSERT OR REPLACE INTO detector_settings (key, value) VALUES (?, ?)`)
  writeSettings.run('capital_per_trade_usdt', String(config.capital_per_trade_usdt))
  writeSettings.run('liquidity_flag_threshold_pct', String(config.liquidity_flag_threshold_pct ?? 0.1))

  const client = new ExchangeClient(env, db)
  const logger = new Logger(logsDir, db)
  const tracker = new OpportunityTracker()

  const wsFeed = Object.keys(env.wsUrls).length > 0
    ? new WsFeedManager(env.wsUrls, config.staleness_threshold_ms ?? 2000)
    : null

  process.on('SIGINT', () => { wsFeed?.disconnect(); logger.flush(); process.exit(0) })
  process.on('SIGTERM', () => { wsFeed?.disconnect(); logger.flush(); process.exit(0) })

  const configuredExchanges = Object.keys(config.exchanges)

  // Log WS status every 60s so you can see connection health in the logs
  if (wsFeed) {
    setInterval(() => {
      const status = wsFeed.getStatus()
      for (const [ex, s] of Object.entries(status)) {
        const age = s.lastTickAt ? `${Math.round((Date.now() - s.lastTickAt) / 1000)}s ago` : 'never'
        console.log(`[ws:${ex}] ${s.state}  subs=${s.subscribedSymbols}  ticks=${s.tickCount}  lastTick=${age}`)
      }
    }, 60_000)
  }

  // Cached discovery state for WS mode: populated on first REST bulk scan, refreshed periodically
  let cachedSymbolExchanges: Map<string, string[]> | null = null
  let cachedQualifying: string[] | null = null
  let lastDiscoveryAt = 0
  const REDISCOVERY_INTERVAL_MS = 10 * 60 * 1000  // re-discover pairs every 10 minutes

  // Track when each symbol was last scanned to compute open_resolution_ms
  const lastScannedAt = new Map<string, number>()

  while (true) {
    if (config.auto_pairs) {
      try {
        const now = Date.now()
        const needsDiscovery = !cachedQualifying || now - lastDiscoveryAt > REDISCOVERY_INTERVAL_MS

        // ------------------------------------------------------------------
        // Discovery pass: REST bulk fetch to find which symbols exist on 2+
        // exchanges. Always runs on first iteration; repeats every 10 minutes.
        // ------------------------------------------------------------------
        let tickerMaps: Map<string, Map<string, BookTick>> | null = null
        let symbolExchanges: Map<string, string[]>
        let qualifying: string[]

        if (needsDiscovery) {
          tickerMaps = new Map<string, Map<string, BookTick>>()
          for (const ex of configuredExchanges) {
            tickerMaps.set(ex, await client.getAllBookTickers(ex))
          }

          const fetchSummary = configuredExchanges.map(ex => `${ex}:${tickerMaps!.get(ex)!.size}`).join(' ')
          console.log(`[fetch] ${fetchSummary}`)

          symbolExchanges = new Map<string, string[]>()
          for (const [ex, tickers] of tickerMaps) {
            for (const sym of tickers.keys()) {
              if (!symbolExchanges.has(sym)) symbolExchanges.set(sym, [])
              symbolExchanges.get(sym)!.push(ex)
            }
          }
          const candidates = [...symbolExchanges.keys()].filter(sym => symbolExchanges.get(sym)!.length >= 2)

          const minVol = config.auto_pairs.min_volume_usdt
          qualifying = minVol > 0
            ? candidates.filter(sym => meetsVolumeFloor(db, sym, minVol))
            : candidates

          console.log(`[auto] ${qualifying.length} pairs qualifying (${candidates.length} on 2+ exchanges, min_vol=${minVol})`)

          cachedSymbolExchanges = symbolExchanges
          cachedQualifying = qualifying
          lastDiscoveryAt = now

          // Subscribe WS feed to all qualifying pairs (no-op if wsFeed is null)
          if (wsFeed) {
            for (const ex of configuredExchanges) {
              const symsForEx = qualifying.filter(sym => symbolExchanges.get(sym)!.includes(ex))
              if (symsForEx.length > 0) wsFeed.subscribe(ex, symsForEx)
            }
          }
        } else {
          symbolExchanges = cachedSymbolExchanges!
          qualifying = cachedQualifying!
        }

        // ------------------------------------------------------------------
        // For each qualifying pair, get ticks: WS cache first, REST fallback.
        // On the discovery pass, tickerMaps (bulk REST) is used as the source.
        // On subsequent passes (WS mode), individual REST calls are the fallback.
        // ------------------------------------------------------------------
        const stalenessMs = config.staleness_threshold_ms ?? 2000

        async function resolveTick(ex: string, sym: string): Promise<BookTick | null> {
          // Try WS cache first
          if (wsFeed) {
            const wsTick = wsFeed.getTick(ex, sym)
            if (wsTick) return wsTick
          }
          // Fall back to bulk REST data from this discovery pass
          if (tickerMaps) {
            const t = tickerMaps.get(ex)?.get(sym)
            if (t) return t
          }
          // Fall back to individual REST call (WS stale/missing, non-discovery pass)
          try {
            return await client.getBookTicker(ex, sym)
          } catch {
            return null
          }
        }

        // Pre-load volume per (symbol, exchange) for capital sizing
        const volPerExchange = new Map<string, Map<string, number>>()
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

              if (exchangesWithVolumeData.size > 0) {
                const symVols = volPerExchange.get(sym)
                const missingA = exchangesWithVolumeData.has(exA) && !symVols?.has(exA)
                const missingB = exchangesWithVolumeData.has(exB) && !symVols?.has(exB)
                if (missingA || missingB) continue
              }

              const [tickA, tickB] = await Promise.all([resolveTick(exA, sym), resolveTick(exB, sym)])
              if (!tickA || !tickB) continue

              if (
                tickA.bidPrice <= 0 || tickA.askPrice <= 0 ||
                tickB.bidPrice <= 0 || tickB.askPrice <= 0 ||
                !isFinite(tickA.bidPrice) || !isFinite(tickA.askPrice) ||
                !isFinite(tickB.bidPrice) || !isFinite(tickB.askPrice)
              ) continue

              const symVols = volPerExchange.get(sym)
              const volA = symVols?.get(exA)
              const volB = symVols?.get(exB)
              const effectiveCapital = (volA != null && volB != null)
                ? Math.min(config.capital_per_trade_usdt, Math.min(volA, volB) * 0.001)
                : config.capital_per_trade_usdt

              const s = computeSpread(exA, tickA, exB, tickB, config, effectiveCapital)
              if (Math.abs(s.netSpreadPct) > 100) continue  // symbol collision / clearly bad data
              const maxSpread = config.max_net_spread_pct ?? 20
              if (s.netSpreadPct > maxSpread) {
                console.warn(`[skip] ${sym} ${exA}→${exB} spread ${s.netSpreadPct.toFixed(2)}% exceeds max_net_spread_pct=${maxSpread} — likely bad price data`)
                continue
              }
              if (!best || s.netSpreadPct > best.netSpreadPct) best = s
            }
          }
          if (best) spreads.push({ sym, spread: best })
          lastScannedAt.set(sym, Date.now())
        }

        // Phase 2: log all prices in one transaction
        db.transaction(() => {
          for (const { sym, spread } of spreads) {
            logger.logPrice(sym, spread)
          }
        })()

        // Phase 3: check for opportunities (outside transaction)
        for (const { sym, spread } of spreads) {
          if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
            const prev = lastScannedAt.get(sym)
            const openResolutionMs = prev != null ? Date.now() - prev : null
            const opp = tracker.open(spread, sym, [spread.exchangeBuy, spread.exchangeSell], client, config, logger, wsFeed, openResolutionMs)
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
          const opp = tracker.open(spread, pair.symbol, [exA, exB], client, config, logger, wsFeed)
          logger.logOpportunityOpened(opp)
        }
      }
    }

    await sleep(config.slow_poll_interval_ms)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
