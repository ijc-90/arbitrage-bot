import { Results, makeResults, check, openDb, OppRow, PriceRow } from '../helpers'

export async function runOpportunityOpens(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_opportunity_opens ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const prices = db.prepare('SELECT * FROM prices').all() as PriceRow[]
  const opps   = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  db.close()

  check(r, 'opp_opens/prices_logged',      prices.length > 0)
  check(r, 'opp_opens/opportunity_logged', opps.length >= 1,
    `opportunities.length=${opps.length}`)

  const opp = opps[0]
  check(r, 'opp_opens/opened_event_exists',  !!opp)
  check(r, 'opp_opens/opened_has_pair',      opp?.pair === 'BTCUSDT',
    `pair=${opp?.pair}`)
  check(r, 'opp_opens/opened_has_opp_id',    !!opp?.id)
  check(r, 'opp_opens/opened_has_pnl',       typeof opp?.estimated_pnl_usdt === 'number')
  check(r, 'opp_opens/exchange_buy_binance',  opp?.exchange_buy === 'binance',
    `exchange_buy=${opp?.exchange_buy}`)
  check(r, 'opp_opens/exchange_sell_bybit',   opp?.exchange_sell === 'bybit',
    `exchange_sell=${opp?.exchange_sell}`)

  return r
}
