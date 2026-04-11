import express from 'express'
import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { dbPath: string; port: number } {
  let dbPath = path.resolve(__dirname, '../arbitrage-detector/logs/arb.db')
  let port = 4000

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) dbPath = path.resolve(argv[++i])
    else if (argv[i] === '--port' && argv[i + 1]) port = parseInt(argv[++i], 10)
  }

  return { dbPath, port }
}

// ── DB ────────────────────────────────────────────────────────────────────────

function openDb(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null
  return new Database(dbPath, { readonly: true })
}

function hasPairSnapshots(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='pair_snapshots'`
  ).get()
  return !!row
}

// Load per-exchange volumes from pair_snapshots, sorted smallest-first per symbol.
// Converts BTC-quoted pairs to USDT equivalent using latest BTCUSDT price from prices table.
// Returns null if pair_snapshots doesn't exist or is empty.
function loadVolumes(db: Database.Database): Map<string, { exchange: string; volume_24h_usdt: number }[]> | null {
  if (!hasPairSnapshots(db)) return null
  const rows = db.prepare(`
    SELECT symbol, exchange, volume_24h_quote AS volume_raw
    FROM pair_snapshots
    WHERE id IN (SELECT MAX(id) FROM pair_snapshots GROUP BY exchange, symbol)
  `).all() as Array<{ symbol: string; exchange: string; volume_raw: number }>

  if (rows.length === 0) return null

  // Fetch BTC/USDT mid price to convert *BTC pair volumes to USDT equivalent
  let btcUsdt = 0
  try {
    const r = db.prepare(
      `SELECT (ask_buy + bid_sell) / 2.0 AS mid FROM prices WHERE pair = 'BTCUSDT' ORDER BY fetched_at_ms DESC LIMIT 1`
    ).get() as { mid: number } | undefined
    if (r?.mid && isFinite(r.mid) && r.mid > 0) btcUsdt = r.mid
  } catch {}

  const map = new Map<string, { exchange: string; volume_24h_usdt: number }[]>()
  for (const row of rows) {
    let vol: number
    if (row.symbol.endsWith('USDT')) {
      vol = row.volume_raw
    } else if (row.symbol.endsWith('BTC')) {
      vol = row.volume_raw * btcUsdt  // 0 when BTC price not yet available → filtered by $1k floor
    } else {
      continue  // ETH/BNB/etc quote currencies not yet supported
    }
    if (!map.has(row.symbol)) map.set(row.symbol, [])
    map.get(row.symbol)!.push({ exchange: row.exchange, volume_24h_usdt: vol })
  }
  for (const vols of map.values()) {
    vols.sort((a, b) => a.volume_24h_usdt - b.volume_24h_usdt) // smallest first
  }
  return map
}

// Attach volumes[] and min_volume_usdt to each pair row in-place.
function applyVolumes(pairs: any[], volMap: Map<string, any[]> | null): void {
  for (const p of pairs) {
    const vols = volMap?.get(p.symbol) ?? []
    p.volumes = vols
    p.min_volume_usdt = vols.length > 0 ? vols[0].volume_24h_usdt : 0
  }
}

function queryMonitoredPairsBase(db: Database.Database): any[] {
  return db.prepare(`
    SELECT
      p.pair                                 AS symbol,
      1                                      AS is_monitored,
      p.exchange_buy,
      p.exchange_sell,
      p.net_spread_pct,
      p.fetched_at_ms,
      COUNT(o.id)                            AS opp_count,
      COALESCE(MAX(o.peak_spread_pct), 0)    AS best_spread_pct,
      COALESCE(SUM(o.estimated_pnl_usdt), 0) AS total_pnl_usdt
    FROM prices p
    LEFT JOIN opportunities o ON o.pair = p.pair AND o.close_reason IS NOT NULL
    WHERE p.id IN (SELECT MAX(id) FROM prices GROUP BY pair)
    GROUP BY p.pair
    ORDER BY opp_count DESC, best_spread_pct DESC
  `).all() as any[]
}

function queryMonitoredPairs(db: Database.Database): any[] {
  const pairs = queryMonitoredPairsBase(db)
  applyVolumes(pairs, loadVolumes(db))
  return pairs
}

function queryAllPairs(db: Database.Database): any[] {
  const monitored = queryMonitoredPairsBase(db)
  const volMap = loadVolumes(db)
  applyVolumes(monitored, volMap)

  if (!volMap) return monitored

  const monitoredSymbols = new Set<string>(monitored.map((p: any) => p.symbol))

  const unmonitored: any[] = []
  for (const [symbol, vols] of volMap.entries()) {
    if (vols.length < 2) continue  // single-exchange pair — no arb possible, don't show
    if (vols[0].volume_24h_usdt < 1000) continue  // filter garbage / unresolved-price pairs
    if (!monitoredSymbols.has(symbol)) {
      unmonitored.push({
        symbol,
        is_monitored: 0,
        exchange_buy: null,
        exchange_sell: null,
        net_spread_pct: null,
        fetched_at_ms: null,
        opp_count: 0,
        best_spread_pct: 0,
        total_pnl_usdt: 0,
        volumes: vols,
        min_volume_usdt: vols[0].volume_24h_usdt,
      })
    }
  }

  unmonitored.sort((a, b) => b.min_volume_usdt - a.min_volume_usdt)
  return [...monitored, ...unmonitored]
}

function querySnapshot(dbPath: string) {
  const db = openDb(dbPath)
  if (!db) return null
  try {
    const pairs = queryMonitoredPairs(db)

    const opportunities = db.prepare(`
      SELECT * FROM opportunities
      ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC
      LIMIT 50
    `).all()

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(estimated_pnl_usdt), 0) as total_pnl,
        COALESCE(AVG(estimated_pnl_usdt), 0) as avg_pnl,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM opportunities
      WHERE close_reason IS NOT NULL
    `).get() as Record<string, number>

    const lastSeen = db.prepare(`
      SELECT MAX(fetched_at_ms) as ts FROM prices
    `).get() as { ts: number | null }

    let settings: { key: string; value: string }[] = []
    try { settings = db.prepare(`SELECT key, value FROM detector_settings`).all() as { key: string; value: string }[] } catch {}
    const getSetting = (k: string, fallback: number) => parseFloat(settings.find(s => s.key === k)?.value ?? String(fallback))
    const liquidityFlag = {
      capitalUsdt: getSetting('capital_per_trade_usdt', 500),
      thresholdPct: getSetting('liquidity_flag_threshold_pct', 0.1),
    }

    return { pairs, opportunities, stats: { ...stats, last_seen_ms: lastSeen?.ts ?? null }, liquidityFlag }
  } finally {
    db.close()
  }
}

