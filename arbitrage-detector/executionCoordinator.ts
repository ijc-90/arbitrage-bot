import { ExchangeClient } from './exchangeClient'
import { RiskManager } from './riskManager'
import { Config } from './config'
import type { Db } from './db'
import { Opportunity } from './opportunityTracker'
import { computeEffectiveFill, parseLevels } from './orderBook'
import { AlertSeverity } from './alerting'
import { OrderResult } from './types'

export type ExecutionStatus = 'FILLED' | 'PARTIAL_FILL' | 'FAILED' | 'STALE' | 'HALTED' | 'DISABLED'

export interface ExecutionOutcome {
  status: ExecutionStatus
  opportunityId: string
  buyOrderId?: string
  sellOrderId?: string
  filledQty: number
  avgBuyPrice: number
  avgSellPrice: number
  buyFeeUsdt: number
  sellFeeUsdt: number
  realizedPnlUsdt: number
  detectedAt: number
  executedAt: number
  detectionToExecutionMs: number
  error?: string
}

type AlertFn = (event: string, severity: AlertSeverity, detail: Record<string, unknown>) => void

// Round qty down to `decimals` places to avoid LOT_SIZE errors on exchanges.
// This is a conservative default — exchange-specific step sizes are not yet fetched.
function floorQty(qty: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.floor(qty * factor) / factor
}

export class ExecutionCoordinator {
  constructor(
    private client: ExchangeClient,
    private risk: RiskManager,
    private config: Config,
    private db: Db,
    private alert: AlertFn,
  ) {}

