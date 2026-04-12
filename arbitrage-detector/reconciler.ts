import { InventoryManager } from './inventoryManager'
import type { Db } from './db'
import { AlertSeverity } from './alerting'

type AlertFn = (event: string, severity: AlertSeverity, detail: Record<string, unknown>) => void

export class Reconciler {
  // Balances captured at session start (or last reconciliation).
  private sessionStartBalances = new Map<string, Record<string, number>>()
  private sessionStartPnl = 0  // realized PnL at the time of the snapshot
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(
    private inventory: InventoryManager,
    private db: Db,
    private alert: AlertFn,
    private tolerancePct: number,  // warn when divergence > this %
  ) {}

  // Capture baseline balances. Call once on startup after inventory has been refreshed.
  snapshot(): void {
    const balances = this.inventory.getAllBalances()
    for (const [ex, b] of balances) {
      this.sessionStartBalances.set(ex, { ...b })
    }
    this.sessionStartPnl = this.sumRealizedPnl()
    console.log(`[reconciler] baseline captured for ${[...balances.keys()].join(', ')}`)
  }

  // Start the periodic reconciliation job. Runs every `intervalHours` hours.
  start(intervalHours: number): void {
    const ms = intervalHours * 60 * 60 * 1000
    this.intervalHandle = setInterval(() => this.check(), ms)
    console.log(`[reconciler] running every ${intervalHours}h`)
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
  }

  async check(): Promise<void> {
    try {
      await this.inventory.refreshAll()
      const currentBalances = this.inventory.getAllBalances()

      // Compute total USDT delta across all exchanges vs. session start
      let balanceDeltaUsdt = 0
      for (const [ex, current] of currentBalances) {
        const start = this.sessionStartBalances.get(ex) ?? {}
        // Only compare USDT directly; other assets would need price conversion
        const startUsdt = start['USDT'] ?? 0
        const curUsdt = current['USDT'] ?? 0
        balanceDeltaUsdt += curUsdt - startUsdt
      }

      const cumulativePnl = this.sumRealizedPnl() - this.sessionStartPnl
      const divergence = Math.abs(balanceDeltaUsdt - cumulativePnl)
      const toleranceUsdt = Math.abs(cumulativePnl) * (this.tolerancePct / 100) + 1  // +$1 floor

      console.log(`[reconciler] balance_delta=${balanceDeltaUsdt.toFixed(4)} cumulative_pnl=${cumulativePnl.toFixed(4)} divergence=${divergence.toFixed(4)} USDT`)

      if (divergence > toleranceUsdt && Math.abs(cumulativePnl) > 0.01) {
        console.warn(`[reconciler] DIVERGENCE ${divergence.toFixed(4)} USDT exceeds tolerance ${toleranceUsdt.toFixed(4)} USDT`)
        this.alert('reconciliation_divergence', 'warn', {
          balanceDeltaUsdt,
          cumulativePnlUsdt: cumulativePnl,
          divergenceUsdt: divergence,
          toleranceUsdt,
        })
      }
    } catch (err: any) {
      console.error(`[reconciler] check failed: ${err.message}`)
    }
  }

  private sumRealizedPnl(): number {
    try {
      const row = this.db.prepare(
        `SELECT COALESCE(SUM(realized_pnl_usdt), 0) AS total FROM executions WHERE status = 'FILLED'`
      ).get() as { total: number }
      return row.total
    } catch {
      return 0
    }
  }
}
