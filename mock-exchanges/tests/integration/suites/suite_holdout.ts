// Holdout: ETH/USDT — unknown to builder.
// Tests scenario loading from module/scenarios/ (private directory).

import { Results, makeResults, check, get, post } from '../helpers'

export async function runHoldout(base: string): Promise<Results> {
  console.log('\n--- suite_holdout ---')
  const r = makeResults()

  // This scenario lives in module/scenarios/ (not workspace/scenarios/)
  // Server finds it via the dual lookup: workspace first, then ../scenarios/
  const loaded = await post(`${base}/scenario/load/scenario_003_holdout`)
  check(r, 'holdout/load_ok', loaded, '"loaded":"scenario_003_holdout"')

  // step 0: no opportunity
  const b0 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=ETHUSDT`)
  check(r, 'holdout/step0_binance_ask', b0, '"askPrice":"2655.00"')
  const y0 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=ETHUSDT`)
  check(r, 'holdout/step0_bybit_bid',   y0, '"bid1Price":"2649.00"')

  // step 1: opportunity
  await post(`${base}/scenario/advance`)
  const b1 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=ETHUSDT`)
  check(r, 'holdout/step1_binance_ask', b1, '"askPrice":"2650.00"')
  const y1 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=ETHUSDT`)
  check(r, 'holdout/step1_bybit_bid',   y1, '"bid1Price":"2650.50"')

  // step 2: convergence
  await post(`${base}/scenario/advance`)
  const b2 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=ETHUSDT`)
  check(r, 'holdout/step2_binance_ask', b2, '"askPrice":"2652.00"')
  const y2 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=ETHUSDT`)
  check(r, 'holdout/step2_bybit_bid',   y2, '"bid1Price":"2651.50"')

  return r
}
