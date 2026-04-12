import { FundingArbConfig } from './config'
import { PerpClient, PerpPosition } from './perpClient'
import { ExchangeClient } from './exchangeClient'
import { FundingScanner, FundingSignal } from './fundingScanner'
import { AlertSeverity } from './alerting'
import type { Db } from './db'

// ── Types ──────────────────────────────────────────────────────────────────────

export type FundingCloseReason =
  | 'FUNDING_NORMALIZED'
  | 'FUNDING_FLIPPED'
  | 'MAX_HOLD'
  | 'LIQ_PROXIMITY'
  | 'STOP_LOSS'
  | 'RISK_HALTED'
  | 'ERROR'

interface ActivePosition {
  id: string
  symbol: string
  exchange: string
  openedAtMs: number
  entrySpotPrice: number
  entryPerpPrice: number
  qty: number
  capitalPerSideUsdt: number
  spotOrderId: string
  perpOrderId: string
  entryFundingRatePct: number
  dryRun: boolean
}

type AlertFn = (event: string, severity: AlertSeverity, detail: Record<string, unknown>) => void

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

function floorQty(qty: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.floor(qty * factor) / factor
}

// ── FundingCoordinator ────────────────────────────────────────────────────────

export class FundingCoordinator {
  private activePositions = new Map<string, ActivePosition>()  // id → position
  private pollTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private perpClient: PerpClient,
    private spotClient: ExchangeClient,
    private scanner: FundingScanner,
    private config: FundingArbConfig,
    private db: Db,
    private alert: AlertFn,
  ) {}

  async onSignal(signal: FundingSignal): Promise<void> {
    const maxPositions = this.config.max_positions ?? 3
    if (this.activePositions.size >= maxPositions) {
      console.log(`[funding] skip ${signal.exchange} ${signal.symbol} — max positions (${maxPositions}) reached`)
      return
    }

    // Check no existing position for this pair+exchange
    const key = `${signal.exchange}:${signal.symbol}`
    for (const pos of this.activePositions.values()) {
      if (pos.exchange === signal.exchange && pos.symbol === signal.symbol) {
        console.log(`[funding] skip ${key} — position already open`)
        return
      }
    }

    await this.enter(signal)
  }

  private async enter(signal: FundingSignal): Promise<void> {
    const capital = this.config.capital_per_side_usdt ?? 100
    const leverage = this.config.leverage ?? 1
    const dryRun = this.config.dry_run !== false  // default true for safety

    console.log(`[funding] entering ${signal.exchange} ${signal.symbol} rate=${signal.fundingRatePct.toFixed(4)}%/8h capital=$${capital}/side`)

    try {
      // Set leverage before placing any order
      await this.perpClient.setLeverage(signal.exchange, signal.symbol, leverage)

      // Get current spot ask for qty calculation
      const spotAsk = dryRun
        ? signal.markPrice  // use mark price as proxy in dry-run (no real fill anyway)
        : await this.perpClient.getSpotAskPrice(signal.exchange, signal.symbol)

      if (!spotAsk || spotAsk <= 0) throw new Error(`Invalid spot ask price: ${spotAsk}`)
      const qty = floorQty(capital / spotAsk)
      if (qty <= 0) throw new Error(`Computed qty is zero for capital=${capital} ask=${spotAsk}`)

      // Submit both legs in parallel
      const [spotSettled, perpSettled] = await Promise.allSettled([
        this.spotClient.placeOrder(signal.exchange, signal.symbol, 'BUY', 'MARKET', qty),
        this.perpClient.placePerpOrder(signal.exchange, signal.symbol, 'SELL', qty, false),
      ])

      const spotOk   = spotSettled.status === 'fulfilled'
      const perpOk   = perpSettled.status === 'fulfilled'
      const spotResult = spotOk ? spotSettled.value : null
      const perpResult = perpOk ? perpSettled.value : null

      if (!spotOk || !perpOk) {
        // One or both legs failed — close whatever filled
        const spotErr = !spotOk ? (spotSettled as PromiseRejectedResult).reason?.message : null
        const perpErr = !perpOk ? (perpSettled as PromiseRejectedResult).reason?.message : null
        console.error(`[funding] entry failed ${signal.exchange} ${signal.symbol} — spot=${spotErr ?? 'ok'} perp=${perpErr ?? 'ok'}`)

        // Hedge: close whichever leg succeeded
        if (spotOk && spotResult) {
          try {
            await this.spotClient.placeOrder(signal.exchange, signal.symbol, 'SELL', 'MARKET', spotResult.filledQty)
          } catch (e: any) {
            this.alert('funding_entry_hedge_failed', 'critical', {
              exchange: signal.exchange, symbol: signal.symbol, error: e.message,
              spotOrderId: spotResult.orderId,
            })
          }
        }
        if (perpOk && perpResult) {
          try {
            await this.perpClient.placePerpOrder(signal.exchange, signal.symbol, 'BUY', perpResult.filledQty || qty, true)
          } catch (e: any) {
            this.alert('funding_entry_hedge_failed', 'critical', {
              exchange: signal.exchange, symbol: signal.symbol, error: e.message,
              perpOrderId: perpResult.orderId,
            })
          }
        }
        return
      }

      const id = shortId()
      const entrySpotPrice = spotResult!.avgFillPrice || spotAsk
      const entryPerpPrice = perpResult!.avgFillPrice || signal.markPrice
      const actualQty = spotResult!.filledQty || qty

      const pos: ActivePosition = {
        id, symbol: signal.symbol, exchange: signal.exchange,
        openedAtMs: Date.now(),
        entrySpotPrice, entryPerpPrice,
        qty: actualQty, capitalPerSideUsdt: capital,
        spotOrderId: spotResult!.orderId,
        perpOrderId: perpResult!.orderId,
        entryFundingRatePct: signal.fundingRatePct,
        dryRun,
      }

      this.activePositions.set(id, pos)
      this.scanner.markOpen(signal.exchange, signal.symbol)

      // Persist to DB
      this.db.prepare(`
        INSERT INTO funding_positions
          (id, symbol, exchange, opened_at_ms, entry_spot_price, entry_perp_price,
           qty, capital_per_side_usdt, spot_order_id, perp_order_id, entry_funding_rate_pct, dry_run)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, pos.symbol, pos.exchange, pos.openedAtMs,
        entrySpotPrice, entryPerpPrice, actualQty, capital,
        spotResult!.orderId, perpResult!.orderId,
        signal.fundingRatePct, dryRun ? 1 : 0,
      )

      console.log(`[funding:${id}] OPENED ${signal.exchange} ${signal.symbol}  qty=${actualQty}  spot@${entrySpotPrice}  perp@${entryPerpPrice}`)

      // Start position monitor
      this.schedulePoll(pos)
    } catch (err: any) {
      console.error(`[funding] entry error ${signal.exchange} ${signal.symbol}: ${err.message}`)
      this.alert('funding_entry_error', 'warn', { exchange: signal.exchange, symbol: signal.symbol, error: err.message })
    }
  }

  private schedulePoll(pos: ActivePosition): void {
    const interval = this.config.poll_interval_ms ?? 60_000
    const timer = setTimeout(() => { void this.poll(pos) }, interval)
    this.pollTimers.set(pos.id, timer)
  }

  private async poll(pos: ActivePosition): Promise<void> {
    if (!this.activePositions.has(pos.id)) return  // already closed

    try {
      const exitThreshold    = this.config.exit_threshold_pct ?? 0.01
      const maxHoldMs        = (this.config.max_hold_hours ?? 72) * 3_600_000
      const stopLossPct      = this.config.stop_loss_pct ?? 2.0
      const liqBufferPct     = this.config.liquidation_buffer_pct ?? 10.0
      const maxBasisPct      = this.config.max_basis_pct ?? 0.5

      // Fetch current funding rate and perp position
      const [rates, perpPos] = await Promise.allSettled([
        this.perpClient.getAllFundingRates(pos.exchange),
        pos.dryRun
          ? Promise.resolve<PerpPosition | null>(null)
          : this.perpClient.getPerpPosition(pos.exchange, pos.symbol),
      ])

      const currentRate = rates.status === 'fulfilled'
        ? rates.value.find(r => r.symbol === pos.symbol)
        : null
      const position = perpPos.status === 'fulfilled' ? perpPos.value : null

      // ── Exit condition checks (priority order) ──────────────────────────────

      // 1. Funding normalized
      if (currentRate && currentRate.fundingRatePct <= exitThreshold) {
        console.log(`[funding:${pos.id}] funding normalized (${currentRate.fundingRatePct.toFixed(4)}% <= ${exitThreshold}%) — closing`)
        await this.exit(pos, 'FUNDING_NORMALIZED', currentRate.markPrice)
        return
      }

      // 2. Funding flipped negative
      if (currentRate && currentRate.fundingRatePct < 0) {
        console.log(`[funding:${pos.id}] funding flipped negative (${currentRate.fundingRatePct.toFixed(4)}%) — closing`)
        await this.exit(pos, 'FUNDING_FLIPPED', currentRate.markPrice)
        return
      }

      // 3. Max hold time
      if (Date.now() - pos.openedAtMs > maxHoldMs) {
        console.log(`[funding:${pos.id}] max hold time exceeded — closing`)
        await this.exit(pos, 'MAX_HOLD', currentRate?.markPrice ?? pos.entryPerpPrice)
        return
      }

      // 4. Liquidation proximity
      if (position && position.liquidationPrice > 0) {
        const distancePct = Math.abs(position.markPrice - position.liquidationPrice) / position.liquidationPrice * 100
        if (distancePct < liqBufferPct) {
          console.warn(`[funding:${pos.id}] liquidation proximity ${distancePct.toFixed(1)}% < ${liqBufferPct}% buffer — emergency close`)
          this.alert('funding_liq_proximity', 'critical', {
            id: pos.id, symbol: pos.symbol, exchange: pos.exchange,
            distancePct, liquidationPrice: position.liquidationPrice, markPrice: position.markPrice,
          })
          await this.exit(pos, 'LIQ_PROXIMITY', position.markPrice)
          return
        }
      }

      // 5. Stop-loss on perp unrealized loss
      if (position && position.unrealizedPnl < 0) {
        const lossPct = Math.abs(position.unrealizedPnl) / (pos.capitalPerSideUsdt) * 100
        if (lossPct > stopLossPct) {
          console.warn(`[funding:${pos.id}] stop-loss triggered ${lossPct.toFixed(2)}% > ${stopLossPct}%`)
          await this.exit(pos, 'STOP_LOSS', position.markPrice)
          return
        }
      }

      // 6. Basis alert (perp mark vs spot — not an exit condition, just an alert)
      if (position && currentRate) {
        const spotAsk = await this.perpClient.getSpotAskPrice(pos.exchange, pos.symbol).catch(() => 0)
        if (spotAsk > 0) {
          const basisPct = Math.abs(currentRate.markPrice - spotAsk) / spotAsk * 100
          if (basisPct > maxBasisPct) {
            console.warn(`[funding:${pos.id}] high basis ${basisPct.toFixed(3)}% — perp/spot diverging`)
            this.alert('funding_high_basis', 'warn', {
              id: pos.id, symbol: pos.symbol, exchange: pos.exchange, basisPct,
            })
          }
        }
      }

      // Still healthy — log status and reschedule
      const heldMs = Date.now() - pos.openedAtMs
      const rateStr = currentRate ? `rate=${currentRate.fundingRatePct.toFixed(4)}%` : 'rate=unknown'
      const pnlStr = position ? `upnl=${position.unrealizedPnl.toFixed(4)}` : ''
      console.log(`[funding:${pos.id}] ${pos.symbol} ${pos.exchange} held=${Math.round(heldMs / 60000)}min ${rateStr} ${pnlStr}`)

      this.schedulePoll(pos)
    } catch (err: any) {
      console.error(`[funding:${pos.id}] poll error: ${err.message}`)
      this.schedulePoll(pos)  // keep polling despite error
    }
  }

  private async exit(pos: ActivePosition, reason: FundingCloseReason, currentPrice: number): Promise<void> {
    console.log(`[funding:${pos.id}] closing ${pos.exchange} ${pos.symbol} reason=${reason}`)

    // Cancel any pending poll
    const timer = this.pollTimers.get(pos.id)
    if (timer) { clearTimeout(timer); this.pollTimers.delete(pos.id) }

    // Submit both close legs in parallel with retry
    const closeSpot = () => this.spotClient.placeOrder(pos.exchange, pos.symbol, 'SELL', 'MARKET', pos.qty)
    const closePerp = () => this.perpClient.placePerpOrder(pos.exchange, pos.symbol, 'BUY', pos.qty, true)

    let spotClosePrice = 0
    let perpClosePrice = 0
    let closeFailed = false

    for (let attempt = 1; attempt <= 2; attempt++) {
      const [spotSettled, perpSettled] = await Promise.allSettled([closeSpot(), closePerp()])

      const spotOk = spotSettled.status === 'fulfilled'
      const perpOk = perpSettled.status === 'fulfilled'

      if (spotOk) spotClosePrice = (spotSettled as PromiseFulfilledResult<any>).value.avgFillPrice || currentPrice
      if (perpOk) perpClosePrice = (perpSettled as PromiseFulfilledResult<any>).value.avgFillPrice || currentPrice

      if (spotOk && perpOk) break

      if (attempt === 2) {
        const spotErr = !spotOk ? (spotSettled as PromiseRejectedResult).reason?.message : null
        const perpErr = !perpOk ? (perpSettled as PromiseRejectedResult).reason?.message : null
        console.error(`[funding:${pos.id}] EXIT FAILED after 2 attempts — spot=${spotErr ?? 'ok'} perp=${perpErr ?? 'ok'}`)
        this.alert('funding_exit_failed', 'critical', {
          id: pos.id, symbol: pos.symbol, exchange: pos.exchange,
          spotErr, perpErr, reason,
        })
        closeFailed = true
        // Keep in activePositions so monitor keeps running and alerts persist
        // The operator must close manually, then call closePosition(id) to remove it
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }

    if (closeFailed) return

    // Remove from active tracking
    this.activePositions.delete(pos.id)
    this.scanner.markClosed(pos.exchange, pos.symbol)

    // Compute realized PnL
    // Spot: sell proceeds - buy cost (close_price - entry_price) * qty - fees (approximated)
    // Perp: short closed at perpClosePrice; profit = entry - close (we sold high, bought back lower ideally)
    const spotPnl = (spotClosePrice - pos.entrySpotPrice) * pos.qty
    const perpPnl = (pos.entryPerpPrice - perpClosePrice) * pos.qty
    // Funding collected: approximate from rate × periods held (exact amount requires exchange API)
    const hoursHeld = (Date.now() - pos.openedAtMs) / 3_600_000
    const periodsHeld = hoursHeld / 8  // one period = 8h
    const fundingCollected = pos.entryFundingRatePct / 100 * pos.capitalPerSideUsdt * periodsHeld
    const fees = pos.qty * pos.entrySpotPrice * 0.001 * 2 + pos.qty * pos.entryPerpPrice * 0.0005 * 2  // entry + exit, both sides
    const realizedPnl = fundingCollected + spotPnl + perpPnl - fees

    const closedAtMs = Date.now()
    this.db.prepare(`
      UPDATE funding_positions SET
        closed_at_ms = ?, close_reason = ?,
        exit_spot_price = ?, exit_perp_price = ?,
        funding_collected_usdt = ?, realized_pnl_usdt = ?
      WHERE id = ?
    `).run(closedAtMs, reason, spotClosePrice, perpClosePrice, fundingCollected, realizedPnl, pos.id)

    console.log(`[funding:${pos.id}] CLOSED reason=${reason}  funding_collected=$${fundingCollected.toFixed(4)}  realized_pnl=$${realizedPnl.toFixed(4)}`)
  }

  // Recovers open positions from DB on startup (crash recovery).
  async recoverOpenPositions(): Promise<void> {
    let rows: any[]
    try {
      rows = this.db.prepare(`SELECT * FROM funding_positions WHERE closed_at_ms IS NULL`).all() as any[]
    } catch { return }

    if (rows.length === 0) return
    console.log(`[funding] recovering ${rows.length} open position(s) from previous session`)

    for (const row of rows) {
      const pos: ActivePosition = {
        id: row.id, symbol: row.symbol, exchange: row.exchange,
        openedAtMs: row.opened_at_ms,
        entrySpotPrice: row.entry_spot_price, entryPerpPrice: row.entry_perp_price,
        qty: row.qty, capitalPerSideUsdt: row.capital_per_side_usdt,
        spotOrderId: row.spot_order_id ?? '', perpOrderId: row.perp_order_id ?? '',
        entryFundingRatePct: row.entry_funding_rate_pct,
        dryRun: row.dry_run === 1,
      }
      this.activePositions.set(pos.id, pos)
      this.scanner.markOpen(pos.exchange, pos.symbol)
      this.schedulePoll(pos)
      console.log(`[funding] recovered position ${pos.id} ${pos.exchange} ${pos.symbol} (open since ${new Date(pos.openedAtMs).toISOString()})`)
    }
  }

  // Force-close a specific position by ID (operator tool for stuck positions).
  async closePosition(id: string, reason: FundingCloseReason = 'ERROR'): Promise<void> {
    const pos = this.activePositions.get(id)
    if (!pos) { console.warn(`[funding] closePosition: no active position with id=${id}`); return }
    await this.exit(pos, reason, 0)
  }

  getActivePositions(): ActivePosition[] {
    return Array.from(this.activePositions.values())
  }
}
