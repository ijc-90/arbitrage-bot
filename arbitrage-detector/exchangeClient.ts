import { Env } from './config'
import type { Db } from './db'

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

  async getPairTicks(
    symbolA: string, exchangeA: string,
    symbolB: string, exchangeB: string
  ): Promise<[BookTick, BookTick]> {
    return Promise.all([
      this.getBookTicker(exchangeA, symbolA),
      this.getBookTicker(exchangeB, symbolB),
    ])
  }
}
