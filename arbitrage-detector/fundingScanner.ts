import { FundingArbConfig } from './config'
import { PerpClient, FundingRate } from './perpClient'
import { AlertSeverity } from './alerting'
import type { Db } from './db'

export interface FundingSignal {
  exchange: string
  symbol: string
  fundingRatePct: number
  nextFundingTimeMs: number | null
  markPrice: number
  detectedAt: number
}

type AlertFn = (event: string, severity: AlertSeverity, detail: Record<string, unknown>) => void
type SignalCallback = (signal: FundingSignal) => void

export class FundingScanner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private signalCallbacks: SignalCallback[] = []

  // Track which pair+exchange combos already have open positions so we don't double-signal.
  // Populated by FundingCoordinator via markOpen/markClosed.
  private openPositions = new Set<string>()  // `${exchange}:${symbol}`

  constructor(
    private client: PerpClient,
    private config: FundingArbConfig,
    private db: Db,
    private alert: AlertFn,
    private exchanges: string[],
  ) {}

  on(event: 'signal', cb: SignalCallback): void {
    if (event === 'signal') this.signalCallbacks.push(cb)
  }

  markOpen(exchange: string, symbol: string): void {
    this.openPositions.add(`${exchange}:${symbol}`)
  }

  markClosed(exchange: string, symbol: string): void {
    this.openPositions.delete(`${exchange}:${symbol}`)
  }

  start(): void {
    if (this.running) return
    this.running = true
    console.log(`[funding-scanner] started — exchanges: ${this.exchanges.join(', ')} interval: ${this.config.scan_interval_ms ?? 60000}ms`)
    void this.scan()
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    console.log('[funding-scanner] stopped')
  }

  private schedule(): void {
    if (!this.running) return
    this.timer = setTimeout(() => { void this.scan() }, this.config.scan_interval_ms ?? 60000)
  }

  private async scan(): Promise<void> {
    if (!this.running) return

    const entryThreshold = this.config.entry_threshold_pct ?? 0.05
    const minTimeToSettlement = this.config.min_time_to_settlement_ms ?? 600_000
    const allowedPairs = this.config.pairs ? new Set(this.config.pairs) : null

    const insert = this.db.prepare(`
      INSERT INTO funding_rates (fetched_at_ms, exchange, symbol, funding_rate_pct, mark_price, next_funding_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const now = Date.now()

    for (const exchange of this.exchanges) {
      try {
        const rates = await this.client.getAllFundingRates(exchange)

        // Batch-insert all rates in one transaction
        this.db.transaction(() => {
          for (const r of rates) {
            if (allowedPairs && !allowedPairs.has(r.symbol)) continue
            try { insert.run(now, r.exchange, r.symbol, r.fundingRatePct, r.markPrice, r.nextFundingTimeMs ?? null) } catch {}
          }
        })()

        // Detect entry signals
        for (const r of rates) {
          if (allowedPairs && !allowedPairs.has(r.symbol)) continue
          if (r.fundingRatePct <= entryThreshold) continue
          if (this.openPositions.has(`${exchange}:${r.symbol}`)) continue

          // Don't enter too close to settlement
          if (r.nextFundingTimeMs != null) {
            const msUntilSettlement = r.nextFundingTimeMs - Date.now()
            if (msUntilSettlement < minTimeToSettlement) {
              console.log(`[funding-scanner] ${exchange} ${r.symbol} rate=${r.fundingRatePct.toFixed(4)}% but settlement in ${Math.round(msUntilSettlement / 60000)}min — skipping`)
              continue
            }
          }

          const signal: FundingSignal = {
            exchange: r.exchange,
            symbol: r.symbol,
            fundingRatePct: r.fundingRatePct,
            nextFundingTimeMs: r.nextFundingTimeMs,
            markPrice: r.markPrice,
            detectedAt: Date.now(),
          }
          console.log(`[funding-scanner] SIGNAL ${exchange} ${r.symbol} rate=${r.fundingRatePct.toFixed(4)}%/8h  mark=${r.markPrice}`)
          for (const cb of this.signalCallbacks) {
            try { cb(signal) } catch (e) { console.error('[funding-scanner] signal callback error:', e) }
          }
        }

        console.log(`[funding-scanner] ${exchange}: ${rates.length} pairs scanned, top rate=${rates.reduce((m, r) => Math.max(m, r.fundingRatePct), 0).toFixed(4)}%`)
      } catch (err: any) {
        console.error(`[funding-scanner] ${exchange} scan error: ${err.message}`)
        this.alert('funding_scan_error', 'warn', { exchange, error: err.message })
      }
    }

    this.schedule()
  }
}
