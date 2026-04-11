import { Config } from './config'
import { ExchangeClient, BookTick } from './exchangeClient'
import { computeSpread } from './spreadEngine'
import { Logger } from './logger'
import { WsFeedManager } from './wsFeed'

export interface Opportunity {
  id: string
  pair: string
  exchangeBuy: string
  exchangeSell: string
  openedAt: number
  openResolutionMs: number | null
  entrySpreadPct: number   // spread at the moment of detection — immutable
  peakSpreadPct: number    // running maximum, updated each poll
  estimatedPnlUsdt: number
  askBuy: number
  bidSell: number
  effectiveCapital: number // volume-capped capital used for this opportunity — used in poll() PnL
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export class OpportunityTracker {
  private current: Opportunity | null = null
  private lastPollAt: number = 0

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
    wsFeed: WsFeedManager | null = null,
    openResolutionMs: number | null = null,
    effectiveCapital: number = config.capital_per_trade_usdt,
  ): Opportunity {
    const opp: Opportunity = {
      id: shortId(),
      pair,
      exchangeBuy: spread.exchangeBuy,
      exchangeSell: spread.exchangeSell,
      openedAt: Date.now(),
      openResolutionMs,
      entrySpreadPct: spread.netSpreadPct,
      peakSpreadPct: spread.netSpreadPct,
      estimatedPnlUsdt: spread.estimatedPnlUsdt,
      askBuy: spread.askBuy,
      bidSell: spread.bidSell,
      effectiveCapital,
    }
    this.current = opp
    this.lastPollAt = Date.now()

    const [exA, exB] = exchanges

    setTimeout(() => this.poll(opp, exA, exB, client, config, logger, wsFeed), config.fast_poll_interval_ms)
    return opp
  }

  private poll(
    opp: Opportunity,
    exchangeA: string,
    exchangeB: string,
    client: ExchangeClient,
    config: Config,
    logger: Logger,
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

    const pollStartedAt = this.lastPollAt
    this.lastPollAt = Date.now()

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
          setTimeout(() => this.poll(opp, exchangeA, exchangeB, client, config, logger, wsFeed), config.fast_poll_interval_ms)
          return
        }
        const result = computeSpread(exchangeA, tickA, exchangeB, tickB, config, opp.effectiveCapital)
        logger.logOpportunityTick(opp.id, result)

        // Track peak spread for visibility but keep PnL at entry value —
        // we entered at the opening price, the peak is unrealised upside
        if (result.netSpreadPct > opp.peakSpreadPct) {
          opp.peakSpreadPct = result.netSpreadPct
        }

        // convergence check FIRST — before touching controller
        if (!result.isOpportunity) {
          const closeResolutionMs = Date.now() - pollStartedAt
          logger.logOpportunityClosed(opp, 'CONVERGENCE', closeResolutionMs)
          this.current = null
          return
        }

        // Timeout guard: if the opportunity has been open too long, force-close it.
        // Prevents frozen prices (e.g. stale BingX data) from keeping an opportunity open forever.
        const maxDurationMs = config.max_opportunity_duration_ms ?? 300_000
        if (Date.now() - opp.openedAt > maxDurationMs) {
          console.warn(`[tracker] ${opp.id} ${opp.pair} exceeded max duration ${maxDurationMs}ms — closing as TIMEOUT`)
          const closeResolutionMs = Date.now() - pollStartedAt
          logger.logOpportunityClosed(opp, 'TIMEOUT', closeResolutionMs)
          this.current = null
          return
        }

        // still open — schedule next fast poll
        setTimeout(
          () => this.poll(opp, exchangeA, exchangeB, client, config, logger, wsFeed),
          config.fast_poll_interval_ms
        )
      })
      .catch(err => {
        console.error('Opportunity poll error:', err)
        const closeResolutionMs = Date.now() - pollStartedAt
        logger.logOpportunityClosed(opp, 'ERROR', closeResolutionMs)
        this.current = null
      })
  }
}
