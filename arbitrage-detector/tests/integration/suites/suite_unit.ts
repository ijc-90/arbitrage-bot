import { Results, makeResults, check } from '../helpers'
import { computeSpread } from '../../../spreadEngine'

const config = {
  exchanges: {
    binance: { taker_fee_pct: 0.06, slippage_estimate_pct: 0.04 },
    bybit:   { taker_fee_pct: 0.06, slippage_estimate_pct: 0.04 },
  },
  capital_per_trade_usdt: 500,
  entry_buffer_multiplier: 1.5,
} as any

export async function runUnit(): Promise<Results> {
  console.log('\n--- suite_unit ---')
  const r = makeResults()

  // No opportunity: negative spread
  const neg = computeSpread(
    'binance', { bidPrice: 43249, askPrice: 43255 },
    'bybit',   { bidPrice: 43250, askPrice: 43256 },
    config
  )
  check(r, 'unit/negative_spread_no_opportunity', !neg.isOpportunity,
    `isOpportunity=${neg.isOpportunity}`)

  // Opportunity: bybit bid > binance ask with enough margin
  const pos = computeSpread(
    'binance', { bidPrice: 43000, askPrice: 43000 },
    'bybit',   { bidPrice: 43220, askPrice: 43221 },
    config
  )
  check(r, 'unit/positive_spread_opportunity', pos.isOpportunity,
    `netSpreadPct=${pos.netSpreadPct}`)
  check(r, 'unit/buys_on_binance', pos.exchangeBuy === 'binance',
    `exchangeBuy=${pos.exchangeBuy}`)
  check(r, 'unit/sells_on_bybit', pos.exchangeSell === 'bybit',
    `exchangeSell=${pos.exchangeSell}`)

  // PnL calculation
  const expectedPnl = (pos.netSpreadPct / 100) * 500
  check(r, 'unit/pnl_correct',
    Math.abs(pos.estimatedPnlUsdt - expectedPnl) < 0.01,
    `expected=${expectedPnl.toFixed(4)} got=${pos.estimatedPnlUsdt.toFixed(4)}`)

  // Below buffer threshold
  const thin = computeSpread(
    'binance', { bidPrice: 43249, askPrice: 43250 },
    'bybit',   { bidPrice: 43250.5, askPrice: 43251 },
    config
  )
  check(r, 'unit/below_threshold_no_opportunity', !thin.isOpportunity,
    `netSpreadPct=${thin.netSpreadPct}`)

  return r
}
