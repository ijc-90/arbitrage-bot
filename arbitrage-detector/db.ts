import Database from 'better-sqlite3'

export type Db = InstanceType<typeof Database>

export function initDb(dbPath: string): Db {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')  // allows concurrent readers (dashboard) while detector writes
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      pair TEXT NOT NULL,
      exchange_buy TEXT NOT NULL,
      exchange_sell TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      duration_ms INTEGER,
      ask_buy REAL NOT NULL,
      bid_sell REAL NOT NULL,
      net_spread_pct REAL NOT NULL,
      peak_spread_pct REAL NOT NULL,
      estimated_pnl_usdt REAL NOT NULL,
      close_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at_ms INTEGER NOT NULL,
      pair TEXT NOT NULL,
      exchange_buy TEXT NOT NULL,
      exchange_sell TEXT NOT NULL,
      ask_buy REAL NOT NULL,
      bid_sell REAL NOT NULL,
      net_spread_pct REAL NOT NULL,
      is_opportunity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opp_id TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      ask_buy REAL NOT NULL,
      bid_sell REAL NOT NULL,
      net_spread_pct REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exchange_symbol_blacklist (
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (exchange, symbol)
    );
  `)
  return db
}
