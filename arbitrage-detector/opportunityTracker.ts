import { Config } from './config'
import { ExchangeClient, BookTick } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { WsFeedManager } from './wsFeed'

export interface LoopController {
  readonly hasSteps: boolean
  advance(): Promise<void>
  fastAdvance(): Promise<void>  // no-op in prod, scenario-advance in test
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
    exchanges: [string, string],
    client: ExchangeClient,
    config: Config,
    logger: Logger,
    controller: LoopController,
    wsFeed: WsFeedManager | null = null
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

    const [exA, exB] = exchanges

    setTimeout(() => this.poll(opp, exA, exB, client, config, logger, controller, wsFeed), config.fast_poll_interval_ms)
    return opp
  }

  private poll(
    opp: Opportunity,
    exchangeA: string,
    exchangeB: string,
    client: ExchangeClient,
    config: Config,
    logger: Logger,
    controller: LoopController,
    wsFeed: WsFeedManager | null
  ): void {
    // Prefer WS tick; fall back to REST with retry for transient socket errors
    const getTickWithFallback = (ex: string, sym: string): Promise<BookTick> => {
      const wsTick = wsFeed?.getTick(ex, sym)
      if (wsTick) return Promise.resolve(wsTick)
      return client.getBookTicker(ex, sym)
    }

    const fetchWithRetry = (retries: number): Promise<[BookTick, BookTick]> =>
      Promise.all([getTickWithFallback(exchangeA, opp.pair), getTickWithFallback(exchangeB, opp.pair)])
        .catch(err => {
          if (retries > 0 && err?.cause?.code === 'UND_ERR_SOCKET') {
            return new Promise(r => setTimeout(r, 200)).then(() => fetchWithRetry(retries - 1))
          }
          throw err
        })

    fetchWithRetry(2)
      .then(([tickA, tickB]) => {
        // Guard against transient bad prices (NaN/zero) — skip this tick rather than
        // writing invalid data to DB or closing a valid opportunity on a one-off glitch.
        if (
          !isFinite(tickA.bidPrice) || tickA.bidPrice <= 0 ||
          !isFinite(tickA.askPrice) || tickA.askPrice <= 0 ||
          !isFinite(tickB.bidPrice) || tickB.bidPrice <= 0 ||
          !isFinite(tickB.askPrice) || tickB.askPrice <= 0
        ) {
          setTimeout(() => this.poll(opp, exchangeA, exchangeB, client, config, logger, controller, wsFeed), config.fast_poll_interval_ms)
          return
        }
        const result = computeSpread(exchangeA, tickA, exchangeB, tickB, config)
        logger.logOpportunityTick(opp.id, result)

        // Track peak spread for visibility but keep PnL at entry value —
        // we entered at the opening price, the peak is unrealised upside
        if (result.netSpreadPct > opp.peakSpreadPct) {
          opp.peakSpreadPct = result.netSpreadPct
        }

        // convergence check FIRST — before touching controller
        if (!result.isOpportunity) {
          logger.logOpportunityClosed(opp, 'CONVERGENCE')
          this.current = null
          return
        }

        // still open — advance scenario (test only), then schedule next fast poll
        if (controller.hasSteps) {
          controller.fastAdvance().then(() => {
            setTimeout(
              () => this.poll(opp, exchangeA, exchangeB, client, config, logger, controller, wsFeed),
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
