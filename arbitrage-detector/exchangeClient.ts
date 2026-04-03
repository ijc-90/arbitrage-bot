import { Env } from './config'

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
  // Symbols that returned 100204 on individual lookup — excluded from future bulk results.
  private bingxBlacklist = new Set<string>()

  constructor(private env: Env) {}

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
      const data = await res.json() as { code: number; data: { symbol: string; bidPrice: string; askPrice: string } }
      if (data.code !== 0) {
        if (data.code === 100204) {
          this.bingxBlacklist.add(symbol)
          console.warn(`[bingx] blacklisted ${symbol} (100204 — not available for individual lookup)`)
        }
        throw new Error(`BingX error: ${data.code}`)
      }
      return {
        symbol,
        bidPrice: parseFloat(data.data.bidPrice),
        askPrice: parseFloat(data.data.askPrice),
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
      const res = await fetch(`${baseUrl}/openApi/spot/v1/ticker/bookTicker`)
      if (!res.ok) throw new Error(`BingX bulk fetch failed: ${res.status}`)
      const data = await res.json() as { code: number; data: Array<{ symbol: string; bidPrice: string; askPrice: string }> }
      if (data.code !== 0) throw new Error(`BingX error: ${data.code}`)
      // Build both maps together, then replace atomically so a mid-flight network failure
      // doesn't leave the symbol map empty while an opportunity poll is still running.
      const newSymbolMap = new Map<string, string>()
      const map = new Map<string, BookTick>()
      for (const item of data.data) {
        const sym = fromBingXSymbol(item.symbol)  // BTC-USDT → BTCUSDT
        if (this.bingxBlacklist.has(sym)) continue  // skip pairs that fail individual lookup
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
