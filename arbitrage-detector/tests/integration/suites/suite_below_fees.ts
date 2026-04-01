// D — Positive raw spread that does not cover transaction costs.
// bybit bid > binance ask, but (raw - all_in_cost) < 0 → no opportunity.
// Verifies the detector does not open a position when fees eat the spread.

import { Results, makeResults, check, openDb, OppRow, PriceRow } from '../helpers'

export async function runBelowFees(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_below_fees ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const btcPrices = db.prepare('SELECT * FROM prices WHERE pair = ?').all('BTCUSDT') as PriceRow[]
  const opps      = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  db.close()

  check(r, 'below_fees/prices_logged',        btcPrices.length > 0,
    `btcPrices.length=${btcPrices.length}`)
  check(r, 'below_fees/no_opportunity',        opps.length === 0,
    `opportunities.length=${opps.length}`)

  // net spread must be negative (raw > 0 but below the 0.20% all-in cost)
  const allNegative = btcPrices.every(p => p.net_spread_pct < 0)
  check(r, 'below_fees/net_spread_negative',   allNegative,
    `some entries have non-negative net_spread_pct`)

  // net spread should be above -0.20% (raw was positive, not zero or inverted)
  const aboveFloor = btcPrices.every(p => p.net_spread_pct > -0.20)
  check(r, 'below_fees/raw_spread_was_positive', aboveFloor,
    `some entries have net_spread_pct <= -0.20, implying no raw spread`)

  return r
}
