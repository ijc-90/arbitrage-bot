// Spread inversion: opportunity opens on one side, closes on convergence,
// then a new opportunity opens in the opposite direction.
//
// step 0: no opportunity
// step 1: OPP A — buy binance, sell bybit (bybit bid > binance ask)
// step 2: neutral — tracker closes OPP A (CONVERGENCE)
// step 3: OPP B — buy bybit, sell binance (binance bid > bybit ask, opposite)
//
// Expected DB state: two rows in opportunities, oppA closed, oppB still open

import { Results, makeResults, check, openDb, OppRow } from '../helpers'

export async function runInversion(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_inversion ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const allOpps    = db.prepare('SELECT * FROM opportunities ORDER BY opened_at_ms').all() as OppRow[]
  const closedOpps = allOpps.filter(o => o.close_reason !== null)
  db.close()

  check(r, 'inversion/two_opportunities', allOpps.length === 2,
    `opportunities.length=${allOpps.length}`)
  check(r, 'inversion/one_closed',        closedOpps.length === 1,
    `closed.length=${closedOpps.length}`)

  const oppA   = allOpps[0]
  const oppB   = allOpps[1]
  const closed = closedOpps[0]  // should be oppA

  // OPP A: buy on binance, sell on bybit
  check(r, 'inversion/oppA_buy_binance',  oppA?.exchange_buy === 'binance',
    `exchange_buy=${oppA?.exchange_buy}`)
  check(r, 'inversion/oppA_sell_bybit',   oppA?.exchange_sell === 'bybit',
    `exchange_sell=${oppA?.exchange_sell}`)

  // CLOSED row is OPP A
  check(r, 'inversion/closed_is_oppA',    closed?.id === oppA?.id,
    `closed.id=${closed?.id} oppA.id=${oppA?.id}`)
  check(r, 'inversion/closed_convergence', closed?.close_reason === 'CONVERGENCE',
    `close_reason=${closed?.close_reason}`)

  // OPP B: opposite direction — buy on bybit, sell on binance
  check(r, 'inversion/oppB_buy_bybit',    oppB?.exchange_buy === 'bybit',
    `exchange_buy=${oppB?.exchange_buy}`)
  check(r, 'inversion/oppB_sell_binance', oppB?.exchange_sell === 'binance',
    `exchange_sell=${oppB?.exchange_sell}`)

  // OPP B is still open when steps exhaust
  check(r, 'inversion/oppB_still_open',   oppB?.close_reason === null,
    `close_reason=${oppB?.close_reason}`)

  // OPP A was closed before OPP B opened (ms integer comparison)
  check(r, 'inversion/closed_before_oppB',
    (closed?.closed_at_ms ?? 0) <= (oppB?.opened_at_ms ?? 0),
    `oppA closed_at=${closed?.closed_at_ms}, oppB opened_at=${oppB?.opened_at_ms}`)

  return r
}
