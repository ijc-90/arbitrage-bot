import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import * as dotenv from 'dotenv'

export interface ExchangeConfig {
  taker_fee_pct: number
  slippage_estimate_pct: number
}

export interface PairConfig {
  symbol: string
  exchanges: [string, string]
}

export interface AutoPairsConfig {
  min_volume_usdt: number
}

export interface Config {
  pairs?: PairConfig[]
  auto_pairs?: AutoPairsConfig
  exchanges: Record<string, ExchangeConfig>
  capital_per_trade_usdt: number
  entry_buffer_multiplier: number
  slow_poll_interval_ms: number
  fast_poll_interval_ms: number
  staleness_threshold_ms?: number  // max age of a WS tick before falling back to REST (default 2000)
}

export interface Env {
  exchangeUrls: Record<string, string>
  wsUrls: Record<string, string>
}

export function loadConfig(configPath: string): Config {
  const raw = fs.readFileSync(configPath, 'utf-8')
  return yaml.load(raw) as Config
}

export function loadEnv(): Env {
  const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env'
  const envPath = path.resolve(process.cwd(), envFile)
  dotenv.config({ path: envPath })

  const exchangeUrls: Record<string, string> = {}
  const wsUrls: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_WS_URL') && value) {
      const exchange = key.slice(0, -7).toLowerCase()
      wsUrls[exchange] = value
    } else if (key.endsWith('_URL') && value) {
      const exchange = key.slice(0, -4).toLowerCase()
      exchangeUrls[exchange] = value
    }
  }
  return { exchangeUrls, wsUrls }
}
