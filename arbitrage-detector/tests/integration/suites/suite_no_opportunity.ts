import { Results, makeResults, check, openDb, OppRow, PriceRow } from '../helpers'

export async function runNoOpportunity(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_no_opportunity ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const prices = db.prepare('SELECT * FROM prices').all() as PriceRow[]
  const opps   = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  db.close()

  check(r, 'no_opp/prices_logged',        prices.length > 0,
    `prices.length=${prices.length}`)
  check(r, 'no_opp/no_opportunity_opened', opps.length === 0,
    `opportunities.length=${opps.length}`)
  check(r, 'no_opp/prices_have_pair',     prices.every(p => !!p.pair),
    'missing pair field')
  check(r, 'no_opp/prices_have_spread',   prices.every(p => typeof p.net_spread_pct === 'number'),
    'missing net_spread_pct')

  return r
}
