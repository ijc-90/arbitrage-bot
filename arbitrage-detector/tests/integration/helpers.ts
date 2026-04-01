import * as fs from 'node:fs'
import Database from 'better-sqlite3'

export type Results = { pass: number; fail: number }
export const makeResults = (): Results => ({ pass: 0, fail: 0 })

export function check(r: Results, name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`PASS [${name}]`)
    r.pass++
  } else {
    console.log(`FAIL [${name}]${detail ? ': ' + detail : ''}`)
    r.fail++
  }
}

export interface OppRow {
  id: string
  pair: string
  exchange_buy: string
  exchange_sell: string
  opened_at_ms: number
  closed_at_ms: number | null
  duration_ms: number | null
  ask_buy: number
  bid_sell: number
  net_spread_pct: number
  peak_spread_pct: number
  estimated_pnl_usdt: number
  close_reason: string | null
}

export interface PriceRow {
  id: number
  fetched_at_ms: number
  pair: string
  exchange_buy: string
  exchange_sell: string
  ask_buy: number
  bid_sell: number
  net_spread_pct: number
  is_opportunity: number
}

export interface TickRow {
  id: number
  opp_id: string
  fetched_at_ms: number
  ask_buy: number
  bid_sell: number
  net_spread_pct: number
}

export function openDb(dbPath: string): InstanceType<typeof Database> {
  return new Database(dbPath, { readonly: true })
}

// Clear logs dir before each test run (removes JSONL files and DB)
export function clearLogs(logsDir: string): void {
  if (fs.existsSync(logsDir)) {
    fs.rmSync(logsDir, { recursive: true })
  }
  fs.mkdirSync(logsDir, { recursive: true })
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const post = (url: string) =>
  fetch(url, { method: 'POST' }).then(r => r.text())
