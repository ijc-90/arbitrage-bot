import WebSocket from 'ws'
import { BookTick } from './exchangeClient'

export interface LiveTick extends BookTick {
  lastUpdatedAt: number
}

const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30000
const BINANCE_STREAM_LIMIT = 1024  // max streams per combined-stream connection
const BYBIT_PING_INTERVAL_MS = 20000

export class WsFeedManager {
  private ticks = new Map<string, LiveTick>()         // key: `${exchange}:${symbol}`
  private sockets = new Map<string, WebSocket[]>()    // exchange → connections (Binance may need multiple)
  private subs = new Map<string, Set<string>>()        // exchange → symbols
  private backoff = new Map<string, number>()
  private pingTimers = new Map<string, NodeJS.Timeout[]>()
  private stopped = false

  constructor(
    private readonly wsUrls: Record<string, string>,
    private readonly stalenessMs: number
  ) {}

  /**
   * Register symbols to subscribe for an exchange. Safe to call multiple times;
   * re-connects with updated subscription list.
   */
  subscribe(exchange: string, symbols: string[]): void {
    if (this.stopped) return
    if (!this.wsUrls[exchange]) return  // no WS URL configured for this exchange

    const existing = this.subs.get(exchange) ?? new Set<string>()
    let changed = false
    for (const sym of symbols) {
      if (!existing.has(sym)) { existing.add(sym); changed = true }
    }
    this.subs.set(exchange, existing)

    if (changed || !(this.sockets.get(exchange)?.length)) {
      this.reconnect(exchange)
    }
  }

  /** Returns a live tick if present and within staleness threshold, else undefined. */
  getTick(exchange: string, symbol: string): LiveTick | undefined {
    const tick = this.ticks.get(`${exchange}:${symbol}`)
    if (!tick) return undefined
    if (this.stalenessMs > 0 && Date.now() - tick.lastUpdatedAt > this.stalenessMs) return undefined
    return tick
  }

  /** Close all connections and stop reconnect attempts. */
  disconnect(): void {
    this.stopped = true
    for (const [exchange, timers] of this.pingTimers) {
      for (const t of timers) clearInterval(t)
    }
    this.pingTimers.clear()
    for (const [exchange, socks] of this.sockets) {
      for (const ws of socks) {
        ws.removeAllListeners()
        ws.terminate()
      }
    }
    this.sockets.clear()
  }

  private reconnect(exchange: string): void {
    // Close existing connections for this exchange before reconnecting
    const existing = this.sockets.get(exchange) ?? []
    for (const ws of existing) { ws.removeAllListeners(); ws.terminate() }
    const timers = this.pingTimers.get(exchange) ?? []
    for (const t of timers) clearInterval(t)
    this.pingTimers.set(exchange, [])
    this.sockets.set(exchange, [])

    if (exchange === 'binance') {
      this.connectBinance()
    } else if (exchange === 'bybit') {
      this.connectBybit()
    }
    // BingX: WS protocol uses gzip compression (TBD) — always falls back to REST
  }

  // ---------------------------------------------------------------------------
  // Binance
  // ---------------------------------------------------------------------------

  private connectBinance(): void {
    const syms = [...(this.subs.get('binance') ?? [])]
    if (syms.length === 0) return

    const baseUrl = this.wsUrls['binance']
    const streams = syms.map(s => `${s.toLowerCase()}@bookTicker`)

    // Split into chunks of BINANCE_STREAM_LIMIT to respect the per-connection cap
    const chunks: string[][] = []
    for (let i = 0; i < streams.length; i += BINANCE_STREAM_LIMIT) {
      chunks.push(streams.slice(i, i + BINANCE_STREAM_LIMIT))
    }

    const newSockets: WebSocket[] = []
    for (const chunk of chunks) {
      const url = `${baseUrl}/stream?streams=${chunk.join('/')}`
      const ws = new WebSocket(url)
      newSockets.push(ws)
      this.setupBinanceSocket(ws)
    }
    this.sockets.set('binance', newSockets)
  }

  private setupBinanceSocket(ws: WebSocket): void {
    ws.on('open', () => {
      this.backoff.set('binance', BACKOFF_BASE_MS)
      console.log('[ws:binance] connected')
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          stream: string
          data: { s: string; b: string; B: string; a: string; A: string }
        }
        const d = msg.data
        if (!d?.s || !d.b || !d.a) return
        const tick: LiveTick = {
          symbol: d.s,
          bidPrice: parseFloat(d.b),
          askPrice: parseFloat(d.a),
          lastUpdatedAt: Date.now(),
        }
        this.ticks.set(`binance:${d.s}`, tick)
      } catch {}
    })

    ws.on('ping', (data) => {
      ws.pong(data)
    })

    ws.on('close', () => {
      if (this.stopped) return
      console.log('[ws:binance] disconnected — reconnecting')
      this.scheduleReconnect('binance')
    })

    ws.on('error', (err) => {
      console.error('[ws:binance] error:', err.message)
      // 'close' will follow
    })
  }

  // ---------------------------------------------------------------------------
  // Bybit
  // ---------------------------------------------------------------------------

  private connectBybit(): void {
    const syms = [...(this.subs.get('bybit') ?? [])]
    if (syms.length === 0) return

    const baseUrl = this.wsUrls['bybit']
    const url = `${baseUrl}/v5/public/spot`
    const ws = new WebSocket(url)

    ws.on('open', () => {
      this.backoff.set('bybit', BACKOFF_BASE_MS)
      console.log('[ws:bybit] connected')

      // Subscribe to book-ticker topics for all symbols
      const args = syms.map(s => `tickers.${s}`)
      ws.send(JSON.stringify({ op: 'subscribe', args }))

      // Keepalive: Bybit requires a ping every 20s
      const timer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 'ping' }))
        }
      }, BYBIT_PING_INTERVAL_MS)
      const existing = this.pingTimers.get('bybit') ?? []
      this.pingTimers.set('bybit', [...existing, timer])
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          topic?: string
          data?: { bid1Price?: string; ask1Price?: string }
          op?: string
        }
        if (!msg.topic?.startsWith('tickers.') || !msg.data) return
        const sym = msg.topic.slice('tickers.'.length)
        const d = msg.data
        if (!d.bid1Price || !d.ask1Price) return
        const tick: LiveTick = {
          symbol: sym,
          bidPrice: parseFloat(d.bid1Price),
          askPrice: parseFloat(d.ask1Price),
          lastUpdatedAt: Date.now(),
        }
        this.ticks.set(`bybit:${sym}`, tick)
      } catch {}
    })

    ws.on('close', () => {
      if (this.stopped) return
      console.log('[ws:bybit] disconnected — reconnecting')
      this.scheduleReconnect('bybit')
    })

    ws.on('error', (err) => {
      console.error('[ws:bybit] error:', err.message)
    })

    this.sockets.set('bybit', [ws])
  }

  // ---------------------------------------------------------------------------
  // Reconnect with exponential backoff
  // ---------------------------------------------------------------------------

  private scheduleReconnect(exchange: string): void {
    if (this.stopped) return
    const delay = this.backoff.get(exchange) ?? BACKOFF_BASE_MS
    this.backoff.set(exchange, Math.min(delay * 2, BACKOFF_CAP_MS))
    console.log(`[ws:${exchange}] reconnecting in ${delay}ms`)
    setTimeout(() => {
      if (!this.stopped) this.reconnect(exchange)
    }, delay)
  }
}
