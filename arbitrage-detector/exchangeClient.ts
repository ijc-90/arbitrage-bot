import * as crypto from 'crypto'
import { Env } from './config'
import type { Db } from './db'
import type { OrderResult, OrderSide, OrderStatus, OrderType } from './types'

function normalizeStatus(raw: string): OrderStatus {
  const s = raw.toUpperCase()
  if (s === 'FILLED') return 'FILLED'
  if (s === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED'
  if (s === 'CANCELED' || s === 'CANCELLED') return 'CANCELED'
  if (s === 'REJECTED' || s === 'FAILED') return 'REJECTED'
  return 'NEW'
}

export interface BookTick {
  symbol: string
  bidPrice: number
  askPrice: number
}

// BingX uses hyphenated symbols (BTC-USDT). Normalise to canonical form (BTCUSDT) on ingest.
// We keep a reverse lookup (canonical → BingX format) populated by getAllBookTickers so that
// getBookTicker can convert back reliably without guessing the quote boundary.
function fromBingXSymbol(symbol: string): string {
  return symbol.replace('-', '')  // BTC-USDT → BTCUSDT (first hyphen only; spot pairs have exactly one)
}

export class ExchangeClient {
  // When false, placeOrder throws immediately. Set via enableExecution() after checking config.
  private executionEnabled = false
  // When true, placeOrder logs [DRY-RUN] and returns a fake FILLED result — no real orders placed.
  private dryRunSandbox = false

  // Populated by getAllBookTickers('bingx'). Maps canonical symbol → original BingX symbol.
  private bingxSymbolMap = new Map<string, string>()
  // Symbols that returned 100204 on individual lookup — persisted to DB to survive restarts.
  private bingxBlacklist = new Set<string>()
  // Cached set of tradeable BingX symbols (BingX hyphenated format). Refreshed hourly.
  private bingxActiveSymbols: Set<string> | null = null
  private bingxActiveSymbolsFetchedAt = 0

  constructor(private env: Env, private db?: Db) {
    if (db) {
      // Load persisted blacklist on startup
      try {
        const rows = db.prepare(
          `SELECT symbol FROM exchange_symbol_blacklist WHERE exchange = 'bingx'`
        ).all() as Array<{ symbol: string }>
        for (const row of rows) this.bingxBlacklist.add(row.symbol)
        if (this.bingxBlacklist.size > 0) {
          console.log(`[bingx] loaded ${this.bingxBlacklist.size} blacklisted symbols from DB`)
        }
      } catch {}
    }
  }

  private async fetchActiveBingXSymbols(baseUrl: string): Promise<Set<string>> {
    const ONE_HOUR_MS = 60 * 60 * 1000
    if (this.bingxActiveSymbols && Date.now() - this.bingxActiveSymbolsFetchedAt < ONE_HOUR_MS) {
      return this.bingxActiveSymbols
    }
    const res = await fetch(`${baseUrl}/openApi/spot/v1/common/symbols`)
    if (!res.ok) throw new Error(`BingX symbols fetch failed: ${res.status}`)
    const data = await res.json() as {
      code: number
      data: { symbols: Array<{ symbol: string; status: number; apiStateBuy: boolean; apiStateSell: boolean }> }
    }
    if (data.code !== 0) throw new Error(`BingX symbols error: ${data.code}`)
    const active = new Set<string>()
    for (const s of data.data.symbols) {
      if (s.status === 1 && s.apiStateBuy && s.apiStateSell) active.add(s.symbol)
    }
    this.bingxActiveSymbols = active
    this.bingxActiveSymbolsFetchedAt = Date.now()
    console.log(`[bingx] ${active.size} active spot symbols (refreshed)`)
    return active
  }

  private persistBlacklist(symbol: string): void {
    if (!this.db) return
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO exchange_symbol_blacklist (exchange, symbol, reason, created_at_ms) VALUES ('bingx', ?, '100204', ?)`
      ).run(symbol, Date.now())
    } catch {}
  }

  async getBookTicker(exchange: string, symbol: string): Promise<BookTick> {
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const url = `${baseUrl}/api/v3/ticker/bookTicker?symbol=${symbol}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Binance fetch failed: ${res.status}`)
      const data = await res.json() as { symbol: string; bidPrice: string; askPrice: string }
      return {
        symbol: data.symbol,
        bidPrice: parseFloat(data.bidPrice),
        askPrice: parseFloat(data.askPrice),
      }
    }

    if (exchange === 'bybit') {
      const url = `${baseUrl}/v5/market/tickers?category=spot&symbol=${symbol}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Bybit fetch failed: ${res.status}`)
      const data = await res.json() as { result: { list: Array<{ symbol: string; bid1Price: string; ask1Price: string }> } }
      const item = data.result.list[0]
      return {
        symbol: item.symbol,
        bidPrice: parseFloat(item.bid1Price),
        askPrice: parseFloat(item.ask1Price),
      }
    }

    if (exchange === 'bingx') {
      const bingxSym = this.bingxSymbolMap.get(symbol)
      if (!bingxSym) throw new Error(`BingX symbol not in map: ${symbol}`)
      const url = `${baseUrl}/openApi/spot/v1/ticker/bookTicker?symbol=${bingxSym}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`BingX fetch failed: ${res.status}`)
      // Individual endpoint returns data as an array, not an object
      const data = await res.json() as { code: number; data: Array<{ symbol: string; bidPrice: string; askPrice: string }> }
      if (data.code !== 0) {
        if (data.code === 100204) {
          this.bingxBlacklist.add(symbol)
          this.persistBlacklist(symbol)
          console.warn(`[bingx] blacklisted ${symbol} (100204 — not available for individual lookup)`)
        }
        throw new Error(`BingX error: ${data.code}`)
      }
      const item = data.data[0]
      if (!item) throw new Error(`BingX empty response for ${bingxSym}`)
      return {
        symbol,
        bidPrice: parseFloat(item.bidPrice),
        askPrice: parseFloat(item.askPrice),
      }
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  async getAllBookTickers(exchange: string): Promise<Map<string, BookTick>> {
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const res = await fetch(`${baseUrl}/api/v3/ticker/bookTicker`)
      if (!res.ok) throw new Error(`Binance bulk fetch failed: ${res.status}`)
      const data = await res.json() as Array<{ symbol: string; bidPrice: string; askPrice: string }>
      const map = new Map<string, BookTick>()
      for (const item of data) {
        map.set(item.symbol, { symbol: item.symbol, bidPrice: parseFloat(item.bidPrice), askPrice: parseFloat(item.askPrice) })
      }
      return map
    }

    if (exchange === 'bybit') {
      const res = await fetch(`${baseUrl}/v5/market/tickers?category=spot`)
      if (!res.ok) throw new Error(`Bybit bulk fetch failed: ${res.status}`)
      const data = await res.json() as { result: { list: Array<{ symbol: string; bid1Price: string; ask1Price: string }> } }
      const map = new Map<string, BookTick>()
      for (const item of data.result.list) {
        map.set(item.symbol, { symbol: item.symbol, bidPrice: parseFloat(item.bid1Price), askPrice: parseFloat(item.ask1Price) })
      }
      return map
    }

    if (exchange === 'bingx') {
      // Fetch active symbols first (cached hourly) — filters out suspended/delisted pairs
      // that appear in the bulk ticker but fail individual queries with 100204.
      const activeSymbols = await this.fetchActiveBingXSymbols(baseUrl)

      const res = await fetch(`${baseUrl}/openApi/spot/v1/ticker/bookTicker`)
      if (!res.ok) throw new Error(`BingX bulk fetch failed: ${res.status}`)
      const data = await res.json() as { code: number; data: Array<{ symbol: string; bidPrice: string; askPrice: string }> }
      if (data.code !== 0) throw new Error(`BingX error: ${data.code}`)
      // Build both maps together, then replace atomically so a mid-flight network failure
      // doesn't leave the symbol map empty while an opportunity poll is still running.
      const newSymbolMap = new Map<string, string>()
      const map = new Map<string, BookTick>()
      for (const item of data.data) {
        if (!activeSymbols.has(item.symbol)) continue  // suspended or delisted — skip
        const sym = fromBingXSymbol(item.symbol)  // BTC-USDT → BTCUSDT
        if (this.bingxBlacklist.has(sym)) continue  // failsafe: already known bad
        newSymbolMap.set(sym, item.symbol)
        map.set(sym, { symbol: sym, bidPrice: parseFloat(item.bidPrice), askPrice: parseFloat(item.askPrice) })
      }
      this.bingxSymbolMap = newSymbolMap  // atomic swap; old map preserved on error path
      return map
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  // Returns free balances as { ASSET: freeAmount } for the given exchange.
  // Requires API key + secret in env.apiKeys[exchange]. Throws if not configured.
  async getBalances(exchange: string): Promise<Record<string, number>> {
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key configured for ${exchange}`)
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const ts = Date.now()
      const qs = `timestamp=${ts}`
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/api/v3/account?${qs}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': creds.key },
      })
      if (!res.ok) throw new Error(`Binance account fetch failed: ${res.status}`)
      const data = await res.json() as { balances: Array<{ asset: string; free: string }> }
      const out: Record<string, number> = {}
      for (const b of data.balances) {
        const free = parseFloat(b.free)
        if (free > 0) out[b.asset] = free
      }
      return out
    }

    if (exchange === 'bybit') {
      const ts = Date.now()
      const recvWindow = 5000
      const params = `accountType=UNIFIED`
      const toSign = `${ts}${creds.key}${recvWindow}${params}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/account/wallet-balance?${params}`, {
        headers: {
          'X-BAPI-API-KEY': creds.key,
          'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts),
          'X-BAPI-RECV-WINDOW': String(recvWindow),
        },
      })
      if (!res.ok) throw new Error(`Bybit account fetch failed: ${res.status}`)
      const data = await res.json() as {
        result: { list: Array<{ coin: Array<{ coin: string; availableToWithdraw: string }> }> }
      }
      const out: Record<string, number> = {}
      for (const wallet of data.result.list) {
        for (const c of wallet.coin) {
          const free = parseFloat(c.availableToWithdraw)
          if (free > 0) out[c.coin] = free
        }
      }
      return out
    }

    if (exchange === 'bingx') {
      const ts = Date.now()
      const qs = `timestamp=${ts}`
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/openApi/spot/v1/account/balance?${qs}&signature=${sig}`, {
        headers: { 'X-BX-APIKEY': creds.key },
      })
      if (!res.ok) throw new Error(`BingX account fetch failed: ${res.status}`)
      const data = await res.json() as {
        code: number
        data: { balances: Array<{ asset: string; free: string }> }
      }
      if (data.code !== 0) throw new Error(`BingX account error: ${data.code}`)
      const out: Record<string, number> = {}
      for (const b of data.data.balances) {
        const free = parseFloat(b.free)
        if (free > 0) out[b.asset] = free
      }
      return out
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  async getPairTicks(
    symbolA: string, exchangeA: string,
    symbolB: string, exchangeB: string
  ): Promise<[BookTick, BookTick]> {
    return Promise.all([
      this.getBookTicker(exchangeA, symbolA),
      this.getBookTicker(exchangeB, symbolB),
    ])
  }

  // Fetch top-N order book levels for a symbol on an exchange.
  // Returns { bids: [[price, qty], ...], asks: [[price, qty], ...] } sorted best-first.
  async fetchOrderBook(
    exchange: string,
    symbol: string,
    depth: number = 10,
  ): Promise<{ bids: Array<[string, string]>; asks: Array<[string, string]> }> {
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const res = await fetch(`${baseUrl}/api/v3/depth?symbol=${symbol}&limit=${depth}`)
      if (!res.ok) throw new Error(`Binance fetchOrderBook failed: ${res.status}`)
      const data = await res.json() as { bids: Array<[string, string]>; asks: Array<[string, string]> }
      return data
    }

    if (exchange === 'bybit') {
      const res = await fetch(`${baseUrl}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${depth}`)
      if (!res.ok) throw new Error(`Bybit fetchOrderBook failed: ${res.status}`)
      const data = await res.json() as { result: { b: Array<[string, string]>; a: Array<[string, string]> } }
      return { bids: data.result.b, asks: data.result.a }
    }

    if (exchange === 'bingx') {
      const bingxSym = this.toBingXSymbol(symbol)
      const res = await fetch(`${baseUrl}/openApi/spot/v1/market/depth?symbol=${bingxSym}&limit=${depth}`)
      if (!res.ok) throw new Error(`BingX fetchOrderBook failed: ${res.status}`)
      const data = await res.json() as { code: number; data: { bids: Array<[string, string]>; asks: Array<[string, string]> } }
      if (data.code !== 0) throw new Error(`BingX fetchOrderBook error: ${data.code}`)
      return data.data
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  // Query all open orders on an exchange (for startup recovery).
  // Returns only orders whose clientOrderId starts with 'arb-'.
  async getOpenOrders(exchange: string, symbol?: string): Promise<Array<{ orderId: string; clientOrderId: string; symbol: string; createdAt: number; status: string }>> {
    const creds = this.env.apiKeys[exchange]
    if (!creds) return []
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) return []

    if (exchange === 'binance') {
      const ts = Date.now()
      const qs = this.buildQueryString({ ...(symbol ? { symbol } : {}), timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/api/v3/openOrders?${qs}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': creds.key },
      })
      if (!res.ok) return []
      const data = await res.json() as Array<{ orderId: number; clientOrderId: string; symbol: string; time: number; status: string }>
      return data
        .filter(o => o.clientOrderId?.startsWith('arb-'))
        .map(o => ({ orderId: String(o.orderId), clientOrderId: o.clientOrderId, symbol: o.symbol, createdAt: o.time, status: o.status }))
    }

    if (exchange === 'bybit') {
      const ts = Date.now()
      const recvWindow = 5000
      const params = `category=spot${symbol ? `&symbol=${symbol}` : ''}&openOnly=1`
      const toSign = `${ts}${creds.key}${recvWindow}${params}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/order/realtime?${params}`, {
        headers: {
          'X-BAPI-API-KEY': creds.key, 'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-RECV-WINDOW': String(recvWindow),
        },
      })
      if (!res.ok) return []
      const data = await res.json() as { retCode: number; result: { list: Array<{ orderId: string; orderLinkId: string; symbol: string; createdTime: string; orderStatus: string }> } }
      if (data.retCode !== 0) return []
      return data.result.list
        .filter(o => o.orderLinkId?.startsWith('arb-'))
        .map(o => ({ orderId: o.orderId, clientOrderId: o.orderLinkId, symbol: o.symbol, createdAt: parseInt(o.createdTime), status: o.orderStatus }))
    }

    return []  // BingX open-orders endpoint varies; add when needed
  }

  // Call this in detector.ts when config.execution_enabled === true.
  // Orders cannot be placed until this is called — safety guard against accidental execution.
  enableExecution(dryRunSandbox = false): void {
    this.executionEnabled = true
    this.dryRunSandbox = dryRunSandbox
    if (dryRunSandbox) {
      console.log('[execution] order placement ENABLED — DRY-RUN mode (no real orders will be placed)')
    } else {
      console.log('[execution] order placement ENABLED — LIVE mode')
    }
  }

  private generateClientOrderId(): string {
    return `arb-${crypto.randomUUID()}`
  }

  private buildQueryString(params: Record<string, string | number>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
  }

  // Converts canonical symbol (BTCUSDT) to BingX format (BTC-USDT).
  // Uses the symbol map populated by getAllBookTickers; falls back to naive insertion
  // before the last 4 chars (works for USDT pairs, the only ones we trade).
  private toBingXSymbol(symbol: string): string {
    return this.bingxSymbolMap.get(symbol) ?? `${symbol.slice(0, -4)}-${symbol.slice(-4)}`
  }

  async placeOrder(
    exchange: string,
    symbol: string,
    side: OrderSide,
    type: OrderType,
    qty: number,
    price?: number,
  ): Promise<OrderResult> {
    if (!this.executionEnabled) {
      throw new Error('execution_enabled is false — set execution_enabled: true in config to place orders')
    }

    if (this.dryRunSandbox) {
      const fakeId = this.generateClientOrderId()
      console.log(`[DRY-RUN] placeOrder ${exchange} ${symbol} ${side} ${type} qty=${qty}${price ? ` price=${price}` : ''}`)
      return {
        orderId: `dry-${fakeId}`,
        clientOrderId: fakeId,
        status: 'FILLED',
        filledQty: qty,
        avgFillPrice: price ?? 0,
        feeUsdt: qty * (price ?? 0) * 0.001,
        timestamp: Date.now(),
      }
    }

    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key configured for ${exchange}`)
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)
    const clientOrderId = this.generateClientOrderId()

    if (exchange === 'binance') {
      const ts = Date.now()
      const params: Record<string, string | number> = {
        symbol,
        side,
        type: type === 'MARKET' ? 'MARKET' : 'LIMIT',
        quantity: qty,
        newClientOrderId: clientOrderId,
        newOrderRespType: 'FULL',
        timestamp: ts,
      }
      if (type === 'LIMIT_IOC') {
        params.timeInForce = 'IOC'
        if (price == null) throw new Error('price required for LIMIT_IOC')
        params.price = price
      }
      const qs = this.buildQueryString(params)
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/api/v3/order`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': creds.key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `${qs}&signature=${sig}`,
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Binance placeOrder failed: ${res.status} ${err}`)
      }
      const data = await res.json() as {
        orderId: number
        clientOrderId: string
        status: string
        executedQty: string
        cummulativeQuoteQty: string
        fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>
      }
      const filledQty = parseFloat(data.executedQty)
      const filledQuote = parseFloat(data.cummulativeQuoteQty)
      const avgFillPrice = filledQty > 0 ? filledQuote / filledQty : 0
      let feeUsdt = 0
      for (const f of data.fills ?? []) {
        const commission = parseFloat(f.commission)
        // Non-USDT fee (e.g. BNB discount): approximate via fill price
        feeUsdt += f.commissionAsset === 'USDT' ? commission : commission * parseFloat(f.price)
      }
      return {
        orderId: String(data.orderId),
        clientOrderId: data.clientOrderId,
        status: normalizeStatus(data.status),
        filledQty,
        avgFillPrice,
        feeUsdt,
        timestamp: Date.now(),
      }
    }

    if (exchange === 'bybit') {
      const ts = Date.now()
      const recvWindow = 5000
      const body: Record<string, string> = {
        category: 'spot',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: type === 'MARKET' ? 'Market' : 'Limit',
        qty: String(qty),
        orderLinkId: clientOrderId,
      }
      if (type === 'LIMIT_IOC') {
        body.timeInForce = 'IOC'
        if (price == null) throw new Error('price required for LIMIT_IOC')
        body.price = String(price)
      }
      const bodyStr = JSON.stringify(body)
      const toSign = `${ts}${creds.key}${recvWindow}${bodyStr}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/order/create`, {
        method: 'POST',
        headers: {
          'X-BAPI-API-KEY': creds.key,
          'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts),
          'X-BAPI-RECV-WINDOW': String(recvWindow),
          'Content-Type': 'application/json',
        },
        body: bodyStr,
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Bybit placeOrder failed: ${res.status} ${err}`)
      }
      const data = await res.json() as {
        retCode: number; retMsg: string
        result: { orderId: string; orderLinkId: string }
      }
      if (data.retCode !== 0) throw new Error(`Bybit placeOrder error: ${data.retCode} ${data.retMsg}`)
      // Bybit does not return fill details on placement — caller must poll getOrderStatus
      return {
        orderId: data.result.orderId,
        clientOrderId: data.result.orderLinkId,
        status: 'NEW',
        filledQty: 0,
        avgFillPrice: 0,
        feeUsdt: 0,
        timestamp: Date.now(),
      }
    }

    if (exchange === 'bingx') {
      // NOTE: BingX V1 uses HMAC-SHA256 (same as balance queries). If migrating to V3 API,
      // verify whether Ed25519 signing is required before going live.
      const ts = Date.now()
      const params: Record<string, string | number> = {
        symbol: this.toBingXSymbol(symbol),
        side,
        type: type === 'MARKET' ? 'MARKET' : 'LIMIT',
        quantity: qty,
        clientOrderID: clientOrderId,
        timestamp: ts,
      }
      if (type === 'LIMIT_IOC') {
        params.timeInForce = 'IOC'
        if (price == null) throw new Error('price required for LIMIT_IOC')
        params.price = price
      }
      const qs = this.buildQueryString(params)
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/openApi/spot/v1/trade/order?${qs}&signature=${sig}`, {
        method: 'POST',
        headers: { 'X-BX-APIKEY': creds.key },
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`BingX placeOrder failed: ${res.status} ${err}`)
      }
      const data = await res.json() as {
        code: number; msg: string
        data: { orderId: string; clientOrderID: string; status: string; executedQty: string; avgPrice: string; fee: string }
      }
      if (data.code !== 0) throw new Error(`BingX placeOrder error: ${data.code} ${data.msg}`)
      return {
        orderId: data.data.orderId,
        clientOrderId: data.data.clientOrderID,
        status: normalizeStatus(data.data.status ?? 'NEW'),
        filledQty: parseFloat(data.data.executedQty ?? '0'),
        avgFillPrice: parseFloat(data.data.avgPrice ?? '0'),
        feeUsdt: parseFloat(data.data.fee ?? '0'),
        timestamp: Date.now(),
      }
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  async cancelOrder(exchange: string, symbol: string, orderId: string): Promise<void> {
    if (!this.executionEnabled) throw new Error('execution_enabled is false')
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key configured for ${exchange}`)
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const ts = Date.now()
      const qs = this.buildQueryString({ symbol, orderId, timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/api/v3/order?${qs}&signature=${sig}`, {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': creds.key },
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Binance cancelOrder failed: ${res.status} ${err}`)
      }
      return
    }

    if (exchange === 'bybit') {
      const ts = Date.now()
      const recvWindow = 5000
      const body = JSON.stringify({ category: 'spot', symbol, orderId })
      const toSign = `${ts}${creds.key}${recvWindow}${body}`
      const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
      const res = await fetch(`${baseUrl}/v5/order/cancel`, {
        method: 'POST',
        headers: {
          'X-BAPI-API-KEY': creds.key,
          'X-BAPI-SIGN': sig,
          'X-BAPI-TIMESTAMP': String(ts),
          'X-BAPI-RECV-WINDOW': String(recvWindow),
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Bybit cancelOrder failed: ${res.status} ${err}`)
      }
      const data = await res.json() as { retCode: number; retMsg: string }
      if (data.retCode !== 0) throw new Error(`Bybit cancelOrder error: ${data.retCode} ${data.retMsg}`)
      return
    }

    if (exchange === 'bingx') {
      const ts = Date.now()
      const qs = this.buildQueryString({ symbol: this.toBingXSymbol(symbol), orderId, timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/openApi/spot/v1/trade/cancel?${qs}&signature=${sig}`, {
        method: 'DELETE',
        headers: { 'X-BX-APIKEY': creds.key },
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`BingX cancelOrder failed: ${res.status} ${err}`)
      }
      const data = await res.json() as { code: number; msg: string }
      if (data.code !== 0) throw new Error(`BingX cancelOrder error: ${data.code} ${data.msg}`)
      return
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }

  async getOrderStatus(exchange: string, symbol: string, orderId: string): Promise<OrderResult> {
    const creds = this.env.apiKeys[exchange]
    if (!creds) throw new Error(`No API key configured for ${exchange}`)
    const baseUrl = this.env.exchangeUrls[exchange]
    if (!baseUrl) throw new Error(`No URL configured for exchange: ${exchange}`)

    if (exchange === 'binance') {
      const ts = Date.now()
      const qs = this.buildQueryString({ symbol, orderId, timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/api/v3/order?${qs}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': creds.key },
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`Binance getOrderStatus failed: ${res.status} ${err}`)
      }
      const data = await res.json() as {
        orderId: number; clientOrderId: string; status: string
        executedQty: string; cummulativeQuoteQty: string
      }
      const filledQty = parseFloat(data.executedQty)
      const filledQuote = parseFloat(data.cummulativeQuoteQty)
      return {
        orderId: String(data.orderId),
        clientOrderId: data.clientOrderId,
        status: normalizeStatus(data.status),
        filledQty,
        avgFillPrice: filledQty > 0 ? filledQuote / filledQty : 0,
        feeUsdt: 0,  // not returned by status endpoint; use fills from placeOrder response
        timestamp: Date.now(),
      }
    }

    if (exchange === 'bybit') {
      const ts = Date.now()
      const recvWindow = 5000

      const queryBybit = async (endpoint: string): Promise<OrderResult | null> => {
        const params = `category=spot&symbol=${symbol}&orderId=${orderId}`
        const toSign = `${ts}${creds.key}${recvWindow}${params}`
        const sig = crypto.createHmac('sha256', creds.secret).update(toSign).digest('hex')
        const res = await fetch(`${baseUrl}${endpoint}?${params}`, {
          headers: {
            'X-BAPI-API-KEY': creds.key,
            'X-BAPI-SIGN': sig,
            'X-BAPI-TIMESTAMP': String(ts),
            'X-BAPI-RECV-WINDOW': String(recvWindow),
          },
        })
        if (!res.ok) return null
        const data = await res.json() as {
          retCode: number
          result: { list: Array<{
            orderId: string; orderLinkId: string; orderStatus: string
            cumExecQty: string; cumExecValue: string; cumExecFee: string; avgPrice: string
          }> }
        }
        if (data.retCode !== 0 || data.result.list.length === 0) return null
        const o = data.result.list[0]
        const filledQty = parseFloat(o.cumExecQty)
        const avgFillPrice = parseFloat(o.avgPrice) ||
          (filledQty > 0 ? parseFloat(o.cumExecValue) / filledQty : 0)
        return {
          orderId: o.orderId,
          clientOrderId: o.orderLinkId,
          status: normalizeStatus(o.orderStatus),
          filledQty,
          avgFillPrice,
          feeUsdt: parseFloat(o.cumExecFee),
          timestamp: Date.now(),
        }
      }

      // Active orders first; fall back to history for filled/cancelled orders
      const result = await queryBybit('/v5/order/realtime') ?? await queryBybit('/v5/order/history')
      if (!result) throw new Error(`Bybit getOrderStatus: order ${orderId} not found`)
      return result
    }

    if (exchange === 'bingx') {
      const ts = Date.now()
      const qs = this.buildQueryString({ orderId, symbol: this.toBingXSymbol(symbol), timestamp: ts })
      const sig = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex')
      const res = await fetch(`${baseUrl}/openApi/spot/v1/trade/query?${qs}&signature=${sig}`, {
        headers: { 'X-BX-APIKEY': creds.key },
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`BingX getOrderStatus failed: ${res.status} ${err}`)
      }
      const data = await res.json() as {
        code: number; msg: string
        data: { orderId: string; clientOrderID: string; status: string; executedQty: string; avgPrice: string; fee: string }
      }
      if (data.code !== 0) throw new Error(`BingX getOrderStatus error: ${data.code} ${data.msg}`)
      return {
        orderId: data.data.orderId,
        clientOrderId: data.data.clientOrderID,
        status: normalizeStatus(data.data.status),
        filledQty: parseFloat(data.data.executedQty ?? '0'),
        avgFillPrice: parseFloat(data.data.avgPrice ?? '0'),
        feeUsdt: parseFloat(data.data.fee ?? '0'),
        timestamp: Date.now(),
      }
    }

    throw new Error(`Unsupported exchange: ${exchange}`)
  }
}
