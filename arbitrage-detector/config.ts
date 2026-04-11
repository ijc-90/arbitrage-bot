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
  staleness_threshold_ms?: number       // max age of a WS tick before falling back to REST (default 2000)
  max_net_spread_pct?: number           // reject opportunities above this spread as bad data (default 20)
  max_opportunity_duration_ms?: number  // force-close stuck opportunities after this duration (default 300000)
  price_retention_hours?: number        // prune prices older than this; 0 = keep forever (default 6)
  liquidity_flag_threshold_pct?: number // flag routes where capital > this % of min exchange daily volume (default 0.1)
}

export interface ApiKey {
  key: string
  secret: string
}

export interface Env {
  exchangeUrls: Record<string, string>
  wsUrls: Record<string, string>
  apiKeys: Record<string, ApiKey>  // exchange → { key, secret }; absent = read-only / alarm-only
}

export function loadConfig(configPath: string): Config {
  const raw = fs.readFileSync(configPath, 'utf-8')
  return yaml.load(raw) as Config
}

export function loadEnv(envPath?: string): Env {
  const resolved = envPath
    ? path.resolve(process.cwd(), envPath)
    : path.resolve(process.cwd(), process.env.NODE_ENV === 'test' ? '.env.test' : '.env')
  dotenv.config({ path: resolved })

  const exchangeUrls: Record<string, string> = {}
  const wsUrls: Record<string, string> = {}
  const apiKeys: Record<string, ApiKey> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue
    if (key.endsWith('_WS_URL')) {
      wsUrls[key.slice(0, -7).toLowerCase()] = value
    } else if (key.endsWith('_URL')) {
      exchangeUrls[key.slice(0, -4).toLowerCase()] = value
    } else if (key.endsWith('_API_KEY')) {
      const exchange = key.slice(0, -8).toLowerCase()
      if (!apiKeys[exchange]) apiKeys[exchange] = { key: '', secret: '' }
      apiKeys[exchange].key = value
    } else if (key.endsWith('_API_SECRET')) {
      const exchange = key.slice(0, -11).toLowerCase()
      if (!apiKeys[exchange]) apiKeys[exchange] = { key: '', secret: '' }
      apiKeys[exchange].secret = value
    }
  }

  // Remove incomplete entries (key without secret or vice versa)
  for (const [ex, creds] of Object.entries(apiKeys)) {
    if (!creds.key || !creds.secret) delete apiKeys[ex]
  }

  return { exchangeUrls, wsUrls, apiKeys }
}
