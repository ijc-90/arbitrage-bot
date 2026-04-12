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
  execution_enabled?: boolean           // set true to enable live order placement; false = alarm-only (default false)
  max_execution_age_ms?: number         // reject execution if opportunity is older than this (default 500)
  max_concurrent_positions?: number     // max simultaneous open trades (default 1)
  max_notional_per_exchange_usdt?: number  // max USDT committed to any one exchange at once (default 1000)
  max_daily_loss_usdt?: number          // halt when daily realized loss exceeds this (default 50)
  max_drawdown_pct?: number             // halt when session drawdown % of (capital*10) exceeds this (default 5)
  order_book_depth?: number             // L2 levels to fetch for slippage computation (default 10)
  min_fill_ratio?: number               // skip execution if book can only fill < this fraction (default 0.9)
  reconciliation_interval_hours?: number  // how often to run balance reconciliation (default 4)
  reconciliation_tolerance_pct?: number   // warn when PnL vs balance diverges by > this % (default 0.5)
  dry_run_sandbox?: boolean             // log [DRY-RUN] prefix on all order calls (default false)
  funding_arb?: FundingArbConfig
}

export interface FundingArbConfig {
  enabled: boolean
  dry_run?: boolean                        // log [FUNDING-DRY-RUN], no real orders (default true)
  scan_interval_ms?: number               // how often to poll funding rates (default 60000)
  poll_interval_ms?: number               // how often to check open positions (default 60000)
  capital_per_side_usdt?: number          // deployed per leg; total = 2x this (default 100)
  entry_threshold_pct?: number            // enter when rate > this (default 0.05 = 0.05%/8h ≈ 66% APR)
  exit_threshold_pct?: number             // exit when rate drops below this (default 0.01)
  min_time_to_settlement_ms?: number      // don't enter within N ms of settlement (default 600000 = 10min)
  max_hold_hours?: number                 // force-close after N hours (default 72)
  max_positions?: number                  // max simultaneous funding positions (default 3)
  stop_loss_pct?: number                  // exit if unrealized perp loss > N% of notional (default 2.0)
  liquidation_buffer_pct?: number         // exit if mark within N% of liquidation price (default 10.0)
  max_basis_pct?: number                  // alert if perp-spot basis > N% (default 0.5)
  leverage?: number                       // perp leverage (default 1 = fully collateralised)
  pairs?: string[]                        // explicit list; if absent, scans all listed perps
  exchanges?: string[]                    // exchanges to scan; if absent, uses all with API keys
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
