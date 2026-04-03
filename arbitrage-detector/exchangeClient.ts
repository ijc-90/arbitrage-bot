import { Env } from './config'

export interface BookTick {
  symbol: string
  bidPrice: number
  askPrice: number
}

export class ExchangeClient {
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
