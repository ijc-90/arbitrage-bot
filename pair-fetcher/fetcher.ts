import * as path from 'path'
import * as fs from 'fs'
import * as dotenv from 'dotenv'
import Database from 'better-sqlite3'

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { dbPath: string; intervalHours: number; envPath: string } {
  let dbPath       = path.resolve(__dirname, '../arbitrage-detector/logs/arb.db')
  let intervalHours = 1
  let envPath      = path.resolve(__dirname, '../arbitrage-detector/.env')

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1])       dbPath        = path.resolve(argv[++i])
    else if (argv[i] === '--interval' && argv[i + 1]) intervalHours = parseFloat(argv[++i])
    else if (argv[i] === '--env' && argv[i + 1]) envPath       = path.resolve(argv[++i])
  }

  return { dbPath, intervalHours, envPath }
}

// ── DB ────────────────────────────────────────────────────────────────────────

interface PairSnapshot {
  exchange: string
  symbol: string
  volume_24h_base: number   // volume in base asset (e.g. BTC)
  volume_24h_quote: number  // volume in quote asset (e.g. USDT) — use this for liquidity sizing
}

function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pair_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at_ms INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      volume_24h_base REAL NOT NULL,
      volume_24h_quote REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pair_snapshots_lookup
      ON pair_snapshots (exchange, symbol, fetched_at_ms DESC);
  `)
}

function saveSnapshots(db: Database.Database, snapshots: PairSnapshot[]): void {
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO pair_snapshots (fetched_at_ms, exchange, symbol, volume_24h_base, volume_24h_quote)
    VALUES (?, ?, ?, ?, ?)
  `)
  db.transaction(() => {
    for (const row of snapshots) {
      insert.run(now, row.exchange, row.symbol, row.volume_24h_base, row.volume_24h_quote)
    }
  })()
  console.log(`  saved ${snapshots.length} pair snapshots`)
}

// ── Exchange fetchers ─────────────────────────────────────────────────────────

// Binance GET /api/v3/ticker/24hr — returns all pairs with 24h volume
async function fetchBinancePairs(baseUrl: string): Promise<PairSnapshot[]> {
  const res = await fetch(`${baseUrl}/api/v3/ticker/24hr`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json() as Array<{
    symbol: string
    volume: string      // base asset volume
    quoteVolume: string // quote asset volume (USDT for *USDT pairs)
  }>

  return data.map(item => ({
    exchange: 'binance',
    symbol: item.symbol,
    volume_24h_base: parseFloat(item.volume),
    volume_24h_quote: parseFloat(item.quoteVolume),
  }))
}

// Bybit GET /v5/market/tickers?category=spot — returns all spot pairs with 24h volume
async function fetchBybitPairs(baseUrl: string): Promise<PairSnapshot[]> {
  const res = await fetch(`${baseUrl}/v5/market/tickers?category=spot`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json() as {
    retCode: number
    retMsg: string
    result: {
      list: Array<{
        symbol: string
        volume24h: string   // base asset volume
        turnover24h: string // quote asset volume (USDT for *USDT pairs)
      }>
    }
  }

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`)

  return data.result.list.map(item => ({
    exchange: 'bybit',
    symbol: item.symbol,
    volume_24h_base: parseFloat(item.volume24h),
    volume_24h_quote: parseFloat(item.turnover24h),
  }))
}

// BingX GET /openApi/spot/v1/ticker/24hr — returns all spot pairs with 24h volume
// BingX uses hyphenated symbols (BTC-USDT); normalise to BTCUSDT for consistency.
async function fetchBingXPairs(baseUrl: string): Promise<PairSnapshot[]> {
  const res = await fetch(`${baseUrl}/openApi/spot/v1/ticker/24hr`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data = await res.json() as {
    code: number
    data: Array<{
      symbol: string      // e.g. "BTC-USDT"
      volume: string      // base asset volume
      quoteVolume: string // quote asset volume
    }>
  }

  if (data.code !== 0) throw new Error(`BingX error code ${data.code}`)

  return data.data.map(item => ({
    exchange: 'bingx',
    symbol: item.symbol.replace('-', ''),   // BTC-USDT → BTCUSDT
    volume_24h_base: parseFloat(item.volume),
    volume_24h_quote: parseFloat(item.quoteVolume),
  }))
}

// ── Fetch loop ────────────────────────────────────────────────────────────────

async function fetchAll(exchangeUrls: Record<string, string>, db: Database.Database): Promise<void> {
  console.log(`[${new Date().toISOString()}] fetching pair volumes...`)

  const all: PairSnapshot[] = []
  let failures = 0

  const fetchers: Record<string, (url: string) => Promise<PairSnapshot[]>> = {
    binance: fetchBinancePairs,
    bybit:   fetchBybitPairs,
    bingx:   fetchBingXPairs,
  }

  for (const [exchange, url] of Object.entries(exchangeUrls)) {
    const fetch = fetchers[exchange]
    if (!fetch) {
      console.warn(`  ${exchange}: no fetcher implemented, skipping`)
      continue
    }
    try {
      const pairs = await fetch(url)
      all.push(...pairs)
      console.log(`  ${exchange}: ${pairs.length} pairs fetched`)
    } catch (err: any) {
      console.error(`  ${exchange}: ${err.message}`)
      failures++
    }
  }

  if (all.length > 0) {
    saveSnapshots(db, all)
  } else {
    console.warn('  no data fetched — nothing saved')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath, intervalHours, envPath } = parseArgs(process.argv.slice(2))

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath })
  } else {
    console.warn(`Warning: .env not found at ${envPath}`)
  }

  const exchangeUrls: Record<string, string> = {}
  if (process.env.BINANCE_URL) exchangeUrls.binance = process.env.BINANCE_URL
  if (process.env.BYBIT_URL)   exchangeUrls.bybit   = process.env.BYBIT_URL
  if (process.env.BINGX_URL)   exchangeUrls.bingx   = process.env.BINGX_URL

  if (Object.keys(exchangeUrls).length === 0) {
    console.error('No exchange URLs found. Set BINANCE_URL and/or BYBIT_URL in .env')
    process.exit(1)
  }

  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

  const db = new Database(dbPath)
  initDb(db)

  const intervalMs = intervalHours * 60 * 60 * 1000

  console.log('Pair fetcher started')
  console.log(`  DB:        ${dbPath}`)
  console.log(`  Interval:  ${intervalHours}h`)
  console.log(`  Exchanges: ${Object.keys(exchangeUrls).join(', ')}`)

  await fetchAll(exchangeUrls, db)

  setInterval(() => {
    fetchAll(exchangeUrls, db).catch(err => console.error('Unexpected error:', err))
  }, intervalMs)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
