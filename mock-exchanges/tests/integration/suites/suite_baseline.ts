import { Results, makeResults, check, checkAbsent, get } from '../helpers'

export async function runBaseline(base: string): Promise<Results> {
  console.log('\n--- suite_baseline ---')
  const r = makeResults()

  const binance = await get(`${base}/binance/api/v3/ticker/bookTicker?symbol=BTCUSDT`)
  check(r, 'baseline/binance_bidPrice',  binance, '"bidPrice"')
  check(r, 'baseline/binance_askPrice',  binance, '"askPrice"')

  const bybit = await get(`${base}/bybit/v5/market/tickers?category=spot&symbol=BTCUSDT`)
  check(r, 'baseline/bybit_retCode_0',   bybit, '"retCode":0')
  check(r, 'baseline/bybit_bid1Price',   bybit, '"bid1Price"')

  const kraken = await get(`${base}/kraken/0/public/Ticker?pair=XBTUSD`)
  check(r, 'baseline/kraken_no_error',   kraken, '"error":[]')
  check(r, 'baseline/kraken_XXBTZUSD',   kraken, '"XXBTZUSD"')

  const status = await get(`${base}/scenario/status`)
  check(r,       'baseline/status_inactive',    status, '"active":false')
  checkAbsent(r, 'baseline/no_elapsed_seconds', status, '"elapsed_seconds"')

  return r
}
