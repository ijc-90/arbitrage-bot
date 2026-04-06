import { computeSpread, Tick } from './spreadEngine'
import { Config } from './config'

const baseConfig: Config = {
  pairs: [{ symbol: 'BTCUSDT', exchanges: ['binance', 'bybit'] }],
  exchanges: {
    binance: { taker_fee_pct: 0.06, slippage_estimate_pct: 0.04 },
    bybit:   { taker_fee_pct: 0.06, slippage_estimate_pct: 0.04 },
  },
  capital_per_trade_usdt: 500,
  entry_buffer_multiplier: 2.0,
  slow_poll_interval_ms: 5000,
  fast_poll_interval_ms: 200,
}

// all_in_cost = 0.06+0.06+0.04+0.04 = 0.20%
// buffer threshold = 0.20 * 2.0 = 0.40%
// isOpportunity requires net >= 0.40

describe('computeSpread', () => {
  test('no opportunity when raw spread is negative', () => {
    const tickA: Tick = { bidPrice: 43250, askPrice: 43251 }
    const tickB: Tick = { bidPrice: 43249, askPrice: 43252 }
    const result = computeSpread('binance', tickA, 'bybit', tickB, baseConfig)
    expect(result.isOpportunity).toBe(false)
    expect(result.netSpreadPct).toBeLessThan(0)
  })

  test('no opportunity when net spread below all_in_cost * entry_buffer_multiplier', () => {
    // net = 0.25% (> min 0.15) but < buffer (0.40%) → no opp
    // bid_B = ask_A * (1 + (0.25+0.20)/100) ≈ ask_A * 1.0045
    const askA = 43250
    const bidB = askA * (1 + 0.0045)   // raw ≈ 0.45%, net ≈ 0.25%
    const tickA: Tick = { bidPrice: 43248, askPrice: askA }
    const tickB: Tick = { bidPrice: bidB, askPrice: bidB + 2 }
    const result = computeSpread('binance', tickA, 'bybit', tickB, baseConfig)
    // net ≈ 0.25%, buffer = 0.40% → no opportunity
    expect(result.isOpportunity).toBe(false)
    expect(result.netSpreadPct).toBeGreaterThan(0)
    expect(result.netSpreadPct).toBeLessThan(0.40)
  })

  test('opportunity detected when both thresholds met', () => {
    // net needs >= 0.40% and >= 0.15%
    // raw = (bidB - askA)/askA*100 = 0.62% → net = 0.62 - 0.20 = 0.42%
    const askA = 43250
    const bidB = askA * (1 + 0.0062)
    const tickA: Tick = { bidPrice: 43248, askPrice: askA }
    const tickB: Tick = { bidPrice: bidB, askPrice: bidB + 2 }
    const result = computeSpread('binance', tickA, 'bybit', tickB, baseConfig)
    expect(result.isOpportunity).toBe(true)
    expect(result.netSpreadPct).toBeGreaterThanOrEqual(0.40)
  })

  test('correctly identifies which exchange to buy from and sell to', () => {
    // Higher ask on bybit → buy binance (lower ask), sell bybit (higher bid)
    const tickBinance: Tick = { bidPrice: 43249, askPrice: 43250 }
    const tickBybit:   Tick = { bidPrice: 43580, askPrice: 43582 }
    const result = computeSpread('binance', tickBinance, 'bybit', tickBybit, baseConfig)
    expect(result.exchangeBuy).toBe('binance')
    expect(result.exchangeSell).toBe('bybit')
    expect(result.askBuy).toBe(43250)
    expect(result.bidSell).toBe(43580)
  })

  test('swaps direction when bybit has lower ask', () => {
    const tickBinance: Tick = { bidPrice: 43580, askPrice: 43582 }
    const tickBybit:   Tick = { bidPrice: 43249, askPrice: 43250 }
    const result = computeSpread('binance', tickBinance, 'bybit', tickBybit, baseConfig)
    expect(result.exchangeBuy).toBe('bybit')
    expect(result.exchangeSell).toBe('binance')
  })

  test('estimated_pnl_usdt computed correctly', () => {
    const askA = 43250
    const bidB = askA * (1 + 0.0062)
    const tickA: Tick = { bidPrice: 43248, askPrice: askA }
    const tickB: Tick = { bidPrice: bidB, askPrice: bidB + 2 }
    const result = computeSpread('binance', tickA, 'bybit', tickB, baseConfig)
    const expected = (result.netSpreadPct / 100) * baseConfig.capital_per_trade_usdt
    expect(result.estimatedPnlUsdt).toBeCloseTo(expected, 8)
  })
})
