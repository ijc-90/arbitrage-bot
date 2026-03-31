import { Results, makeResults, check, readJsonl } from '../helpers'

export async function runNoOpportunity(
  logsDir: string,
  runDetector: () => Promise<void>
): Promise<Results> {
  console.log('\n--- suite_no_opportunity ---')
  const r = makeResults()

  await runDetector()

  const prices = readJsonl(`${logsDir}/prices.jsonl`)
  const opps   = readJsonl(`${logsDir}/opportunities.jsonl`)

  check(r, 'no_opp/prices_logged',      prices.length > 0,
    `prices.length=${prices.length}`)
  check(r, 'no_opp/no_opportunity_opened', opps.length === 0,
    `opportunities.length=${opps.length}`)
  check(r, 'no_opp/prices_have_pair',   prices.every((p: any) => p.pair),
    'missing pair field')
  check(r, 'no_opp/prices_have_spread', prices.every((p: any) => typeof p.net_spread_pct === 'number'),
    'missing net_spread_pct')

  return r
}