function queryOpportunity(dbPath: string, id: string) {
  const db = openDb(dbPath)
  if (!db) return null
  try {
    const opp = db.prepare(`SELECT * FROM opportunities WHERE id = ?`).get(id)
    if (!opp) return null
    const ticks = db.prepare(`
      SELECT fetched_at_ms, net_spread_pct, ask_buy, bid_sell
      FROM ticks WHERE opp_id = ? ORDER BY fetched_at_ms ASC
    `).all(id)
    return { opp, ticks }
  } finally {
    db.close()
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Arb Detector</title>
<style>
  :root {
    --bg:      #0a0a0f;
    --surface: #12121a;
    --border:  #1e1e2e;
    --text:    #cdd6f4;
    --dim:     #6c7086;
    --green:   #a6e3a1;
    --red:     #f38ba8;
    --yellow:  #f9e2af;
    --blue:    #89b4fa;
    --purple:  #cba6f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    line-height: 1.5;
    padding: 20px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 15px; letter-spacing: 0.1em; color: var(--blue); }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .pill::before { content: '●'; font-size: 8px; }
  .pill.live    { background: #1a2f1a; color: var(--green); }
  .pill.stale   { background: #2f2a1a; color: var(--yellow); }
  .pill.offline { background: #2f1a1a; color: var(--red); }
  .pill.waiting { background: #1a1a2f; color: var(--dim); }
  .last-updated { margin-left: auto; color: var(--dim); font-size: 11px; }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; }
  .stat-card .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  .stat-card .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .stat-card .value.green  { color: var(--green); }
  .stat-card .value.blue   { color: var(--blue); }
  .stat-card .value.purple { color: var(--purple); }
  .stat-card .value.yellow { color: var(--yellow); }

  .open-opp {
    background: #0d1f12;
    border: 1px solid #2a4a30;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .open-opp h2 { color: var(--green); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 10px; }
  .open-opp-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .open-opp-field .label { color: var(--dim); font-size: 11px; }
  .open-opp-field .value { font-size: 15px; font-weight: 600; margin-top: 2px; }

  .section { margin-bottom: 20px; }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 8px;
  }
  .section-header h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--dim);
    white-space: nowrap;
  }
  .section-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  select.filter, input.filter {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 3px;
    outline: none;
  }
  select.filter { cursor: pointer; }
  input.filter { width: 130px; }
  input.filter::placeholder { color: var(--dim); }
  select.filter:hover, input.filter:hover { border-color: var(--dim); }
  input.filter:focus { border-color: var(--blue); }

  .toggle-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--dim);
    font-family: inherit;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle-btn.active { border-color: var(--blue); color: var(--blue); }
  .toggle-btn:hover { border-color: var(--dim); color: var(--text); }

  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    color: var(--dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }
  td { padding: 7px 12px; border-bottom: 1px solid #0e0e18; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1a1a28; }
  tr.clickable { cursor: pointer; }
  tr.unmonitored td { color: var(--dim); }
  tr.unmonitored td:first-child { color: var(--text); }
  tr.low-liquidity td { background: rgba(249,226,175,0.06); }
  tr.low-liquidity td:last-child::after { content: ' ⚠'; color: var(--yellow); font-size: 10px; }

  .monitored-dot { color: var(--green); font-size: 8px; margin-right: 4px; vertical-align: middle; }

  .pair-link { color: var(--blue); cursor: pointer; }
  .pair-link:hover { text-decoration: underline; }

  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .tag.conv { background: #1a2f1a; color: var(--green); }
  .tag.err  { background: #2f1a1a; color: var(--red); }
  .tag.open { background: #1a2a1a; color: var(--green); animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }

  .spread-pos { color: var(--green); }
  .spread-neg { color: var(--red); }
  .spread-neu { color: var(--dim); }
  .arrow { color: var(--dim); }

  #no-data { display: none; text-align: center; padding: 60px; color: var(--dim); }
  #no-data .big { font-size: 32px; margin-bottom: 8px; }

  /* ── Detail panel ── */
  #detail-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 99; }
  #detail-overlay.open { display: block; }
  #detail-panel {
    position: fixed; top: 0; right: -46%; width: 45%; height: 100%;
    background: #0e0e16; border-left: 1px solid var(--border);
    padding: 24px; overflow-y: auto;
    transition: right 0.2s ease; z-index: 100;
  }
  #detail-panel.open { right: 0; }
  .detail-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
  }
  .detail-header h2 { font-size: 16px; color: var(--blue); }
  .detail-header .sub { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .detail-close {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font-family: inherit; font-size: 14px; cursor: pointer;
    padding: 2px 8px; border-radius: 3px; line-height: 1.4;
  }
  .detail-close:hover { color: var(--text); border-color: var(--dim); }
  .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .detail-field .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .detail-field .value { font-size: 14px; font-weight: 600; margin-top: 3px; }
  .detail-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 10px; }
  .sparkline-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
  .sparkline-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 10px; color: var(--dim); }
  .sparkline-legend span { display: flex; align-items: center; gap: 4px; }
</style>
</head>
<body>

<header>
  <h1>ARB DETECTOR</h1>
  <span id="status-pill" class="pill waiting">WAITING</span>
  <span class="last-updated" id="last-updated">–</span>
</header>

<div id="no-data">
  <div class="big">◌</div>
  Waiting for data — is the detector running?
</div>

<div id="main-content">
  <div class="stats-bar">
    <div class="stat-card">
      <div class="label">Opportunities</div>
      <div class="value blue" id="stat-total">–</div>
    </div>
    <div class="stat-card">
      <div class="label">Total est. PnL</div>
      <div class="value green" id="stat-total-pnl">–</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg est. PnL</div>
      <div class="value purple" id="stat-avg-pnl">–</div>
    </div>
    <div class="stat-card">
      <div class="label">Avg Duration</div>
      <div class="value yellow" id="stat-avg-dur">–</div>
    </div>
  </div>

  <div id="open-opp-section" style="display:none" class="open-opp">
    <h2>● Open Opportunity</h2>
    <div class="open-opp-grid">
      <div class="open-opp-field"><div class="label">Pair</div><div class="value" id="oo-pair">–</div></div>
      <div class="open-opp-field"><div class="label">Direction</div><div class="value" id="oo-direction">–</div></div>
      <div class="open-opp-field"><div class="label">Spread</div><div class="value spread-pos" id="oo-spread">–</div></div>
      <div class="open-opp-field"><div class="label">Est. PnL</div><div class="value" id="oo-pnl">–</div></div>
      <div class="open-opp-field"><div class="label">Open for</div><div class="value" id="oo-age">–</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Routes</h2>
      <div class="section-controls">
        <select class="filter" id="pairs-sort">
          <option value="opps">Sort: Most Opportunities</option>
          <option value="spread" selected>Sort: Best Spread</option>
          <option value="pnl">Sort: Total PnL</option>
          <option value="volume">Sort: Volume 24h</option>
        </select>
        <input class="filter" id="pairs-search" type="text" placeholder="search symbol…" />
        <button class="toggle-btn" id="pairs-scope-btn">Show all routes</button>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Route</th>
          <th>Spread</th>
          <th>Opps</th>
          <th>Best Spread</th>
          <th>Total PnL</th>
          <th>Volume 24h</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody id="pairs-body">
        <tr><td colspan="8" style="color:var(--dim);text-align:center">–</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Opportunities</h2>
      <div class="section-controls">
        <select class="filter" id="opp-pair-filter"><option value="">All routes</option></select>
        <select class="filter" id="opp-status-filter">
          <option value="all">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Pair</th><th>Direction</th>
          <th>Open Spread</th><th>Peak Spread</th>
          <th>Est. PnL</th><th>Duration</th><th>Time</th><th>Status</th>
        </tr>
      </thead>
      <tbody id="opps-body">
        <tr><td colspan="9" style="color:var(--dim);text-align:center">–</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Detail panel -->
<div id="detail-overlay"></div>
<div id="detail-panel">
  <div class="detail-header">
    <div>
      <h2 id="dp-title">–</h2>
      <div class="sub" id="dp-sub">–</div>
    </div>
    <button class="detail-close" id="detail-close">×</button>
  </div>
  <div class="detail-grid">
    <div class="detail-field"><div class="label">Open Spread</div><div class="value" id="dp-spread">–</div></div>
    <div class="detail-field"><div class="label">Peak Spread</div><div class="value" id="dp-peak">–</div></div>
    <div class="detail-field"><div class="label">Est. PnL</div><div class="value" id="dp-pnl">–</div></div>
    <div class="detail-field"><div class="label">Opened</div><div class="value" id="dp-opened">–</div></div>
    <div class="detail-field"><div class="label">Duration</div><div class="value" id="dp-duration">–</div></div>
    <div class="detail-field"><div class="label">Close Reason</div><div class="value" id="dp-reason">–</div></div>
  </div>
  <div class="detail-section-title">Spread over time</div>
  <div class="sparkline-wrap">
    <div id="dp-sparkline"></div>
    <div class="sparkline-legend">
      <span><svg width="16" height="2"><line x1="0" y1="1" x2="16" y2="1" stroke="#89b4fa" stroke-width="1.5"/></svg> net spread</span>
      <span><svg width="16" height="2"><line x1="0" y1="1" x2="16" y2="1" stroke="#f9e2af" stroke-width="1" stroke-dasharray="3,3"/></svg> 0.15% threshold</span>
    </div>
  </div>
</div>

<script>
  const fmtPct  = v => v == null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(4) + '%'
  const fmtUsdt = v => v == null ? '–' : '$' + v.toFixed(4)
  const fmtVol = v => {
    if (!v) return '–'
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K'
    return '$' + v.toFixed(0)
  }
  // volumes already sorted smallest-first by server
  const fmtVolumes = vols => {
    if (!vols || vols.length === 0) return '–'
    if (vols.length === 1) return fmtVol(vols[0].volume_24h_usdt)
    return fmtVol(vols[0].volume_24h_usdt) + ' / ' + fmtVol(vols[1].volume_24h_usdt)
  }
  const fmtDur = ms => {
    if (ms == null) return '–'
    if (ms < 1000)  return ms.toFixed(0) + 'ms'
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
    return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
  }
  const fmtDurRange = (durationMs, openResolutionMs) => {
    if (durationMs == null) return '–'
    if (openResolutionMs == null || openResolutionMs <= 500) return fmtDur(durationMs)
    return fmtDur(durationMs) + ' – ' + fmtDur(durationMs + openResolutionMs)
  }
  const fmtAgo = ms => {
    if (ms == null) return '–'
    const d = Date.now() - ms
    if (d < 60000)   return Math.floor(d / 1000) + 's ago'
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago'
    return Math.floor(d / 3600000) + 'h ago'
  }
  const fmtTs  = ms => ms ? new Date(ms).toLocaleTimeString() : '–'
  const esc    = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')

  function spreadClass(v) {
    if (v > 0.05) return 'spread-pos'
    if (v < 0)    return 'spread-neg'
    return 'spread-neu'
  }
  function statusPill(lastSeenMs) {
    if (!lastSeenMs) return ['waiting', 'WAITING']
    const age = Date.now() - lastSeenMs
    if (age < 15000)  return ['live',    'LIVE']
    if (age < 60000)  return ['stale',   'STALE']
    return ['offline', 'OFFLINE']
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let currentData    = null   // from /api/snapshot
  let allPairsData   = null   // from /api/pairs (loaded on demand)
  let showAllPairs   = false
  let pairsSort      = 'spread'
  let pairsSearch    = ''
  const PAIRS_DEFAULT_LIMIT = 8
  let pairsLimit     = PAIRS_DEFAULT_LIMIT

  // ── Pairs rendering ────────────────────────────────────────────────────────
  function sortPairs(pairs) {
    const copy = [...pairs]
    if (pairsSort === 'volume') copy.sort((a, b) => b.min_volume_usdt - a.min_volume_usdt || b.is_monitored - a.is_monitored)
    else if (pairsSort === 'spread') copy.sort((a, b) => ((b.net_spread_pct ?? -Infinity) - (a.net_spread_pct ?? -Infinity)) || b.is_monitored - a.is_monitored)
    else if (pairsSort === 'pnl')    copy.sort((a, b) => b.total_pnl_usdt - a.total_pnl_usdt  || b.is_monitored - a.is_monitored)
    else copy.sort((a, b) => b.is_monitored - a.is_monitored || b.opp_count - a.opp_count || b.best_spread_pct - a.best_spread_pct)
    return copy
  }

  function renderPairs(pairs) {
    const body = document.getElementById('pairs-body')
    let rows = pairs || []
    if (pairsSearch) {
      const q = pairsSearch.toUpperCase()
      rows = rows.filter(p => p.symbol.includes(q))
    }
    rows = sortPairs(rows)

    if (rows.length === 0) {
      body.innerHTML = \`<tr><td colspan="8" style="color:var(--dim);text-align:center">No routes</td></tr>\`
      return
    }
    // Apply limit only when not searching (search shows all matches)
    const limited = !pairsSearch && rows.length > pairsLimit
    const visible = limited ? rows.slice(0, pairsLimit) : rows
    const expandRow = limited
      ? \`<tr id="pairs-expand-row">
          <td colspan="8" style="text-align:center;padding:10px">
            <button class="toggle-btn" id="pairs-expand-btn">
              Show all \${rows.length} routes
            </button>
            <span style="color:var(--dim);font-size:11px;margin-left:8px">showing \${pairsLimit} of \${rows.length}</span>
          </td>
        </tr>\`
      : ''
    const lf = currentData?.liquidityFlag
    const renderRow = p => {
      const dot = p.is_monitored ? '<span class="monitored-dot">●</span>' : ''
      const dir = p.exchange_buy ? \`\${esc(p.exchange_buy)} <span class="arrow">→</span> \${esc(p.exchange_sell)}\` : '<span style="color:var(--dim)">–</span>'
      const spread = p.net_spread_pct != null && p.is_monitored
        ? \`<span class="\${spreadClass(p.net_spread_pct)}">\${fmtPct(p.net_spread_pct)}</span>\`
        : '<span style="color:var(--dim)">–</span>'
      const bestSpread = p.best_spread_pct > 0 ? \`<span class="\${spreadClass(p.best_spread_pct)}">\${fmtPct(p.best_spread_pct)}</span>\` : '<span style="color:var(--dim)">–</span>'
      const pnl  = p.total_pnl_usdt > 0  ? \`<span class="spread-pos">\${fmtUsdt(p.total_pnl_usdt)}</span>\` : '<span style="color:var(--dim)">–</span>'
      const seen = p.fetched_at_ms ? fmtAgo(p.fetched_at_ms) : '–'
      const lowLiq = lf && p.min_volume_usdt > 0 && (lf.capitalUsdt / p.min_volume_usdt * 100) > lf.thresholdPct
      return \`<tr class="\${p.is_monitored ? '' : 'unmonitored'}\${lowLiq ? ' low-liquidity' : ''}">
        <td>\${dot}<span class="pair-link" data-pair="\${esc(p.symbol)}">\${esc(p.symbol)}</span></td>
        <td>\${dir}</td>
        <td>\${spread}</td>
        <td style="color:var(--blue)">\${p.opp_count || '–'}</td>
        <td>\${bestSpread}</td>
        <td>\${pnl}</td>
        <td>\${fmtVolumes(p.volumes)}</td>
        <td style="color:var(--dim)">\${seen}</td>
      </tr>\`
    }
    body.innerHTML = visible.map(renderRow).join('') + expandRow
    if (limited) {
      document.getElementById('pairs-expand-btn').addEventListener('click', () => {
        pairsLimit = Infinity
        renderPairs(activePairs())
      })
    }
  }

  function activePairs() {
    if (!showAllPairs) return currentData?.pairs || []
    // In "Show all" mode: use fresh monitored pairs from live snapshot,
    // merged with cached unmonitored pairs from /api/pairs.
    // This prevents stale green-dot data when the detector stops writing.
    const monitored = currentData?.pairs || []
    const monitoredSymbols = new Set(monitored.map(p => p.symbol))
    const unmonitored = (allPairsData || []).filter(p => !monitoredSymbols.has(p.symbol))
    return [...monitored, ...unmonitored]
  }

  // ── Opportunities rendering ────────────────────────────────────────────────
  function renderOpps(opps) {
    const pairFilter   = document.getElementById('opp-pair-filter').value
    const statusFilter = document.getElementById('opp-status-filter').value
    const body = document.getElementById('opps-body')
    let rows = opps || []
    if (pairFilter)                rows = rows.filter(o => o.pair === pairFilter)
    if (statusFilter === 'open')   rows = rows.filter(o => !o.close_reason)
    if (statusFilter === 'closed') rows = rows.filter(o =>  o.close_reason)
    if (rows.length === 0) {
      body.innerHTML = \`<tr><td colspan="9" style="color:var(--dim);text-align:center">No opportunities</td></tr>\`
      return
    }
    body.innerHTML = rows.map(o => {
      const isOpen = !o.close_reason
      const tag = isOpen
        ? '<span class="tag open">OPEN</span>'
        : o.close_reason === 'CONVERGENCE'
          ? '<span class="tag conv">CONV</span>'
          : '<span class="tag err">ERR</span>'
      const timeMs = isOpen ? o.opened_at_ms : o.closed_at_ms
      return \`<tr class="clickable" data-opp-id="\${esc(o.id)}">
        <td style="color:var(--dim);font-size:10px">\${esc(o.id)}</td>
        <td>\${esc(o.pair)}</td>
        <td>\${esc(o.exchange_buy)} <span class="arrow">→</span> \${esc(o.exchange_sell)}</td>
        <td class="\${spreadClass(o.net_spread_pct)}">\${fmtPct(o.net_spread_pct)}</td>
        <td class="\${spreadClass(o.peak_spread_pct)}">\${fmtPct(o.peak_spread_pct)}</td>
        <td class="spread-pos">\${fmtUsdt(o.estimated_pnl_usdt)}</td>
        <td>\${isOpen ? fmtDur(Date.now() - o.opened_at_ms) : fmtDurRange(o.duration_ms, o.open_resolution_ms)}</td>
        <td style="color:var(--dim)">\${fmtAgo(timeMs)}</td>
        <td>\${tag}</td>
      </tr>\`
    }).join('')
  }

  function updatePairFilterOptions(opps) {
    const sel = document.getElementById('opp-pair-filter')
    const current = sel.value
    const pairs = [...new Set((opps || []).map(o => o.pair))].sort()
    sel.innerHTML = '<option value="">All routes</option>' +
      pairs.map(p => \`<option value="\${esc(p)}" \${p === current ? 'selected' : ''}>\${esc(p)}</option>\`).join('')
  }

  // ── Sparkline ──────────────────────────────────────────────────────────────
  function renderSparkline(ticks) {
    if (!ticks || ticks.length < 2)
      return '<div style="color:var(--dim);text-align:center;padding:16px 0;font-size:11px">No tick data</div>'
    const W = 400, H = 80, PAD = 6
    const vals  = ticks.map(t => t.net_spread_pct)
    const times = ticks.map(t => t.fetched_at_ms)
    const minT = times[0], maxT = times[times.length - 1]
    const THRESHOLD = 0.15
    const minV = Math.min(...vals, 0)
    const maxV = Math.max(...vals, THRESHOLD + 0.05)
    const rangeV = maxV - minV || 0.001
    const rangeT = maxT - minT || 1
    const px = t => PAD + (t - minT) / rangeT * (W - 2 * PAD)
    const py = v => H - PAD - (v - minV) / rangeV * (H - 2 * PAD)
    const points = ticks.map(t => \`\${px(t.fetched_at_ms).toFixed(1)},\${py(t.net_spread_pct).toFixed(1)}\`).join(' ')
    const threshY = py(THRESHOLD).toFixed(1)
    const zeroY   = py(0).toFixed(1)
    return \`<svg viewBox="0 0 \${W} \${H}" style="width:100%;height:80px;display:block" preserveAspectRatio="none">
      <line x1="\${PAD}" y1="\${zeroY}" x2="\${W-PAD}" y2="\${zeroY}" stroke="#6c7086" stroke-width="0.5" opacity="0.4"/>
      <line x1="\${PAD}" y1="\${threshY}" x2="\${W-PAD}" y2="\${threshY}" stroke="#f9e2af" stroke-width="0.8" stroke-dasharray="4,4" opacity="0.6"/>
      <polyline points="\${points}" fill="none" stroke="#89b4fa" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>\`
  }

  // ── Detail panel ───────────────────────────────────────────────────────────
  async function openDetailPanel(oppId) {
    let detail
    try {
      const r = await fetch(\`/api/opportunity/\${encodeURIComponent(oppId)}\`)
      detail = await r.json()
    } catch { return }
    if (!detail || detail.error) return
    const o = detail.opp
    document.getElementById('dp-title').textContent    = o.pair
    document.getElementById('dp-sub').textContent      = o.exchange_buy + ' → ' + o.exchange_sell + '  ·  ' + o.id
    document.getElementById('dp-spread').textContent   = fmtPct(o.net_spread_pct)
    document.getElementById('dp-spread').className     = 'value ' + spreadClass(o.net_spread_pct)
    document.getElementById('dp-peak').textContent     = fmtPct(o.peak_spread_pct)
    document.getElementById('dp-peak').className       = 'value ' + spreadClass(o.peak_spread_pct)
    document.getElementById('dp-pnl').textContent      = fmtUsdt(o.estimated_pnl_usdt)
    document.getElementById('dp-pnl').className        = 'value spread-pos'
    document.getElementById('dp-opened').textContent   = fmtTs(o.opened_at_ms)
    document.getElementById('dp-duration').textContent = o.duration_ms != null
      ? fmtDurRange(o.duration_ms, o.open_resolution_ms) : fmtDur(Date.now() - o.opened_at_ms) + ' (open)'
    document.getElementById('dp-reason').textContent   = o.close_reason ?? 'OPEN'
    document.getElementById('dp-reason').style.color   = o.close_reason === 'CONVERGENCE'
      ? 'var(--green)' : o.close_reason ? 'var(--red)' : 'var(--yellow)'
    document.getElementById('dp-sparkline').innerHTML  = renderSparkline(detail.ticks)
    document.getElementById('detail-panel').classList.add('open')
    document.getElementById('detail-overlay').classList.add('open')
  }

  function closeDetailPanel() {
    document.getElementById('detail-panel').classList.remove('open')
    document.getElementById('detail-overlay').classList.remove('open')
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function renderAll(data) {
    const s = data.stats
    document.getElementById('stat-total').textContent     = s.total_count
    document.getElementById('stat-total-pnl').textContent = fmtUsdt(s.total_pnl)
    document.getElementById('stat-avg-pnl').textContent   = s.total_count > 0 ? fmtUsdt(s.avg_pnl) : '–'
    document.getElementById('stat-avg-dur').textContent   = s.total_count > 0 ? fmtDur(s.avg_duration_ms) : '–'

    const openOpp = (data.opportunities || []).find(o => !o.close_reason) ?? null
    const ooSection = document.getElementById('open-opp-section')
    if (openOpp) {
      ooSection.style.display = 'block'
      document.getElementById('oo-pair').textContent      = openOpp.pair
      document.getElementById('oo-direction').textContent = openOpp.exchange_buy + ' → ' + openOpp.exchange_sell
      document.getElementById('oo-spread').textContent    = fmtPct(openOpp.net_spread_pct)
      document.getElementById('oo-pnl').textContent       = fmtUsdt(openOpp.estimated_pnl_usdt)
      document.getElementById('oo-age').textContent       = fmtDur(Date.now() - openOpp.opened_at_ms)
    } else {
      ooSection.style.display = 'none'
    }

    renderPairs(activePairs())
    updatePairFilterOptions(data.opportunities)
    renderOpps(data.opportunities)
  }

  // ── Fetch loop ─────────────────────────────────────────────────────────────
  async function fetchSnapshot() {
    let data
    try { data = await (await fetch('/api/snapshot')).json() } catch { return }

    const noData = document.getElementById('no-data')
    const main   = document.getElementById('main-content')
    if (!data || data.error) {
      noData.style.display = 'block'
      main.style.display   = 'none'
      document.getElementById('status-pill').className   = 'pill waiting'
      document.getElementById('status-pill').textContent = 'WAITING'
      return
    }
    noData.style.display = 'none'
    main.style.display   = 'block'

    const [cls, label] = statusPill(data.stats.last_seen_ms)
    const pill = document.getElementById('status-pill')
    pill.className   = 'pill ' + cls
    pill.textContent = label
    document.getElementById('last-updated').textContent = 'updated ' + new Date().toLocaleTimeString()

    currentData = data
    renderAll(data)
  }

  async function fetchAllPairs() {
    const btn = document.getElementById('pairs-scope-btn')
    btn.textContent = 'Loading…'
    btn.disabled = true
    try {
      allPairsData = await (await fetch('/api/pairs')).json()
    } catch { allPairsData = null }
    btn.disabled = false
    showAllPairs = !!allPairsData
    btn.textContent = showAllPairs ? 'Monitored only' : 'Show all routes'
    btn.classList.toggle('active', showAllPairs)
    renderPairs(activePairs())
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  document.getElementById('pairs-sort').addEventListener('change', e => {
    pairsSort = e.target.value
    pairsLimit = PAIRS_DEFAULT_LIMIT
    renderPairs(activePairs())
  })

  document.getElementById('pairs-search').addEventListener('input', e => {
    pairsSearch = e.target.value.trim()
    renderPairs(activePairs())
  })

  document.getElementById('pairs-scope-btn').addEventListener('click', () => {
    pairsLimit = PAIRS_DEFAULT_LIMIT
    if (!showAllPairs) {
      fetchAllPairs()
    } else {
      showAllPairs = false
      allPairsData = null
      const btn = document.getElementById('pairs-scope-btn')
      btn.textContent = 'Show all routes'
      btn.classList.remove('active')
      renderPairs(activePairs())
    }
  })

  document.getElementById('opp-pair-filter').addEventListener('change', () => {
    if (currentData) renderOpps(currentData.opportunities)
  })
  document.getElementById('opp-status-filter').addEventListener('change', () => {
    if (currentData) renderOpps(currentData.opportunities)
  })

  document.getElementById('opps-body').addEventListener('click', e => {
    const row = e.target.closest('tr[data-opp-id]')
    if (row) openDetailPanel(row.dataset.oppId)
  })

  document.getElementById('pairs-body').addEventListener('click', e => {
    const link = e.target.closest('.pair-link')
    if (!link) return
    const pair = link.dataset.pair
    const sel = document.getElementById('opp-pair-filter')
    sel.value = sel.value === pair ? '' : pair
    if (currentData) renderOpps(currentData.opportunities)
    document.querySelector('#opps-body').closest('.section').scrollIntoView({ behavior: 'smooth' })
  })

  document.getElementById('detail-close').addEventListener('click', closeDetailPanel)
  document.getElementById('detail-overlay').addEventListener('click', closeDetailPanel)

  fetchSnapshot()
  setInterval(fetchSnapshot, 2000)
</script>
</body>
</html>`
}

// ── Server ────────────────────────────────────────────────────────────────────

const { dbPath, port } = parseArgs(process.argv.slice(2))

const app = express()

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(buildHtml())
})

app.get('/api/snapshot', (_req, res) => {
  try {
    const snapshot = querySnapshot(dbPath)
    if (!snapshot) { res.status(503).json({ error: 'Database not available yet' }); return }
    res.json(snapshot)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/pairs', (req, res) => {
  const db = openDb(dbPath)
  if (!db) { res.status(503).json({ error: 'Database not available yet' }); return }
  try {
    let rows = queryAllPairs(db) as any[]

    const q    = typeof req.query.q    === 'string' ? req.query.q.toUpperCase()    : ''
    const sort = typeof req.query.sort === 'string' ? req.query.sort : ''
    if (q) rows = rows.filter((r: any) => r.symbol.includes(q))
    if (sort === 'volume') rows.sort((a: any, b: any) => b.min_volume_usdt - a.min_volume_usdt)
    else if (sort === 'spread') rows.sort((a: any, b: any) => b.best_spread_pct - a.best_spread_pct)
    else if (sort === 'pnl')    rows.sort((a: any, b: any) => b.total_pnl_usdt - a.total_pnl_usdt)
    else if (sort === 'opps')   rows.sort((a: any, b: any) => b.opp_count - a.opp_count)

    res.json(rows)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  } finally {
    db.close()
  }
})

app.get('/api/opportunity/:id', (req, res) => {
  try {
    const detail = queryOpportunity(dbPath, req.params.id)
    if (!detail) { res.status(404).json({ error: 'Not found' }); return }
    res.json(detail)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`)
  console.log(`Reading DB: ${dbPath}`)
})