  async execute(opp: Opportunity, capitalUsdt: number): Promise<ExecutionOutcome> {
    if (!this.config.execution_enabled) {
      return this.outcome(opp, 'DISABLED', 'execution_enabled is false')
    }

    // Stale check: reject if too much time elapsed since detection
    const maxAgeMs = this.config.max_execution_age_ms ?? 500
    const ageMs = Date.now() - opp.openedAt
    if (ageMs > maxAgeMs) {
      console.warn(`[exec:${opp.id}] stale by ${ageMs}ms > ${maxAgeMs}ms — skipping`)
      return this.outcome(opp, 'STALE', `opportunity stale by ${ageMs}ms`)
    }

    // Risk approval
    const approval = this.risk.approve(opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
    if (!approval.ok) {
      console.warn(`[exec:${opp.id}] risk rejected: ${approval.reason}`)
      return this.outcome(opp, 'HALTED', approval.reason)
    }

    // AT-5: fetch order books and compute effective fill prices
    let effectiveAskBuy = opp.askBuy
    let effectiveBidSell = opp.bidSell
    let depthSlippagePct = 0

    try {
      const depth = this.config.order_book_depth ?? 10
      const minFillRatio = this.config.min_fill_ratio ?? 0.9

      const [bookBuy, bookSell] = await Promise.all([
        this.client.fetchOrderBook(opp.exchangeBuy, opp.pair, depth),
        this.client.fetchOrderBook(opp.exchangeSell, opp.pair, depth),
      ])

      const fillBuy = computeEffectiveFill(parseLevels(bookBuy.asks), capitalUsdt, 'buy')
      const fillSell = computeEffectiveFill(parseLevels(bookSell.bids), capitalUsdt, 'sell')

      if (fillBuy.fillRatio < minFillRatio || fillSell.fillRatio < minFillRatio) {
        const r = Math.min(fillBuy.fillRatio, fillSell.fillRatio)
        console.warn(`[exec:${opp.id}] book too thin (fill_ratio=${r.toFixed(2)} < ${minFillRatio}) — skipping`)
        return this.outcome(opp, 'FAILED', `order book too thin: fill_ratio=${r.toFixed(2)}`)
      }

      effectiveAskBuy = fillBuy.avgPrice
      effectiveBidSell = fillSell.avgPrice
      depthSlippagePct = fillBuy.slippagePct + fillSell.slippagePct

      // Recalculate net spread with real depth slippage
      const cfg = this.config
      const buyFee = cfg.exchanges[opp.exchangeBuy]?.taker_fee_pct ?? 0.1
      const sellFee = cfg.exchanges[opp.exchangeSell]?.taker_fee_pct ?? 0.1
      const allInCost = buyFee + sellFee + depthSlippagePct
      const netSpread = (effectiveBidSell - effectiveAskBuy) / effectiveAskBuy * 100 - allInCost

      if (netSpread <= 0) {
        console.warn(`[exec:${opp.id}] net spread after depth slippage is ${netSpread.toFixed(4)}% — skipping`)
        return this.outcome(opp, 'FAILED', `net spread ${netSpread.toFixed(4)}% after depth slippage`)
      }
    } catch (err: any) {
      console.warn(`[exec:${opp.id}] order book fetch failed, using quoted prices: ${err.message}`)
      // Fall through: use quoted tick prices and fixed slippage
    }

    // Compute qty from effective ask price
    const qty = floorQty(capitalUsdt / effectiveAskBuy)
    if (qty <= 0) {
      return this.outcome(opp, 'FAILED', `computed qty is zero for capital=${capitalUsdt} ask=${effectiveAskBuy}`)
    }

    this.risk.onOpen(opp.exchangeBuy, opp.exchangeSell, capitalUsdt)

    let buyResult: OrderResult | null = null
    let sellResult: OrderResult | null = null
    let hedgeOrderId: string | undefined

    try {
      // Submit both legs in parallel
      const [buySettled, sellSettled] = await Promise.allSettled([
        this.client.placeOrder(opp.exchangeBuy, opp.pair, 'BUY', 'MARKET', qty),
        this.client.placeOrder(opp.exchangeSell, opp.pair, 'SELL', 'MARKET', qty),
      ])

      const buyOk = buySettled.status === 'fulfilled' && buySettled.value.status !== 'REJECTED'
      const sellOk = sellSettled.status === 'fulfilled' && sellSettled.value.status !== 'REJECTED'

      if (buyOk) buyResult = buySettled.value
      if (sellOk) sellResult = sellSettled.value

      // Retry REJECTED legs once with a fresh order ID
      if (!buyOk && buySettled.status === 'fulfilled' && buySettled.value.status === 'REJECTED') {
        try {
          buyResult = await this.client.placeOrder(opp.exchangeBuy, opp.pair, 'BUY', 'MARKET', qty)
        } catch {}
      }
      if (!sellOk && sellSettled.status === 'fulfilled' && sellSettled.value.status === 'REJECTED') {
        try {
          sellResult = await this.client.placeOrder(opp.exchangeSell, opp.pair, 'SELL', 'MARKET', qty)
        } catch {}
      }

      // Poll for Bybit fills (placement returns NEW, not fill details)
      if (buyResult?.status === 'NEW' || buyResult?.status === 'PARTIALLY_FILLED') {
        buyResult = await this.pollUntilFilled(opp.exchangeBuy, opp.pair, buyResult.orderId, 3)
      }
      if (sellResult?.status === 'NEW' || sellResult?.status === 'PARTIALLY_FILLED') {
        sellResult = await this.pollUntilFilled(opp.exchangeSell, opp.pair, sellResult.orderId, 3)
      }

      const bothFilled = buyResult?.status === 'FILLED' && sellResult?.status === 'FILLED'
      const oneBuyFilled = buyResult?.status === 'FILLED' && (!sellResult || sellResult.status !== 'FILLED')
      const oneSellFilled = sellResult?.status === 'FILLED' && (!buyResult || buyResult.status !== 'FILLED')

      if (bothFilled) {
        const pnl = this.computePnl(buyResult!, sellResult!, capitalUsdt)
        const outcome = this.buildOutcome(opp, 'FILLED', buyResult!, sellResult!, pnl, depthSlippagePct)
        this.risk.onClose(pnl, opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
        this.persist(outcome)
        console.log(`[exec:${opp.id}] FILLED  pnl=${pnl.toFixed(4)} USDT  buy=${buyResult!.avgFillPrice}  sell=${sellResult!.avgFillPrice}`)
        return outcome
      }

      // One leg filled, other didn't → hedge to flatten position.
      // Retries once on failure. If both attempts fail the position is left open:
      // bot halts (circuit breaker), position/notional counters stay elevated, operator must close manually.
      if (oneBuyFilled && buyResult) {
        console.warn(`[exec:${opp.id}] sell leg failed — hedging buy leg (SELL MARKET ${buyResult.filledQty} on ${opp.exchangeBuy})`)
        let hedgeErr: string | undefined
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const hedge = await this.client.placeOrder(opp.exchangeBuy, opp.pair, 'SELL', 'MARKET', buyResult.filledQty)
            hedgeOrderId = hedge.orderId
            hedgeErr = undefined
            break
          } catch (e: any) {
            hedgeErr = e.message
            if (attempt < 2) await new Promise(r => setTimeout(r, 500))
          }
        }
        if (hedgeErr !== undefined) {
          console.error(`[exec:${opp.id}] HEDGE FAILED after 2 attempts — halting bot, manual close required: ${hedgeErr}`)
          this.alert('hedge_failed', 'critical', { opportunityId: opp.id, pair: opp.pair, buyOrderId: buyResult.orderId, error: hedgeErr })
          this.risk.onHedgeFailed(opp.exchangeBuy, opp.exchangeSell, capitalUsdt, `${opp.pair} buy orderId=${buyResult.orderId}`)
          const outcome = this.buildOutcome(opp, 'PARTIAL_FILL', buyResult, null, -(buyResult.feeUsdt * 2), depthSlippagePct)
          this.persist(outcome)
          return outcome
        }
        const pnl = buyResult.feeUsdt > 0 ? -(buyResult.feeUsdt * 2) : 0
        const outcome = this.buildOutcome(opp, 'PARTIAL_FILL', buyResult, null, pnl, depthSlippagePct, hedgeOrderId)
        this.risk.onClose(pnl, opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
        this.persist(outcome)
        return outcome
      }

      if (oneSellFilled && sellResult) {
        console.warn(`[exec:${opp.id}] buy leg failed — hedging sell leg (BUY MARKET ${sellResult.filledQty} on ${opp.exchangeSell})`)
        let hedgeErr: string | undefined
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const hedge = await this.client.placeOrder(opp.exchangeSell, opp.pair, 'BUY', 'MARKET', sellResult.filledQty)
            hedgeOrderId = hedge.orderId
            hedgeErr = undefined
            break
          } catch (e: any) {
            hedgeErr = e.message
            if (attempt < 2) await new Promise(r => setTimeout(r, 500))
          }
        }
        if (hedgeErr !== undefined) {
          console.error(`[exec:${opp.id}] HEDGE FAILED after 2 attempts — halting bot, manual close required: ${hedgeErr}`)
          this.alert('hedge_failed', 'critical', { opportunityId: opp.id, pair: opp.pair, sellOrderId: sellResult.orderId, error: hedgeErr })
          this.risk.onHedgeFailed(opp.exchangeBuy, opp.exchangeSell, capitalUsdt, `${opp.pair} sell orderId=${sellResult.orderId}`)
          const outcome = this.buildOutcome(opp, 'PARTIAL_FILL', null, sellResult, -(sellResult.feeUsdt * 2), depthSlippagePct)
          this.persist(outcome)
          return outcome
        }
        const pnl = sellResult.feeUsdt > 0 ? -(sellResult.feeUsdt * 2) : 0
        const outcome = this.buildOutcome(opp, 'PARTIAL_FILL', null, sellResult, pnl, depthSlippagePct, hedgeOrderId)
        this.risk.onClose(pnl, opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
        this.persist(outcome)
        return outcome
      }

      // Both failed
      const errBuy = buySettled.status === 'rejected' ? buySettled.reason?.message : buyResult?.status
      const errSell = sellSettled.status === 'rejected' ? sellSettled.reason?.message : sellResult?.status
      console.error(`[exec:${opp.id}] BOTH LEGS FAILED  buy=${errBuy}  sell=${errSell}`)
      this.alert('execution_failed', 'warn', { opportunityId: opp.id, pair: opp.pair, errBuy, errSell })
      this.risk.onClose(0, opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
      const outcome = this.outcome(opp, 'FAILED', `buy=${errBuy} sell=${errSell}`)
      this.persist(outcome)
      return outcome

    } catch (err: any) {
      console.error(`[exec:${opp.id}] unrecoverable error: ${err.message}`)
      this.alert('execution_error', 'critical', { opportunityId: opp.id, error: err.message })
      this.risk.onClose(0, opp.exchangeBuy, opp.exchangeSell, capitalUsdt)
      const outcome = this.outcome(opp, 'FAILED', err.message)
      this.persist(outcome)
      return outcome
    }
  }

  // Poll getOrderStatus up to `attempts` times with 300ms delay, until FILLED or CANCELED.
  private async pollUntilFilled(
    exchange: string, symbol: string, orderId: string, attempts: number
  ): Promise<OrderResult> {
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, 300))
      try {
        const s = await this.client.getOrderStatus(exchange, symbol, orderId)
        if (s.status === 'FILLED' || s.status === 'CANCELED' || s.status === 'REJECTED') return s
      } catch {}
    }
    // Return last known state
    return await this.client.getOrderStatus(exchange, symbol, orderId).catch(() => ({
      orderId, clientOrderId: '', status: 'NEW' as any, filledQty: 0, avgFillPrice: 0, feeUsdt: 0, timestamp: Date.now()
    }))
  }

  private computePnl(
    buy: { filledQty: number; avgFillPrice: number; feeUsdt: number },
    sell: { filledQty: number; avgFillPrice: number; feeUsdt: number },
    _capitalUsdt: number,
  ): number {
    const sellProceeds = sell.avgFillPrice * sell.filledQty - sell.feeUsdt
    const buyCost     = buy.avgFillPrice  * buy.filledQty  + buy.feeUsdt
    return sellProceeds - buyCost
  }

  private buildOutcome(
    opp: Opportunity,
    status: ExecutionStatus,
    buy: { orderId?: string; filledQty: number; avgFillPrice: number; feeUsdt: number } | null,
    sell: { orderId?: string; filledQty: number; avgFillPrice: number; feeUsdt: number } | null,
    pnl: number,
    depthSlippagePct: number,
    hedgeOrderId?: string,
  ): ExecutionOutcome {
    const now = Date.now()
    return {
      status,
      opportunityId: opp.id,
      buyOrderId: buy?.orderId,
      sellOrderId: sell?.orderId,
      filledQty: buy?.filledQty ?? sell?.filledQty ?? 0,
      avgBuyPrice: buy?.avgFillPrice ?? 0,
      avgSellPrice: sell?.avgFillPrice ?? 0,
      buyFeeUsdt: buy?.feeUsdt ?? 0,
      sellFeeUsdt: sell?.feeUsdt ?? 0,
      realizedPnlUsdt: pnl,
      detectedAt: opp.openedAt,
      executedAt: now,
      detectionToExecutionMs: now - opp.openedAt,
    }
  }

  private outcome(opp: Opportunity, status: ExecutionStatus, error?: string): ExecutionOutcome {
    const now = Date.now()
    return {
      status, opportunityId: opp.id, error,
      filledQty: 0, avgBuyPrice: 0, avgSellPrice: 0,
      buyFeeUsdt: 0, sellFeeUsdt: 0, realizedPnlUsdt: 0,
      detectedAt: opp.openedAt, executedAt: now,
      detectionToExecutionMs: now - opp.openedAt,
    }
  }

  private persist(outcome: ExecutionOutcome): void {
    try {
      this.db.prepare(`
        INSERT INTO executions (
          opportunity_id, status,
          buy_order_id, sell_order_id,
          filled_qty, avg_buy_price, avg_sell_price,
          buy_fee_usdt, sell_fee_usdt, realized_pnl_usdt,
          detection_to_execution_ms, executed_at_ms
        ) VALUES (
          @opp_id, @status,
          @buy_order_id, @sell_order_id,
          @filled_qty, @avg_buy_price, @avg_sell_price,
          @buy_fee_usdt, @sell_fee_usdt, @realized_pnl_usdt,
          @detection_to_execution_ms, @executed_at_ms
        )
      `).run({
        opp_id: outcome.opportunityId,
        status: outcome.status,
        buy_order_id: outcome.buyOrderId ?? null,
        sell_order_id: outcome.sellOrderId ?? null,
        filled_qty: outcome.filledQty,
        avg_buy_price: outcome.avgBuyPrice,
        avg_sell_price: outcome.avgSellPrice,
        buy_fee_usdt: outcome.buyFeeUsdt,
        sell_fee_usdt: outcome.sellFeeUsdt,
        realized_pnl_usdt: outcome.realizedPnlUsdt,
        detection_to_execution_ms: outcome.detectionToExecutionMs,
        executed_at_ms: outcome.executedAt,
      })

      // Update opportunity with realized PnL
      if (outcome.status === 'FILLED' || outcome.status === 'PARTIAL_FILL') {
        this.db.prepare(`
          UPDATE opportunities
          SET realized_pnl_usdt = @pnl, execution_status = @status
          WHERE id = @id
        `).run({ pnl: outcome.realizedPnlUsdt, status: outcome.status, id: outcome.opportunityId })
      }
    } catch (err: any) {
      console.error(`[exec] DB persist failed: ${err.message}`)
    }
  }
}
