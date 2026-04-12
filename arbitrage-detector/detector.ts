import * as path from 'path'
import { Database } from 'better-sqlite3'
import { loadConfig, loadEnv } from './config'
import { ExchangeClient, BookTick } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { OpportunityTracker } from './opportunityTracker'
import { initDb } from './db'
import { WsFeedManager } from './wsFeed'
import { InventoryManager } from './inventoryManager'
import { RiskManager } from './riskManager'
import { ExecutionCoordinator } from './executionCoordinator'
import { Reconciler } from './reconciler'
import { makeAlerter } from './alerting'
import { PerpClient } from './perpClient'
import { FundingScanner } from './fundingScanner'
import { FundingCoordinator } from './fundingCoordinator'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseArgs(argv: string[]): { configPath: string; dbPath: string | null; envPath: string | null } {
  let configPath = 'config.yaml'
  let dbPath: string | null = null
  let envPath: string | null = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i]
    else if (argv[i] === '--db' && argv[i + 1]) dbPath = argv[++i]
    else if (argv[i] === '--env' && argv[i + 1]) envPath = argv[++i]
  }

  return { configPath, dbPath, envPath }
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

// On startup, query each exchange for open orders placed by this bot (prefix: 'arb-').
// Cancel any that are older than 60s to avoid ghost positions.
async function recoverPendingOrders(client: ExchangeClient, db: Database, exchanges: string[]): Promise<void> {
  console.log('[recovery] checking for pending orders from previous session...')
  for (const ex of exchanges) {
    try {
      const openOrders = await client.getOpenOrders(ex)
      const staleMs = 60_000
      for (const order of openOrders) {
        const age = Date.now() - order.createdAt
        if (age > staleMs) {
          console.warn(`[recovery:${ex}] cancelling stale order ${order.orderId} (${order.symbol}, ${Math.round(age / 1000)}s old)`)
          try {
            await client.cancelOrder(ex, order.symbol, order.orderId)
            console.log(`[recovery:${ex}] cancelled ${order.orderId}`)
          } catch (e: any) {
            console.error(`[recovery:${ex}] cancel failed for ${order.orderId}: ${e.message}`)
          }
        } else {
          console.log(`[recovery:${ex}] found recent order ${order.orderId} (${Math.round(age / 1000)}s old) — leaving active`)
        }
      }
      if (openOrders.length === 0) console.log(`[recovery:${ex}] no pending orders found`)
    } catch (e: any) {
      console.warn(`[recovery:${ex}] could not fetch open orders: ${e.message}`)
    }
  }
}

