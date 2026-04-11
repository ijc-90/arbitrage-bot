import { ExchangeClient } from './exchangeClient'

export interface TradeCheck {
  ok: boolean
  reason?: string  // set when ok = false
}

export class InventoryManager {
  // cache[exchange][asset] = free balance
  private cache = new Map<string, Record<string, number>>()
  private lastRefreshedAt = new Map<string, number>()
  private readonly REFRESH_INTERVAL_MS = 5 * 60 * 1000  // background refresh every 5min

  constructor(
    private client: ExchangeClient,
    private exchanges: string[],  // only exchanges with API keys configured
  ) {}

  // Fetch balances for all configured exchanges. Called on startup and periodically.
  async refreshAll(): Promise<void> {
    await Promise.allSettled(this.exchanges.map(ex => this.refresh(ex)))
  }

  async refresh(exchange: string): Promise<void> {
    try {
      const balances = await this.client.getBalances(exchange)
      this.cache.set(exchange, balances)
      this.lastRefreshedAt.set(exchange, Date.now())
      console.log(`[inventory:${exchange}] ${Object.entries(balances).map(([a, v]) => `${a}=${v.toFixed(4)}`).join(' ')}`)
    } catch (err: any) {
      console.error(`[inventory:${exchange}] refresh failed: ${err.message}`)
    }
  }

  // Pre-trade gate. Returns ok=true only if both sides have sufficient free balance.
  // buyExchange  pays USDT (or quote asset), sellExchange delivers baseAsset.
  canTrade(
    buyExchange: string,
    sellExchange: string,
    baseAsset: string,        // e.g. 'BTC' from 'BTCUSDT'
    capitalUsdt: number,
    currentAskPrice: number,  // used to convert base-asset balance to USDT
  ): TradeCheck {
    const buyBalances  = this.cache.get(buyExchange)
    const sellBalances = this.cache.get(sellExchange)

    if (!buyBalances) return { ok: false, reason: `no balance data for ${buyExchange}` }
    if (!sellBalances) return { ok: false, reason: `no balance data for ${sellExchange}` }

    const freeUsdt = buyBalances['USDT'] ?? 0
    if (freeUsdt < capitalUsdt) {
      return { ok: false, reason: `${buyExchange} USDT insufficient: have ${freeUsdt.toFixed(2)}, need ${capitalUsdt.toFixed(2)}` }
    }

    const freeBase = sellBalances[baseAsset] ?? 0
    const freeBaseUsdt = freeBase * currentAskPrice
    if (freeBaseUsdt < capitalUsdt) {
      return { ok: false, reason: `${sellExchange} ${baseAsset} insufficient: have ~$${freeBaseUsdt.toFixed(2)}, need ~$${capitalUsdt.toFixed(2)}` }
    }

    return { ok: true }
  }

  // Optimistically deduct expected capital from cache after a trade is accepted.
  // Prevents a second concurrent trade from seeing stale balances before refresh completes.
  deduct(
    buyExchange: string,
    sellExchange: string,
    baseAsset: string,
    capitalUsdt: number,
    currentAskPrice: number,
  ): void {
    const buyBalances = this.cache.get(buyExchange)
    if (buyBalances) buyBalances['USDT'] = Math.max(0, (buyBalances['USDT'] ?? 0) - capitalUsdt)

    const sellBalances = this.cache.get(sellExchange)
    if (sellBalances) {
      const baseQty = capitalUsdt / currentAskPrice
      sellBalances[baseAsset] = Math.max(0, (sellBalances[baseAsset] ?? 0) - baseQty)
    }
  }

  // Start background refresh loop. Schedules itself; does not block.
  startBackgroundRefresh(): void {
    setInterval(() => this.refreshAll(), this.REFRESH_INTERVAL_MS)
  }

  // Log a summary of cached balances (useful for startup diagnostics).
  logSummary(): void {
    if (this.cache.size === 0) {
      console.log('[inventory] no balances loaded — API keys not configured or refresh failed')
      return
    }
    for (const [ex, balances] of this.cache) {
      const age = this.lastRefreshedAt.get(ex)
      const ageStr = age ? `${Math.round((Date.now() - age) / 1000)}s ago` : 'never'
      const summary = Object.entries(balances).map(([a, v]) => `${a}=${v.toFixed(4)}`).join(' ')
      console.log(`[inventory:${ex}] (refreshed ${ageStr}) ${summary || 'empty'}`)
    }
  }
}
