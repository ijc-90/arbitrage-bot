import { Config } from './config'
import { AlertSeverity } from './alerting'

export interface RiskApproval {
  ok: boolean
  reason?: string
}

export interface RiskState {
  halted: boolean
  haltReason: string
  openPositions: number
  dailyRealizedPnl: number
  sessionPeakPnl: number
  perExchangeNotional: Record<string, number>
}

type AlertFn = (event: string, severity: AlertSeverity, detail: Record<string, unknown>) => void

// Requests-per-minute budget per exchange. Conservative values — exchange limits are higher
// but we want headroom for discovery polls, balance refreshes, and order status queries.
const RATE_LIMIT_RPM: Record<string, number> = {
  binance: 600,   // actual: 1200 weight/min; use 50% to leave room for REST polls
  bybit:   240,   // actual: varies; conservative
  bingx:   120,
}

export class RiskManager {
  private halted = false
  private haltReason = ''
  private openPositions = 0
  private perExchangeNotional = new Map<string, number>()
  private dailyRealizedPnl = 0
  private sessionPeakPnl = 0

  // Rolling 60s request counters per exchange for rate-limit tracking
  private rateCounters = new Map<string, { count: number; windowStart: number }>()

  constructor(
    private config: Config,
    private alert: AlertFn,
    private persistState: (state: RiskState) => void,
  ) {}

  // Call before placing any order. Returns { ok: false } when halted or limits are exceeded.
  approve(exchangeBuy: string, exchangeSell: string, capitalUsdt: number): RiskApproval {
    if (this.halted) return { ok: false, reason: `halted: ${this.haltReason}` }

    const maxPositions = this.config.max_concurrent_positions ?? 1
    if (this.openPositions >= maxPositions) {
      return { ok: false, reason: `max_concurrent_positions (${maxPositions}) reached` }
    }

    const maxNotional = this.config.max_notional_per_exchange_usdt ?? 1000
    const buyCommitted = (this.perExchangeNotional.get(exchangeBuy) ?? 0) + capitalUsdt
    const sellCommitted = (this.perExchangeNotional.get(exchangeSell) ?? 0) + capitalUsdt
    if (buyCommitted > maxNotional) {
      return { ok: false, reason: `${exchangeBuy} notional ${buyCommitted.toFixed(0)} USDT would exceed limit ${maxNotional}` }
    }
    if (sellCommitted > maxNotional) {
      return { ok: false, reason: `${exchangeSell} notional ${sellCommitted.toFixed(0)} USDT would exceed limit ${maxNotional}` }
    }

    return { ok: true }
  }

  // Call when an execution starts (both legs submitted).
  onOpen(exchangeBuy: string, exchangeSell: string, capitalUsdt: number): void {
    this.openPositions++
    this.add(this.perExchangeNotional, exchangeBuy, capitalUsdt)
    this.add(this.perExchangeNotional, exchangeSell, capitalUsdt)
    this.persist()
  }

  // Call when an execution completes (both legs resolved, including hedges).
  onClose(pnlUsdt: number, exchangeBuy: string, exchangeSell: string, capitalUsdt: number): void {
    this.openPositions = Math.max(0, this.openPositions - 1)
    this.sub(this.perExchangeNotional, exchangeBuy, capitalUsdt)
    this.sub(this.perExchangeNotional, exchangeSell, capitalUsdt)
    this.dailyRealizedPnl += pnlUsdt
    if (this.dailyRealizedPnl > this.sessionPeakPnl) this.sessionPeakPnl = this.dailyRealizedPnl

    const maxDailyLoss = this.config.max_daily_loss_usdt ?? 50
    if (this.dailyRealizedPnl < -maxDailyLoss) {
      this.halt(`daily loss ${(-this.dailyRealizedPnl).toFixed(2)} USDT exceeded limit ${maxDailyLoss} USDT`)
      return
    }

    const maxDrawdownPct = this.config.max_drawdown_pct ?? 5
    const capitalRef = this.config.capital_per_trade_usdt * 10  // rough portfolio proxy
    const drawdown = this.sessionPeakPnl - this.dailyRealizedPnl
    const drawdownPct = capitalRef > 0 ? (drawdown / capitalRef) * 100 : 0
    if (drawdownPct > maxDrawdownPct) {
      this.halt(`drawdown ${drawdown.toFixed(2)} USDT (${drawdownPct.toFixed(1)}%) exceeded ${maxDrawdownPct}% threshold`)
    }

    this.persist()
  }

  // Track an outbound API request and check rate limits.
  // Returns false when at 95% of limit — caller should back off.
  trackRequest(exchange: string): boolean {
    const now = Date.now()
    const limit = RATE_LIMIT_RPM[exchange] ?? 600
    let c = this.rateCounters.get(exchange)
    if (!c || now - c.windowStart > 60_000) {
      c = { count: 0, windowStart: now }
      this.rateCounters.set(exchange, c)
    }
    c.count++
    const usePct = c.count / limit * 100
    if (usePct >= 95) {
      console.error(`[rate-limit:${exchange}] ${c.count}/${limit} req/min — AT LIMIT, backing off`)
      return false
    }
    if (usePct >= 80) {
      console.warn(`[rate-limit:${exchange}] ${c.count}/${limit} req/min — approaching limit (${usePct.toFixed(0)}%)`)
    }
    return true
  }

  // Reset daily counters. Call at UTC midnight.
  resetDay(): void {
    this.dailyRealizedPnl = 0
    this.sessionPeakPnl = 0
    console.log('[risk] daily PnL counters reset (UTC midnight)')
    this.persist()
  }

  // Call when a hedge order fails and the position cannot be flattened automatically.
  // Halts the bot immediately and keeps position/notional counters elevated (position is still open).
  onHedgeFailed(exchangeBuy: string, exchangeSell: string, capitalUsdt: number, detail: string): void {
    this.halt(`hedge_failed: ${detail} — manual close required on ${exchangeBuy}/${exchangeSell}`)
    // Do NOT decrement openPositions or perExchangeNotional — the position is still live.
    // Operator must manually close it, then call resume() to restart the bot.
  }

  // Manual circuit-breaker reset (requires operator action).
  resume(): void {
    this.halted = false
    this.haltReason = ''
    console.log('[risk] circuit breaker manually resumed')
    this.persist()
  }

  getState(): RiskState {
    return {
      halted: this.halted,
      haltReason: this.haltReason,
      openPositions: this.openPositions,
      dailyRealizedPnl: this.dailyRealizedPnl,
      sessionPeakPnl: this.sessionPeakPnl,
      perExchangeNotional: Object.fromEntries(this.perExchangeNotional),
    }
  }

  private halt(reason: string): void {
    this.halted = true
    this.haltReason = reason
    console.error(`\n[CIRCUIT BREAKER] *** HALTED *** ${reason}\n`)
    this.alert('circuit_breaker', 'critical', {
      reason,
      dailyRealizedPnl: this.dailyRealizedPnl,
      openPositions: this.openPositions,
    })
    this.persist()
  }

  private persist(): void {
    try { this.persistState(this.getState()) } catch {}
  }

  private add(map: Map<string, number>, key: string, val: number): void {
    map.set(key, (map.get(key) ?? 0) + val)
  }

  private sub(map: Map<string, number>, key: string, val: number): void {
    map.set(key, Math.max(0, (map.get(key) ?? 0) - val))
  }
}
