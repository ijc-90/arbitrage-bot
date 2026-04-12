import * as crypto from 'crypto'
import { Env } from './config'
import type { OrderResult, OrderStatus } from './types'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FundingRate {
  exchange: string
  symbol: string
  fundingRatePct: number       // e.g. 0.05 = 0.05%/8h
  markPrice: number
  nextFundingTimeMs: number | null
}

export interface PerpPosition {
  symbol: string
  side: 'LONG' | 'SHORT' | 'NONE'
  qty: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number
  unrealizedPnl: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildQueryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

function normalizeOrderStatus(raw: string): OrderStatus {
  const s = raw.toUpperCase()
  if (s === 'FILLED') return 'FILLED'
  if (s === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED'
  if (s === 'CANCELED' || s === 'CANCELLED') return 'CANCELED'
  if (s === 'REJECTED' || s === 'FAILED') return 'REJECTED'
  return 'NEW'
}

// ── PerpClient ────────────────────────────────────────────────────────────────

export class PerpClient {
  private executionEnabled = false
  private dryRun = false

  constructor(private env: Env) {}

  enableExecution(dryRun = false): void {
    this.executionEnabled = true
    this.dryRun = dryRun
    console.log(`[perp] execution ENABLED — ${dryRun ? 'DRY-RUN mode' : 'LIVE mode'}`)
  }

  // ── Funding rate queries ───────────────────────────────────────────────────

  // Fetch funding rates for all listed USDT-M perps on an exchange (single API call).
  async getAllFundingRates(exchange: string): Promise<FundingRate[]> {
    if (exchange === 'binance') return this.binanceAllFundingRates()
    if (exchange === 'bybit')   return this.bybitAllFundingRates()
    if (exchange === 'bingx')   return this.bingxAllFundingRates()
    throw new Error(`getAllFundingRates: unsupported exchange ${exchange}`)
  }

  private async binanceAllFundingRates(): Promise<FundingRate[]> {
    const baseUrl = this.perpBaseUrl('binance')
    const res = await fetch(`${baseUrl}/fapi/v1/premiumIndex`)
    if (!res.ok) throw new Error(`Binance premiumIndex failed: ${res.status}`)
    const data = await res.json() as Array<{
      symbol: string; lastFundingRate: string; markPrice: string; nextFundingTime: number
    }>
    return data
      .filter(d => d.symbol.endsWith('USDT'))
      .map(d => ({
        exchange: 'binance',
        symbol: d.symbol,
        fundingRatePct: parseFloat(d.lastFundingRate) * 100,
        markPrice: parseFloat(d.markPrice),
        nextFundingTimeMs: d.nextFundingTime,
      }))
  }

  private async bybitAllFundingRates(): Promise<FundingRate[]> {
    const baseUrl = this.perpBaseUrl('bybit')
    const res = await fetch(`${baseUrl}/v5/market/tickers?category=linear`)
    if (!res.ok) throw new Error(`Bybit linear tickers failed: ${res.status}`)
    const data = await res.json() as { result: { list: Array<{
      symbol: string; fundingRate: string; markPrice: string; nextFundingTime: string
    }> } }
    return (data.result?.list ?? [])
      .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
      .map(d => ({
        exchange: 'bybit',
        symbol: d.symbol,
        fundingRatePct: parseFloat(d.fundingRate) * 100,
        markPrice: parseFloat(d.markPrice),
        nextFundingTimeMs: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
      }))
  }

  private async bingxAllFundingRates(): Promise<FundingRate[]> {
    const baseUrl = this.perpBaseUrl('bingx')
    const res = await fetch(`${baseUrl}/openApi/swap/v2/quote/premiumIndex`)
    if (!res.ok) throw new Error(`BingX premiumIndex failed: ${res.status}`)
    const data = await res.json() as { data: Array<{
      symbol: string; lastFundingRate: string; markPrice: string; nextFundingTime: number
    }> }
    return (data.data ?? [])
      .filter(d => d.symbol.endsWith('-USDT'))
      .map(d => ({
        exchange: 'bingx',
        symbol: d.symbol.replace('-', ''),  // BTC-USDT → BTCUSDT
        fundingRatePct: parseFloat(d.lastFundingRate) * 100,
        markPrice: parseFloat(d.markPrice),
        nextFundingTimeMs: d.nextFundingTime ?? null,
      }))
  }

  // ── Position queries ───────────────────────────────────────────────────────

  async getPerpPosition(exchange: string, symbol: string): Promise<PerpPosition | null> {
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key for ${exchange}`)

    if (exchange === 'binance') return this.binancePerpPosition(symbol, creds)
    if (exchange === 'bybit')   return this.bybitPerpPosition(symbol, creds)
    throw new Error(`getPerpPosition: unsupported exchange ${exchange}`)
  }

  private async binancePerpPosition(symbol: string, creds: { key: string; secret: string }): Promise<PerpPosition | null> {
    const baseUrl = this.perpBaseUrl('binance')
    const ts = Date.now()
    const qs = buildQueryString({ symbol, timestamp: ts })
    const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
    const res = await fetch(`${baseUrl}/fapi/v2/positionRisk?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': creds.key },
    })
    if (!res.ok) throw new Error(`Binance positionRisk failed: ${res.status}`)
    const data = await res.json() as Array<{
      symbol: string; positionAmt: string; entryPrice: string; markPrice: string
      liquidationPrice: string; unRealizedProfit: string; positionSide: string
    }>
    const pos = data.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0)
    if (!pos) return null
    const qty = parseFloat(pos.positionAmt)
    return {
      symbol,
      side: qty > 0 ? 'LONG' : 'SHORT',
      qty: Math.abs(qty),
      entryPrice: parseFloat(pos.entryPrice),
      markPrice: parseFloat(pos.markPrice),
      liquidationPrice: parseFloat(pos.liquidationPrice),
      unrealizedPnl: parseFloat(pos.unRealizedProfit),
    }
  }

  private async bybitPerpPosition(symbol: string, creds: { key: string; secret: string }): Promise<PerpPosition | null> {
    const baseUrl = this.perpBaseUrl('bybit')
    const ts = Date.now()
    const recvWindow = 5000
    const params = `category=linear&symbol=${symbol}`
    const toSign = `${ts}${creds.key}${recvWindow}${params}`
    const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
    const res = await fetch(`${baseUrl}/v5/position/list?${params}`, {
      headers: {
        'X-BAPI-API-KEY': creds.key,
        'X-BAPI-SIGN': sig,
        'X-BAPI-TIMESTAMP': String(ts),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
      },
    })
    if (!res.ok) throw new Error(`Bybit position/list failed: ${res.status}`)
    const data = await res.json() as { result: { list: Array<{
      symbol: string; side: string; size: string; avgPrice: string
      markPrice: string; liqPrice: string; unrealisedPnl: string
    }> } }
    const pos = (data.result?.list ?? []).find(p => parseFloat(p.size) > 0)
    if (!pos) return null
    return {
      symbol,
      side: pos.side.toUpperCase() as 'LONG' | 'SHORT',
      qty: parseFloat(pos.size),
      entryPrice: parseFloat(pos.avgPrice),
      markPrice: parseFloat(pos.markPrice),
      liquidationPrice: parseFloat(pos.liqPrice),
      unrealizedPnl: parseFloat(pos.unrealisedPnl),
    }
  }

  // ── Leverage setting ───────────────────────────────────────────────────────

  async setLeverage(exchange: string, symbol: string, leverage: number): Promise<void> {
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key for ${exchange}`)

    if (this.dryRun) {
      console.log(`[FUNDING-DRY-RUN] setLeverage ${exchange} ${symbol} ${leverage}x`)
      return
    }

    if (exchange === 'binance') {
      const baseUrl = this.perpBaseUrl('binance')
      const ts = Date.now()
      const body = buildQueryString({ symbol, leverage, timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(body).digest('hex')
      const res = await fetch(`${baseUrl}/fapi/v1/leverage`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': creds.key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `${body}&signature=${sig}`,
      })
      if (!res.ok) {
        const err = await res.text()
        // Code -4046: leverage already set to that value — ignore
        if (!err.includes('-4046')) throw new Error(`Binance setLeverage failed: ${res.status} ${err}`)
      }
      return
    }

    if (exchange === 'bybit') {
      const baseUrl = this.perpBaseUrl('bybit')
      const ts = Date.now()
      const recvWindow = 5000
      const body = JSON.stringify({ category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) })
      const toSign = `${ts}${creds.key}${recvWindow}${body}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/position/set-leverage`, {
        method: 'POST',
        headers: {
          'X-BAPI-API-KEY': creds.key, 'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-RECV-WINDOW': String(recvWindow),
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!res.ok) throw new Error(`Bybit setLeverage failed: ${res.status}`)
      const data = await res.json() as { retCode: number; retMsg: string }
      // retCode 110043: leverage not modified (already set) — ignore
      if (data.retCode !== 0 && data.retCode !== 110043) {
        throw new Error(`Bybit setLeverage error: ${data.retCode} ${data.retMsg}`)
      }
      return
    }

    throw new Error(`setLeverage: unsupported exchange ${exchange}`)
  }

  // ── Order placement ────────────────────────────────────────────────────────

  async placePerpOrder(
    exchange: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    reduceOnly = false,
  ): Promise<OrderResult> {
    if (!this.executionEnabled) {
      throw new Error('execution_enabled is false — set execution_enabled: true to place perp orders')
    }

    if (this.dryRun) {
      const id = `dry-${Math.random().toString(36).slice(2, 10)}`
      console.log(`[FUNDING-DRY-RUN] placePerpOrder ${exchange} ${symbol} ${side} qty=${qty}${reduceOnly ? ' reduceOnly' : ''}`)
      return {
        orderId: id, clientOrderId: id, status: 'FILLED',
        filledQty: qty, avgFillPrice: 0, feeUsdt: qty * 0.001, timestamp: Date.now(),
      }
    }

    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key for ${exchange}`)

    if (exchange === 'binance') return this.binancePerpOrder(symbol, side, qty, reduceOnly, creds)
    if (exchange === 'bybit')   return this.bybitPerpOrder(symbol, side, qty, reduceOnly, creds)
    throw new Error(`placePerpOrder: unsupported exchange ${exchange}`)
  }

  private async binancePerpOrder(
    symbol: string, side: 'BUY' | 'SELL', qty: number, reduceOnly: boolean,
    creds: { key: string; secret: string },
  ): Promise<OrderResult> {
    const baseUrl = this.perpBaseUrl('binance')
    const ts = Date.now()
    const clientOrderId = `arb-${crypto.randomUUID()}`
    const params: Record<string, string | number> = {
      symbol, side, type: 'MARKET', quantity: qty,
      newClientOrderId: clientOrderId,
      timestamp: ts,
    }
    if (reduceOnly) params.reduceOnly = 'true'
    const body = buildQueryString(params)
    const sig = crypto.createHmac('sha256', creds.secret).update(body).digest('hex')
    const res = await fetch(`${baseUrl}/fapi/v1/order`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': creds.key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${body}&signature=${sig}`,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Binance perp order failed: ${res.status} ${err}`)
    }
    const d = await res.json() as {
      orderId: number; clientOrderId: string; status: string
      executedQty: string; avgPrice: string; cumQuote: string
    }
    const filledQty = parseFloat(d.executedQty)
    const avgFillPrice = parseFloat(d.avgPrice)
    const feeUsdt = parseFloat(d.cumQuote) * 0.0005  // 0.05% taker approx
    return {
      orderId: String(d.orderId), clientOrderId: d.clientOrderId,
      status: normalizeOrderStatus(d.status),
      filledQty, avgFillPrice, feeUsdt, timestamp: Date.now(),
    }
  }

  private async bybitPerpOrder(
    symbol: string, side: 'BUY' | 'SELL', qty: number, reduceOnly: boolean,
    creds: { key: string; secret: string },
  ): Promise<OrderResult> {
    const baseUrl = this.perpBaseUrl('bybit')
    const ts = Date.now()
    const recvWindow = 5000
    const clientOrderId = `arb-${crypto.randomUUID()}`
    const payload: Record<string, unknown> = {
      category: 'linear', symbol, side, orderType: 'Market',
      qty: String(qty), orderLinkId: clientOrderId,
    }
    if (reduceOnly) payload.reduceOnly = true
    const body = JSON.stringify(payload)
    const toSign = `${ts}${creds.key}${recvWindow}${body}`
    const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
    const res = await fetch(`${baseUrl}/v5/order/create`, {
      method: 'POST',
      headers: {
        'X-BAPI-API-KEY': creds.key, 'X-BAPI-SIGN': sig,
        'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-RECV-WINDOW': String(recvWindow),
        'Content-Type': 'application/json',
      },
      body,
    })
    if (!res.ok) throw new Error(`Bybit perp order failed: ${res.status}`)
    const d = await res.json() as { retCode: number; retMsg: string; result: { orderId: string; orderLinkId: string } }
    if (d.retCode !== 0) throw new Error(`Bybit perp order error: ${d.retCode} ${d.retMsg}`)
    // Bybit returns NEW — caller polls getOrderStatus if fill details needed
    return {
      orderId: d.result.orderId, clientOrderId: d.result.orderLinkId,
      status: 'NEW', filledQty: 0, avgFillPrice: 0, feeUsdt: 0, timestamp: Date.now(),
    }
  }

  async cancelPerpOrder(exchange: string, symbol: string, orderId: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[FUNDING-DRY-RUN] cancelPerpOrder ${exchange} ${symbol} ${orderId}`)
      return
    }
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key for ${exchange}`)

    if (exchange === 'binance') {
      const baseUrl = this.perpBaseUrl('binance')
      const ts = Date.now()
      const qs = buildQueryString({ symbol, orderId, timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/fapi/v1/order?${qs}&signature=${sig}`, {
        method: 'DELETE', headers: { 'X-MBX-APIKEY': creds.key },
      })
      if (!res.ok) throw new Error(`Binance cancelPerpOrder failed: ${res.status}`)
      return
    }

    if (exchange === 'bybit') {
      const baseUrl = this.perpBaseUrl('bybit')
      const ts = Date.now()
      const recvWindow = 5000
      const body = JSON.stringify({ category: 'linear', symbol, orderId })
      const toSign = `${ts}${creds.key}${recvWindow}${body}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/order/cancel`, {
        method: 'POST',
        headers: {
          'X-BAPI-API-KEY': creds.key, 'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-RECV-WINDOW': String(recvWindow),
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!res.ok) throw new Error(`Bybit cancelPerpOrder failed: ${res.status}`)
      const d = await res.json() as { retCode: number; retMsg: string }
      if (d.retCode !== 0) throw new Error(`Bybit cancelPerpOrder error: ${d.retCode} ${d.retMsg}`)
      return
    }

    throw new Error(`cancelPerpOrder: unsupported exchange ${exchange}`)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Resolve perp base URL. Binance uses fapi subdomain; Bybit/BingX use same base as spot.
  // Allow override via BINANCE_FUTURES_URL env var for testnet.
  private perpBaseUrl(exchange: string): string {
    if (exchange === 'binance') {
      return process.env.BINANCE_FUTURES_URL
        ?? this.env.exchangeUrls['binance']?.replace('api.binance.com', 'fapi.binance.com')
        ?? 'https://fapi.binance.com'
    }
    const base = this.env.exchangeUrls[exchange]
    if (!base) throw new Error(`No URL configured for exchange: ${exchange}`)
    return base
  }

  // Spot ask price for qty calculation — uses public REST endpoint, no auth needed.
  async getSpotAskPrice(exchange: string, symbol: string): Promise<number> {
    const spotBaseUrl = this.env.exchangeUrls[exchange]
    if (!spotBaseUrl) throw new Error(`No spot URL for ${exchange}`)

    if (exchange === 'binance') {
      const res = await fetch(`${spotBaseUrl}/api/v3/ticker/bookTicker?symbol=${symbol}`)
      if (!res.ok) throw new Error(`Binance bookTicker failed: ${res.status}`)
      const d = await res.json() as { askPrice: string }
      return parseFloat(d.askPrice)
    }

    if (exchange === 'bybit') {
      const res = await fetch(`${spotBaseUrl}/v5/market/tickers?category=spot&symbol=${symbol}`)
      if (!res.ok) throw new Error(`Bybit spot ticker failed: ${res.status}`)
      const d = await res.json() as { result: { list: Array<{ ask1Price: string }> } }
      return parseFloat(d.result?.list?.[0]?.ask1Price ?? '0')
    }

    throw new Error(`getSpotAskPrice: unsupported exchange ${exchange}`)
  }
}
