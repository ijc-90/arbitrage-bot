import { Results, makeResults, check, readJsonl } from '../helpers'

export async function runOpportunityOpens(
  logsDir: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_opportunity_opens ---')
  const r = makeResults()

  await runDetector()

  const prices = readJsonl(`${logsDir}/prices.jsonl`)
  const opps   = readJsonl(`${logsDir}/opportunities.jsonl`)

  check(r, 'opp_opens/prices_logged',   prices.length > 0)
  check(r, 'opp_opens/opportunity_logged', opps.length >= 1,
    `opportunities.length=${opps.length}`)

  const opened = opps.find((e: any) => e.event === 'OPENED')
  check(r, 'opp_opens/opened_event_exists',  !!opened)
  check(r, 'opp_opens/opened_has_pair',      opened?.pair === 'BTCUSDT',
    `pair=${opened?.pair}`)
  check(r, 'opp_opens/opened_has_opp_id',    !!opened?.opp_id)
  check(r, 'opp_opens/opened_has_pnl',       typeof opened?.estimated_pnl_usdt === 'number')
  check(r, 'opp_opens/exchange_buy_binance',  opened?.exchange_buy === 'binance',
    `exchange_buy=${opened?.exchange_buy}`)
  check(r, 'opp_opens/exchange_sell_bybit',   opened?.exchange_sell === 'bybit',
    `exchange_sell=${opened?.exchange_sell}`)

  return r
}
