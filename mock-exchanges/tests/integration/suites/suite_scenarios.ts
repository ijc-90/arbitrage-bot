import { Results, makeResults, check, get, post } from '../helpers'

export async function runScenarios(base: string): Promise<Results> {
  console.log('\n--- suite_scenarios ---')
  const r = makeResults()

  // scenario_001: static spread, opportunity always open
  const l1 = await post(`${base}/scenario/load/scenario_001_static_spread`)
  check(r, 's001/load_ok',           l1, '"loaded":"scenario_001_static_spread"')

  const b1 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's001/binance_ask_43250', b1, '"askPrice":"43250.00"')

  const y1 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's001/bybit_bid_43252',   y1, '"bid1Price":"43252.00"')

  const st = await get(`${base}/scenario/status`)
  check(r, 's001/status_active',     st, '"active":true')
  check(r, 's001/advance_mode',      st, '"advance_mode":true')

  // scenario_002: no-opp → opportunity → convergence
  const l2 = await post(`${base}/scenario/load/scenario_002_convergence`)
  check(r, 's002/load_ok', l2, '"loaded":"scenario_002_convergence"')

  // step 0
  const b0 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's002/step0_binance_ask', b0, '"askPrice":"43255.00"')
  const y0 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's002/step0_bybit_bid',   y0, '"bid1Price":"43250.00"')

  // advance to step 1
  const adv = await post(`${base}/scenario/advance`)
  check(r, 's002/advance_step_1', adv, '"binance":1')

  const b1s = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's002/step1_binance_ask', b1s, '"askPrice":"43250.00"')
  const y1s = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's002/step1_bybit_bid',   y1s, '"bid1Price":"43253.00"')

  // advance to step 2
  await post(`${base}/scenario/advance`)
  const b2 = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's002/step2_binance_ask', b2, '"askPrice":"43252.00"')
  const y2 = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 's002/step2_bybit_bid',   y2, '"bid1Price":"43251.00"')

  // clamp: extra advances stay at last step
  await post(`${base}/scenario/advance`)
  await post(`${base}/scenario/advance`)
  const bc = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's002/clamp_at_step2', bc, '"askPrice":"43252.00"')

  // reload resets to step 0
  await post(`${base}/scenario/load/scenario_002_convergence`)
  const br = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 's002/reload_step0', br, '"askPrice":"43255.00"')

  // 404 on unknown scenario
  const notFound = await fetch(`${base}/scenario/load/does_not_exist`, { method: 'POST' })
  check(r, 's002/404_on_unknown', String(notFound.status), '404')

  return r
}
