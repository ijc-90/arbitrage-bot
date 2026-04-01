// HOLDOUT — ETH/USDT full lifecycle: opens at step 1, closes at step 2.
// Tests open + close state and per-opportunity ticks in the DB.

import { Results, makeResults, check, openDb, OppRow, TickRow } from '../helpers'

export async function runHoldout(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_holdout ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const opps  = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  const opp   = opps[0]
  const ticks = opp
    ? db.prepare('SELECT * FROM ticks WHERE opp_id = ?').all(opp.id) as TickRow[]
    : []
  db.close()

  check(r, 'holdout/opportunity_exists',  opps.length === 1,
    `opportunities.length=${opps.length}`)
  check(r, 'holdout/was_opened',          !!opp?.id)
  check(r, 'holdout/was_closed',          opp?.close_reason === 'CONVERGENCE',
    `close_reason=${opp?.close_reason}`)
  check(r, 'holdout/pair_is_eth',         opp?.pair === 'ETHUSDT',
    `pair=${opp?.pair}`)
  check(r, 'holdout/has_duration',        typeof opp?.duration_ms === 'number')
  check(r, 'holdout/ticks_exist',         ticks.length > 0,
    `ticks.length=${ticks.length}`)
  check(r, 'holdout/ticks_have_spread',   ticks.every(t => typeof t.net_spread_pct === 'number'))

  return r
}
