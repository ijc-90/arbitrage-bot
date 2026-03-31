import { Results, makeResults, check, get, post } from '../helpers'

export async function runSpreadInversion(base: string): Promise<Results> {
  console.log('\n--- suite_spread_inversion ---')
  const r = makeResults()

  // Load scenario_003: spread inversion
  const load = await post(`${base}/scenario/load/scenario_003_spread_inversion`)
  check(r, 's003/load_ok', load, '"loaded":"scenario_003_spread_inversion"')

  // Step 0: No opportunity (binance ask=43255.00 > bybit bid=43250.00)
  const b0 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's003/step0_binance_ask', b0, '"askPrice":"43255.00"')
  const y0 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's003/step0_bybit_bid', y0, '"bid1Price":"43250.00"')

  // Advance to step 1: Opportunity opens (binance ask=43250.00 < bybit bid=43253.00)
  const adv1 = await post(`${base}/scenario/advance`)
  check(r, 's003/advance_step_1', adv1, '"binance":1')

  const b1 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's003/step1_binance_ask', b1, '"askPrice":"43250.00"')
  const y1 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's003/step1_bybit_bid', y1, '"bid1Price":"43253.00"')

  // Advance to step 2: Inversion (binance ask=43258.00 > bybit bid=43254.00, spread negative)
  const adv2 = await post(`${base}/scenario/advance`)
  check(r, 's003/advance_step_2', adv2, '"binance":2')

  const b2 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's003/step2_binance_ask', b2, '"askPrice":"43258.00"')
  const y2 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's003/step2_bybit_bid', y2, '"bid1Price":"43254.00"')

  return r
}
