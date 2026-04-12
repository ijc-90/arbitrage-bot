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
      open_resolution_ms INTEGER,
      close_resolution_ms INTEGER,
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
    CREATE TABLE IF NOT EXISTS detector_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exchange_symbol_blacklist (
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (exchange, symbol)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id TEXT NOT NULL,
      status TEXT NOT NULL,
      buy_order_id TEXT,
      sell_order_id TEXT,
      buy_client_order_id TEXT,
      sell_client_order_id TEXT,
      filled_qty REAL NOT NULL DEFAULT 0,
      avg_buy_price REAL NOT NULL DEFAULT 0,
      avg_sell_price REAL NOT NULL DEFAULT 0,
      buy_fee_usdt REAL NOT NULL DEFAULT 0,
      sell_fee_usdt REAL NOT NULL DEFAULT 0,
      realized_pnl_usdt REAL,
      detection_to_execution_ms INTEGER,
      executed_at_ms INTEGER NOT NULL,
      hedge_order_id TEXT
    );
    CREATE TABLE IF NOT EXISTS funding_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at_ms INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      funding_rate_pct REAL NOT NULL,
      mark_price REAL NOT NULL,
      next_funding_time_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS funding_positions (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      close_reason TEXT,
      entry_spot_price REAL NOT NULL,
      entry_perp_price REAL NOT NULL,
      exit_spot_price REAL,
      exit_perp_price REAL,
      qty REAL NOT NULL,
      capital_per_side_usdt REAL NOT NULL,
      spot_order_id TEXT,
      perp_order_id TEXT,
      entry_funding_rate_pct REAL NOT NULL,
      funding_collected_usdt REAL,
      realized_pnl_usdt REAL,
      dry_run INTEGER NOT NULL DEFAULT 0
    );
  `)

  // Migrate existing DBs: add new columns if absent (ALTER TABLE throws if column exists)
  const migrations: string[] = [
    'ALTER TABLE opportunities ADD COLUMN open_resolution_ms INTEGER',
    'ALTER TABLE opportunities ADD COLUMN close_resolution_ms INTEGER',
    'ALTER TABLE opportunities ADD COLUMN realized_pnl_usdt REAL',
    'ALTER TABLE opportunities ADD COLUMN execution_status TEXT',
    'ALTER TABLE prices ADD COLUMN depth_slippage_pct REAL',
  ]
  for (const stmt of migrations) {
    try { db.exec(stmt) } catch {}
  }

  return db
}
