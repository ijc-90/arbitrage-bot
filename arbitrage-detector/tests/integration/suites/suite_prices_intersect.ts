// Prices move through the zero-spread crossover point across 3 steps:
//   step 0: binance ask > bybit bid  (spread negative — no raw spread)
//   step 1: binance ask = bybit bid  (EXACT INTERSECTION — raw = 0%)
//   step 2: bybit bid > binance ask  (spread crosses positive, but still below fees)
//
// No opportunity should fire at any step, including at the crossing point.

import { Results, makeResults, check, openDb, OppRow, PriceRow } from '../helpers'

const ALL_IN_COST = 0.20   // taker + slip for both exchanges (from config.test.yaml)
const TOLERANCE   = 0.001  // floating-point tolerance for exact-zero check

export async function runPricesIntersect(
  dbPath: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_prices_intersect ---')
  const r = makeResults()

  await runDetector()

  const db = openDb(dbPath)
  const btcPrices = db.prepare('SELECT * FROM prices WHERE pair = ?').all('BTCUSDT') as PriceRow[]
  const opps      = db.prepare('SELECT * FROM opportunities').all() as OppRow[]
  db.close()

  check(r, 'intersect/prices_logged',        btcPrices.length > 0,
    `btcPrices.length=${btcPrices.length}`)
  check(r, 'intersect/no_opportunity',        opps.length === 0,
    `opportunities.length=${opps.length}`)

  // Prices moved: not all net_spread_pct values are the same
  const spreads = btcPrices.map(p => p.net_spread_pct)
  const allSame = spreads.every(v => Math.abs(v - spreads[0]) < TOLERANCE)
  check(r, 'intersect/spread_varied',         !allSame,
    `all net_spread_pct values identical — prices did not move`)

  // At the intersection step (raw=0), net = -all_in_cost exactly
  // At least one logged entry should be near -0.20%
  const hasIntersectEntry = btcPrices.some(
    p => Math.abs(p.net_spread_pct - (-ALL_IN_COST)) < TOLERANCE
  )
  check(r, 'intersect/crossing_point_logged', hasIntersectEntry,
    `no entry near net_spread_pct=-${ALL_IN_COST} (expected at exact intersection step)`)

  return r
}
