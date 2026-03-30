import * as fs from 'fs'
import * as path from 'path'
import { SpreadResult } from './spreadEngine'
import type { Opportunity } from './opportunityTracker'

export class Logger {
  private opportunitiesPath: string
  private pricesPath: string

  constructor(private logsDir: string) {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    this.opportunitiesPath = path.join(logsDir, 'opportunities.jsonl')
    this.pricesPath = path.join(logsDir, 'prices.jsonl')
  }

  private oppPath(oppId: string): string {
    return path.join(this.logsDir, `opp_${oppId}.jsonl`)
  }

  private append(filePath: string, record: object): void {
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n')
  }

  logOpportunityOpened(opp: Opportunity): void {
    this.append(this.opportunitiesPath, {
      ts: new Date().toISOString(),
      event: 'OPENED',
      opp_id: opp.id,
      pair: opp.pair,
      exchange_buy: opp.exchangeBuy,
      exchange_sell: opp.exchangeSell,
      ask_buy: opp.askBuy,
      bid_sell: opp.bidSell,
      net_spread_pct: opp.peakSpreadPct,
      estimated_pnl_usdt: opp.estimatedPnlUsdt,
    })
  }

  logOpportunityClosed(opp: Opportunity, reason: string): void {
    this.append(this.opportunitiesPath, {
      ts: new Date().toISOString(),
      event: 'CLOSED',
      opp_id: opp.id,
      reason,
      duration_ms: Date.now() - opp.openedAt,
      peak_spread_pct: opp.peakSpreadPct,
      estimated_pnl_usdt: opp.estimatedPnlUsdt,
    })
  }

  logPrice(pair: string, result: SpreadResult): void {
    this.append(this.pricesPath, {
      ts: new Date().toISOString(),
      pair,
      exchange_buy: result.exchangeBuy,
      exchange_sell: result.exchangeSell,
      ask_buy: result.askBuy,
      bid_sell: result.bidSell,
      net_spread_pct: result.netSpreadPct,
      opportunity: result.isOpportunity,
    })
  }

  logOpportunityTick(oppId: string, result: SpreadResult): void {
    this.append(this.oppPath(oppId), {
      ts: new Date().toISOString(),
      ask_buy: result.askBuy,
      bid_sell: result.bidSell,
      net_spread_pct: result.netSpreadPct,
    })
  }

  flush(): void {
    // appendFileSync is synchronous — no buffering to flush
  }
}
