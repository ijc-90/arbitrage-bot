// Spread inversion: opportunity opens on one side, closes on convergence,
// then a new opportunity opens in the opposite direction.
//
// step 0: no opportunity
// step 1: OPP A — buy binance, sell bybit (bybit bid > binance ask)
// step 2: neutral — tracker closes OPP A (CONVERGENCE)
// step 3: OPP B — buy bybit, sell binance (binance bid > bybit ask, opposite)
//
// Expected log sequence: OPENED(binance→bybit) → CLOSED → OPENED(bybit→binance)

import { Results, makeResults, check, readJsonl } from '../helpers'

export async function runInversion(
  logsDir: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_inversion ---')
  const r = makeResults()

  await runDetector()

  const opps = readJsonl(`${logsDir}/opportunities.jsonl`)

  const openedEvents = opps.filter((e: any) => e.event === 'OPENED')
  const closedEvents = opps.filter((e: any) => e.event === 'CLOSED')

  check(r, 'inversion/two_opened_events',    openedEvents.length === 2,
    `opened.length=${openedEvents.length}`)
  check(r, 'inversion/one_closed_event',     closedEvents.length === 1,
    `closed.length=${closedEvents.length}`)

  const oppA = openedEvents[0]
  const oppB = openedEvents[1]
  const closed = closedEvents[0]

  // OPP A: buy on binance, sell on bybit
  check(r, 'inversion/oppA_buy_binance',     oppA?.exchange_buy === 'binance',
    `exchange_buy=${oppA?.exchange_buy}`)
  check(r, 'inversion/oppA_sell_bybit',      oppA?.exchange_sell === 'bybit',
    `exchange_sell=${oppA?.exchange_sell}`)

  // CLOSED belongs to OPP A
  check(r, 'inversion/closed_is_oppA',       closed?.opp_id === oppA?.opp_id,
    `closed.opp_id=${closed?.opp_id} oppA.opp_id=${oppA?.opp_id}`)
  check(r, 'inversion/closed_convergence',   closed?.reason === 'CONVERGENCE',
    `reason=${closed?.reason}`)

  // OPP B: opposite direction — buy on bybit, sell on binance
  check(r, 'inversion/oppB_buy_bybit',       oppB?.exchange_buy === 'bybit',
    `exchange_buy=${oppB?.exchange_buy}`)
  check(r, 'inversion/oppB_sell_binance',    oppB?.exchange_sell === 'binance',
    `exchange_sell=${oppB?.exchange_sell}`)

  // OPP B is still open when steps exhaust (no CLOSED for it)
  check(r, 'inversion/oppB_still_open',
    closedEvents.every((e: any) => e.opp_id !== oppB?.opp_id),
    `oppB has an unexpected CLOSED event`)

  // OPP A was closed before OPP B opened (ordering check)
  const closedTs  = closed?.ts ?? ''
  const oppBOpenTs = oppB?.ts ?? ''
  check(r, 'inversion/closed_before_oppB',   closedTs <= oppBOpenTs,
    `OPP A closed at ${closedTs}, OPP B opened at ${oppBOpenTs}`)

  return r
}
