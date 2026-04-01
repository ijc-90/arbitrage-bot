// E — Net spread is profitable (above min_net_spread_pct) but below the
//     entry_buffer_multiplier threshold. Tests the buffer config knob.
//
// Config: min_net_spread_pct=0.10, entry_buffer_multiplier=1.5
// Effective threshold = all_in_cost(0.20) * 1.5 = 0.30%
// Scenario net ≈ 0.20% — passes min_net check, fails buffer guard.

import { Results, makeResults, check, openDb, OppRow, PriceRow } from '../helpers'

const MIN_NET_PCT = 0.10   // from config.test.yaml
const BUFFER_PCT  = 0.30   // all_in(0.20) * entry_buffer_multiplier(1.5)

export async function runBelowBuffer(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_below_buffer ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const btcPrices = db.prepare('SELECT * FROM prices WHERE pair = ?').all('BTCUSDT') as PriceRow[]
  const opps      = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  db.close()

  check(r, 'below_buffer/prices_logged',      btcPrices.length > 0,
    `btcPrices.length=${btcPrices.length}`)
  check(r, 'below_buffer/no_opportunity',      opps.length === 0,
    `opportunities.length=${opps.length}`)

  // net spread is above min_net (real spread exists, not just noise)
  const aboveMin = btcPrices.every(p => p.net_spread_pct >= MIN_NET_PCT)
  check(r, 'below_buffer/net_above_min_net',   aboveMin,
    `some entries have net_spread_pct < ${MIN_NET_PCT}`)

  // net spread is below the buffer threshold (the reason no opportunity fired)
  const belowBuffer = btcPrices.every(p => p.net_spread_pct < BUFFER_PCT)
  check(r, 'below_buffer/net_below_buffer',    belowBuffer,
    `some entries have net_spread_pct >= ${BUFFER_PCT}`)

  return r
}
