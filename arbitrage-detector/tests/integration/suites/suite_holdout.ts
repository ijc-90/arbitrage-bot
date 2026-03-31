// HOLDOUT — ETH/USDT full lifecycle: opens at step 1, closes at step 2.
// Tests OPENED + CLOSED events and per-opportunity log file.

import { Results, makeResults, check, readJsonl } from '../helpers'
import * as fs from 'node:fs'

export async function runHoldout(
  logsDir: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_holdout ---')
  const r = makeResults()

  await runDetector()

  const opps = readJsonl(`${logsDir}/opportunities.jsonl`)

  const opened = opps.find((e: any) => e.event === 'OPENED')
  const closed = opps.find((e: any) => e.event === 'CLOSED')

  check(r, 'holdout/opened_event',        !!opened)
  check(r, 'holdout/closed_event',        !!closed)
  check(r, 'holdout/same_opp_id',         opened?.opp_id === closed?.opp_id,
    `opened=${opened?.opp_id} closed=${closed?.opp_id}`)
  check(r, 'holdout/pair_is_eth',         opened?.pair === 'ETHUSDT',
    `pair=${opened?.pair}`)
  check(r, 'holdout/closed_has_duration', typeof closed?.duration_ms === 'number')
  check(r, 'holdout/closed_has_reason',   closed?.reason === 'CONVERGENCE',
    `reason=${closed?.reason}`)

  // Per-opportunity log file should exist
  const oppId = opened?.opp_id
  const oppLog = oppId ? `${logsDir}/opp_${oppId}.jsonl` : null
  check(r, 'holdout/opp_log_exists',      !!oppLog && fs.existsSync(oppLog))

  const ticks = oppLog ? readJsonl(oppLog) : []
  check(r, 'holdout/opp_log_has_ticks',   ticks.length > 0)
  check(r, 'holdout/opp_log_has_spread',  ticks.every((t: any) => typeof t.net_spread_pct === 'number'))

  return r
}