async function main(): Promise<void> {
  const { configPath, dbPath, envPath } = parseArgs(process.argv.slice(2))

  const config = loadConfig(path.resolve(process.cwd(), configPath))
  const env = loadEnv(envPath ?? undefined)

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
  if (config.execution_enabled) client.enableExecution(config.dry_run_sandbox ?? false)
  const logger = new Logger(logsDir, db)
  const tracker = new OpportunityTracker()

  // Alerting (webhook — fire and forget)
  const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL
  const alert = makeAlerter(alertWebhookUrl)
  if (alertWebhookUrl) console.log('[alerting] webhook configured')

  // Inventory manager — only active when API keys are present in .env
  const keyedExchanges = Object.keys(env.apiKeys)
  const inventory = keyedExchanges.length > 0
    ? new InventoryManager(client, keyedExchanges)
    : null

  if (inventory) {
    await inventory.refreshAll()
    inventory.startBackgroundRefresh()
    console.log(`[inventory] tracking balances for: ${keyedExchanges.join(', ')}`)
  } else {
    console.log('[inventory] no API keys configured — running in alarm-only mode')
  }

  // Risk manager — writes state to detector_settings so dashboard can read it
  const persistRiskState = (state: ReturnType<RiskManager['getState']>) => {
    const w = db.prepare(`INSERT OR REPLACE INTO detector_settings (key, value) VALUES (?, ?)`)
    w.run('risk_halted', state.halted ? '1' : '0')
    w.run('risk_halt_reason', state.haltReason)
    w.run('risk_daily_pnl', String(state.dailyRealizedPnl))
    w.run('risk_open_positions', String(state.openPositions))
  }
  const risk = new RiskManager(config, alert, persistRiskState)

  // Midnight UTC reset for daily counters
  const scheduleMidnightReset = () => {
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    const msUntilMidnight = midnight.getTime() - Date.now()
    setTimeout(() => {
      risk.resetDay()
      scheduleMidnightReset()
    }, msUntilMidnight)
  }
  scheduleMidnightReset()

  // Execution coordinator (null when execution disabled — still validates risk)
  const coordinator = config.execution_enabled
    ? new ExecutionCoordinator(client, risk, config, db, alert)
    : null

  if (config.execution_enabled) {
    console.log('[execution] ENABLED — orders will be placed on detected opportunities')
  } else {
    console.log('[execution] DISABLED — alarm-only mode (set execution_enabled: true to enable)')
  }

  // Reconciler — only active when inventory is available
  let reconciler: Reconciler | null = null
  if (inventory) {
    reconciler = new Reconciler(
      inventory, db, alert,
      config.reconciliation_tolerance_pct ?? 0.5,
    )
    reconciler.snapshot()
    reconciler.start(config.reconciliation_interval_hours ?? 4)
  }

  // Startup: recover any PENDING orders placed by this bot in a previous session
  if (config.execution_enabled && keyedExchanges.length > 0) {
    await recoverPendingOrders(client, db, keyedExchanges)
  }

  // Heartbeat: write to detector_settings every 30s so dashboard /health can check liveness
  const startupAt = Date.now()
  writeSettings.run('startup_at_ms', String(startupAt))
  writeSettings.run('execution_enabled', config.execution_enabled ? '1' : '0')
  const writeHeartbeat = db.prepare(`INSERT OR REPLACE INTO detector_settings (key, value) VALUES ('last_heartbeat_ms', ?)`)
  setInterval(() => {
    try { writeHeartbeat.run(String(Date.now())) } catch {}
  }, 30_000)

  const wsFeed = Object.keys(env.wsUrls).length > 0
    ? new WsFeedManager(env.wsUrls, config.staleness_threshold_ms ?? 2000)
    : null

  // Funding rate arbitrage module
  let fundingScanner: FundingScanner | null = null
  let fundingCoordinator: FundingCoordinator | null = null

  if (config.funding_arb?.enabled) {
    const fa = config.funding_arb
    const fundingExchanges = fa.exchanges ?? keyedExchanges
    if (fundingExchanges.length === 0) {
      console.warn('[funding] no exchanges with API keys — funding arb disabled (requires API keys)')
    } else {
      const perpClient = new PerpClient(env)
      if (config.execution_enabled) {
        perpClient.enableExecution(fa.dry_run !== false)
      }

      fundingScanner = new FundingScanner(perpClient, fa, db, alert, fundingExchanges)
      fundingCoordinator = new FundingCoordinator(perpClient, client, fundingScanner, fa, db, alert)

      fundingScanner.on('signal', sig => {
        fundingCoordinator!.onSignal(sig).catch(err => {
          console.error('[funding] unhandled onSignal error:', err)
        })
      })

      // Recover any positions open from a previous session
      await fundingCoordinator.recoverOpenPositions()

      fundingScanner.start()
      const modeStr = fa.dry_run !== false ? 'DRY-RUN' : 'LIVE'
      console.log(`[funding] arb ENABLED (${modeStr}) — exchanges: ${fundingExchanges.join(', ')}  capital: $${fa.capital_per_side_usdt ?? 100}/side  threshold: ${fa.entry_threshold_pct ?? 0.05}%/8h`)
    }
  } else {
    console.log('[funding] arb DISABLED (set funding_arb.enabled: true to enable)')
  }

  process.on('SIGINT', () => { wsFeed?.disconnect(); reconciler?.stop(); fundingScanner?.stop(); logger.flush(); process.exit(0) })
  process.on('SIGTERM', () => { wsFeed?.disconnect(); reconciler?.stop(); fundingScanner?.stop(); logger.flush(); process.exit(0) })

  const configuredExchanges = Object.keys(config.exchanges).filter(ex => {
    if (env.exchangeUrls[ex]) return true
    console.warn(`[config] exchange '${ex}' defined in config.yaml but no URL in env — skipping`)
    return false
  })

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
        const spreads: Array<{ sym: string; spread: ReturnType<typeof computeSpread>; effectiveCapital: number }> = []
        for (const sym of qualifying) {
          const symExs = symbolExchanges.get(sym)!

          let best: ReturnType<typeof computeSpread> | null = null
          let bestCapital = config.capital_per_trade_usdt
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
              if (!best || s.netSpreadPct > best.netSpreadPct) {
                best = s
                bestCapital = effectiveCapital
              }
            }
          }
          if (best) spreads.push({ sym, spread: best, effectiveCapital: bestCapital })
          lastScannedAt.set(sym, Date.now())
        }

        // Phase 2: log all prices in one transaction
        db.transaction(() => {
          for (const { sym, spread } of spreads) {
            logger.logPrice(sym, spread)
          }
        })()

        // Phase 3: check for opportunities (outside transaction)
        for (const { sym, spread, effectiveCapital } of spreads) {
          if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
            // Inventory gate — skipped in alarm-only mode (inventory is null)
            if (inventory) {
              const baseAsset = sym.endsWith('USDT') ? sym.slice(0, -4) : sym.slice(0, -3)
              const check = inventory.canTrade(spread.exchangeBuy, spread.exchangeSell, baseAsset, config.capital_per_trade_usdt, spread.askBuy)
              if (!check.ok) {
                console.warn(`[inventory] skip ${sym}: ${check.reason}`)
                continue
              }
              inventory.deduct(spread.exchangeBuy, spread.exchangeSell, baseAsset, config.capital_per_trade_usdt, spread.askBuy)
            }

            const prev = lastScannedAt.get(sym)
            const openResolutionMs = prev != null ? Date.now() - prev : null
            const opp = tracker.open(spread, sym, [spread.exchangeBuy, spread.exchangeSell], client, config, logger, wsFeed, openResolutionMs, effectiveCapital)
            logger.logOpportunityOpened(opp)

            // Fire execution if enabled — non-blocking, does not hold up the scan loop
            if (coordinator) {
              coordinator.execute(opp, effectiveCapital).catch(err => {
                console.error(`[execution] unhandled error for ${opp.id}:`, err)
              })
            }
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
