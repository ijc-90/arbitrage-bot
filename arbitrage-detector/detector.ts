import * as path from 'path'
import { loadConfig, loadEnv } from './config'
import { ExchangeClient } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { OpportunityTracker, LoopController } from './opportunityTracker'
import { initDb } from './db'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class StepController implements LoopController {
  private remaining: number

  constructor(steps: number, private advanceUrl: string) {
    this.remaining = steps
  }

  get hasSteps(): boolean {
    return this.remaining > 0
  }

  async advance(): Promise<void> {
    await fetch(`${this.advanceUrl}/scenario/advance`, { method: 'POST' })
    this.remaining--
  }
}

class ContinuousController implements LoopController {
  constructor(private intervalMs: number) {}

  get hasSteps(): boolean {
    return true
  }

  async advance(): Promise<void> {
    await sleep(this.intervalMs)
  }
}

function parseArgs(argv: string[]): { configPath: string; steps: number | null; advanceUrl: string | null; dbPath: string | null } {
  let configPath = 'config.yaml'
  let steps: number | null = null
  let advanceUrl: string | null = null
  let dbPath: string | null = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i]
    else if (argv[i] === '--steps' && argv[i + 1]) steps = parseInt(argv[++i], 10)
    else if (argv[i] === '--advance-url' && argv[i + 1]) advanceUrl = argv[++i]
    else if (argv[i] === '--db' && argv[i + 1]) dbPath = argv[++i]
  }

  return { configPath, steps, advanceUrl, dbPath }
}

async function main(): Promise<void> {
  const { configPath, steps, advanceUrl, dbPath } = parseArgs(process.argv.slice(2))

  const config = loadConfig(path.resolve(process.cwd(), configPath))
  const env = loadEnv()

  const logsDir = path.resolve(process.cwd(), 'logs')
  const resolvedDbPath = dbPath ?? path.join(logsDir, 'arb.db')
  const db = initDb(resolvedDbPath)

  const client = new ExchangeClient(env)
  const logger = new Logger(logsDir, db)
  const tracker = new OpportunityTracker()

  const controller: LoopController = steps !== null
    ? new StepController(steps, advanceUrl ?? 'http://localhost:3000')
    : new ContinuousController(config.slow_poll_interval_ms)

  process.on('SIGINT', () => { logger.flush(); process.exit(0) })
  process.on('SIGTERM', () => { logger.flush(); process.exit(0) })

  while (controller.hasSteps) {
    if (tracker.hasOpenOpportunity()) {
      await sleep(config.fast_poll_interval_ms)
      continue
    }

    for (const pair of config.pairs) {
      const [exA, exB] = pair.exchanges
      const [tickA, tickB] = await client.getPairTicks(pair.symbol, exA, pair.symbol, exB)
      const spread = computeSpread(exA, tickA, exB, tickB, config)
      logger.logPrice(pair.symbol, spread)

      if (spread.isOpportunity && !tracker.hasOpenOpportunity()) {
        const opp = tracker.open(spread, pair.symbol, client, config, logger, controller)
        logger.logOpportunityOpened(opp)
      }
    }

    await controller.advance()
  }

  logger.flush()
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
