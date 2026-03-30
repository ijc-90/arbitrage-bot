import { Config } from './config'
import { ExchangeClient } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'

export interface LoopController {
  readonly hasSteps: boolean
  advance(): Promise<void>
}

export interface Opportunity {
  id: string
  pair: string
  exchangeBuy: string
  exchangeSell: string
  openedAt: number
  peakSpreadPct: number
  estimatedPnlUsdt: number
  askBuy: number
  bidSell: number
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export class OpportunityTracker {
  private current: Opportunity | null = null

  hasOpenOpportunity(): boolean {
    return this.current !== null
  }

  open(
    spread: { netSpreadPct: number; estimatedPnlUsdt: number; exchangeBuy: string; exchangeSell: string; askBuy: number; bidSell: number },
    pair: string,
    client: ExchangeClient,
    config: Config,
    logger: Logger,
    controller: LoopController
  ): Opportunity {
    const opp: Opportunity = {
      id: shortId(),
      pair,
      exchangeBuy: spread.exchangeBuy,
      exchangeSell: spread.exchangeSell,
      openedAt: Date.now(),
      peakSpreadPct: spread.netSpreadPct,
      estimatedPnlUsdt: spread.estimatedPnlUsdt,
      askBuy: spread.askBuy,
      bidSell: spread.bidSell,
    }
    this.current = opp

    const [exA, exB] = config.pairs.find(p => p.symbol === pair)!.exchanges

    setTimeout(() => this.poll(opp, exA, exB, client, config, logger, controller), config.fast_poll_interval_ms)
    return opp
  }

  private poll(
    opp: Opportunity,
    exchangeA: string,
    exchangeB: string,
    client: ExchangeClient,
    config: Config,
    logger: Logger,
    controller: LoopController
  ): void {
    client.getPairTicks(opp.pair, exchangeA, opp.pair, exchangeB)
      .then(([tickA, tickB]) => {
        const result = computeSpread(exchangeA, tickA, exchangeB, tickB, config)
        logger.logOpportunityTick(opp.id, result)

        if (result.netSpreadPct > opp.peakSpreadPct) {
          opp.peakSpreadPct = result.netSpreadPct
          opp.estimatedPnlUsdt = result.estimatedPnlUsdt
        }

        // convergence check FIRST — before touching controller
        if (!result.isOpportunity) {
          logger.logOpportunityClosed(opp, 'CONVERGENCE')
          this.current = null
          return
        }

        // still open — advance if budget allows, then schedule next poll
        if (controller.hasSteps) {
          controller.advance().then(() => {
            setTimeout(
              () => this.poll(opp, exchangeA, exchangeB, client, config, logger, controller),
              config.fast_poll_interval_ms
            )
          })
        }
        // if no steps: just return, no close event
      })
      .catch(err => {
        console.error('Opportunity poll error:', err)
        logger.logOpportunityClosed(opp, 'ERROR')
        this.current = null
      })
  }
}
