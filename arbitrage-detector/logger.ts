import * as fs from 'fs'
import * as path from 'path'
import { SpreadResult } from './spreadEngine'
import type { Opportunity } from './opportunityTracker'
import type { Db } from './db'

type Stmt = ReturnType<Db['prepare']>

export class Logger {
  private opportunitiesPath: string
  private pricesPath: string
  private stmts?: {
    insertOpp: Stmt
    updateOpp: Stmt
    insertPrice: Stmt
    insertTick: Stmt
  }

  constructor(private logsDir: string, db?: Db) {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    this.opportunitiesPath = path.join(logsDir, 'opportunities.jsonl')
    this.pricesPath = path.join(logsDir, 'prices.jsonl')

    if (db) {
      this.stmts = {
        insertOpp: db.prepare(`
          INSERT INTO opportunities
            (id, pair, exchange_buy, exchange_sell, opened_at_ms, ask_buy, bid_sell, net_spread_pct, peak_spread_pct, estimated_pnl_usdt)
          VALUES
            (@id, @pair, @exchange_buy, @exchange_sell, @opened_at_ms, @ask_buy, @bid_sell, @net_spread_pct, @peak_spread_pct, @estimated_pnl_usdt)
        `),
        updateOpp: db.prepare(`
          UPDATE opportunities
          SET closed_at_ms = @closed_at_ms,
              duration_ms = @duration_ms,
              peak_spread_pct = @peak_spread_pct,
              estimated_pnl_usdt = @estimated_pnl_usdt,
              close_reason = @close_reason
          WHERE id = @id
        `),
        insertPrice: db.prepare(`
          INSERT INTO prices
            (fetched_at_ms, pair, exchange_buy, exchange_sell, ask_buy, bid_sell, net_spread_pct, is_opportunity)
          VALUES
            (@fetched_at_ms, @pair, @exchange_buy, @exchange_sell, @ask_buy, @bid_sell, @net_spread_pct, @is_opportunity)
        `),
        insertTick: db.prepare(`
          INSERT INTO ticks
            (opp_id, fetched_at_ms, ask_buy, bid_sell, net_spread_pct)
          VALUES
            (@opp_id, @fetched_at_ms, @ask_buy, @bid_sell, @net_spread_pct)
        `),
      }
    }
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
    this.stmts?.insertOpp.run({
      id: opp.id,
      pair: opp.pair,
      exchange_buy: opp.exchangeBuy,
      exchange_sell: opp.exchangeSell,
      opened_at_ms: opp.openedAt,
      ask_buy: opp.askBuy,
      bid_sell: opp.bidSell,
      net_spread_pct: opp.peakSpreadPct,
      peak_spread_pct: opp.peakSpreadPct,
      estimated_pnl_usdt: opp.estimatedPnlUsdt,
    })
  }

  logOpportunityClosed(opp: Opportunity, reason: string): void {
    const now = Date.now()
    const duration_ms = now - opp.openedAt
    this.append(this.opportunitiesPath, {
      ts: new Date(now).toISOString(),
      event: 'CLOSED',
      opp_id: opp.id,
      reason,
      duration_ms,
      peak_spread_pct: opp.peakSpreadPct,
      estimated_pnl_usdt: opp.estimatedPnlUsdt,
    })
    this.stmts?.updateOpp.run({
      id: opp.id,
      closed_at_ms: now,
      duration_ms,
      peak_spread_pct: opp.peakSpreadPct,
      estimated_pnl_usdt: opp.estimatedPnlUsdt,
      close_reason: reason,
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
    this.stmts?.insertPrice.run({
      fetched_at_ms: Date.now(),
      pair,
      exchange_buy: result.exchangeBuy,
      exchange_sell: result.exchangeSell,
      ask_buy: result.askBuy,
      bid_sell: result.bidSell,
      net_spread_pct: result.netSpreadPct,
      is_opportunity: result.isOpportunity ? 1 : 0,
    })
  }

  logOpportunityTick(oppId: string, result: SpreadResult): void {
    this.append(this.oppPath(oppId), {
      ts: new Date().toISOString(),
      ask_buy: result.askBuy,
      bid_sell: result.bidSell,
      net_spread_pct: result.netSpreadPct,
    })
    this.stmts?.insertTick.run({
      opp_id: oppId,
      fetched_at_ms: Date.now(),
      ask_buy: result.askBuy,
      bid_sell: result.bidSell,
      net_spread_pct: result.netSpreadPct,
    })
  }

  flush(): void {
    // appendFileSync is synchronous — no buffering to flush
  }
}
