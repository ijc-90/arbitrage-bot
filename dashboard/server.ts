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

function querySnapshot(dbPath: string) {
  const db = openDb(dbPath)
  if (!db) return null

  try {
    const openOpp = db.prepare(`
      SELECT * FROM opportunities WHERE close_reason IS NULL LIMIT 1
    `).get()

    const recentOpps = db.prepare(`
      SELECT * FROM opportunities
      WHERE close_reason IS NOT NULL
      ORDER BY closed_at_ms DESC
      LIMIT 20
    `).all()

    const latestPrices = db.prepare(`
      SELECT * FROM prices
      WHERE id IN (SELECT MAX(id) FROM prices GROUP BY pair)
      ORDER BY pair
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

    return {
      open_opportunity: openOpp ?? null,
      recent_opportunities: recentOpps,
      latest_prices: latestPrices,
      stats: { ...stats, last_seen_ms: lastSeen?.ts ?? null },
    }
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
  .pill.live   { background: #1a2f1a; color: var(--green); }
  .pill.stale  { background: #2f2a1a; color: var(--yellow); }
  .pill.offline{ background: #2f1a1a; color: var(--red); }
  .pill.waiting{ background: #1a1a2f; color: var(--dim); }
  .last-updated { margin-left: auto; color: var(--dim); font-size: 11px; }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
  }
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
  .open-opp-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
  }
  .open-opp-field .label { color: var(--dim); font-size: 11px; }
  .open-opp-field .value { font-size: 15px; font-weight: 600; margin-top: 2px; }

  .section { margin-bottom: 20px; }
  .section h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--dim);
    margin-bottom: 8px;
  }

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
  td {
    padding: 7px 12px;
    border-bottom: 1px solid #0e0e18;
    font-size: 12px;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1a1a28; }

  .tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
  }
  .tag.conv { background: #1a2f1a; color: var(--green); }
  .tag.err  { background: #2f1a1a; color: var(--red); }
  .tag.open { background: #1a2a1a; color: var(--green); animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }

  .spread-pos { color: var(--green); }
  .spread-neg { color: var(--red); }
  .spread-neu { color: var(--dim); }
  .arrow { color: var(--dim); }

  #no-data {
    display: none;
    text-align: center;
    padding: 60px;
    color: var(--dim);
  }
  #no-data .big { font-size: 32px; margin-bottom: 8px; }
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
      <div class="open-opp-field">
        <div class="label">Pair</div>
        <div class="value" id="oo-pair">–</div>
      </div>
      <div class="open-opp-field">
        <div class="label">Direction</div>
        <div class="value" id="oo-direction">–</div>
      </div>
      <div class="open-opp-field">
        <div class="label">Spread</div>
        <div class="value spread-pos" id="oo-spread">–</div>
      </div>
      <div class="open-opp-field">
        <div class="label">Est. PnL</div>
        <div class="value" id="oo-pnl">–</div>
      </div>
      <div class="open-opp-field">
        <div class="label">Open for</div>
        <div class="value" id="oo-age">–</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Latest Prices</h2>
    <table>
      <thead>
        <tr>
          <th>Pair</th>
          <th>Direction</th>
          <th>Net Spread</th>
          <th>Fetched</th>
        </tr>
      </thead>
      <tbody id="prices-body">
        <tr><td colspan="4" style="color:var(--dim);text-align:center">–</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section">
    <h2>Recent Opportunities</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Pair</th>
          <th>Direction</th>
          <th>Open Spread</th>
          <th>Peak Spread</th>
          <th>Est. PnL</th>
          <th>Duration</th>
          <th>Closed</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="opps-body">
        <tr><td colspan="9" style="color:var(--dim);text-align:center">–</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
  const fmtPct  = v => (v >= 0 ? '+' : '') + v.toFixed(4) + '%'
  const fmtUsdt = v => '$' + v.toFixed(4)
  const fmtDur  = ms => {
    if (ms == null) return '–'
    if (ms < 1000)  return ms.toFixed(0) + 'ms'
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
    return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's'
  }
  const fmtAgo = ms => {
    if (ms == null) return '–'
    const d = Date.now() - ms
    if (d < 60000)  return Math.floor(d / 1000) + 's ago'
    return Math.floor(d / 60000) + 'm ago'
  }
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')

  function spreadClass(v) {
    if (v > 0.05)  return 'spread-pos'
    if (v < 0)     return 'spread-neg'
    return 'spread-neu'
  }

  function statusPill(lastSeenMs) {
    if (!lastSeenMs) return ['waiting', 'WAITING']
    const age = Date.now() - lastSeenMs
    if (age < 15000)  return ['live',    'LIVE']
    if (age < 60000)  return ['stale',   'STALE']
    return ['offline', 'OFFLINE']
  }

  async function fetchSnapshot() {
    let data
    try {
      const r = await fetch('/api/snapshot')
      data = await r.json()
    } catch { return }

    const noData  = document.getElementById('no-data')
    const main    = document.getElementById('main-content')

    if (!data || data.error) {
      noData.style.display = 'block'
      main.style.display   = 'none'
      document.getElementById('status-pill').className = 'pill waiting'
      document.getElementById('status-pill').textContent = 'WAITING'
      return
    }

    noData.style.display = 'none'
    main.style.display   = 'block'

    // Status pill
    const [cls, label] = statusPill(data.stats.last_seen_ms)
    const pill = document.getElementById('status-pill')
    pill.className   = 'pill ' + cls
    pill.textContent = label

    document.getElementById('last-updated').textContent =
      'updated ' + new Date().toLocaleTimeString()

    // Stats
    const s = data.stats
    document.getElementById('stat-total').textContent     = s.total_count
    document.getElementById('stat-total-pnl').textContent = fmtUsdt(s.total_pnl)
    document.getElementById('stat-avg-pnl').textContent   = s.total_count > 0 ? fmtUsdt(s.avg_pnl) : '–'
    document.getElementById('stat-avg-dur').textContent   = s.total_count > 0 ? fmtDur(s.avg_duration_ms) : '–'

    // Open opportunity
    const ooSection = document.getElementById('open-opp-section')
    if (data.open_opportunity) {
      const oo = data.open_opportunity
      ooSection.style.display = 'block'
      document.getElementById('oo-pair').textContent      = oo.pair
      document.getElementById('oo-direction').textContent = oo.exchange_buy + ' → ' + oo.exchange_sell
      document.getElementById('oo-spread').textContent    = fmtPct(oo.net_spread_pct)
      document.getElementById('oo-pnl').textContent       = fmtUsdt(oo.estimated_pnl_usdt)
      document.getElementById('oo-age').textContent       = fmtDur(Date.now() - oo.opened_at_ms)
    } else {
      ooSection.style.display = 'none'
    }

    // Prices
    const pricesBody = document.getElementById('prices-body')
    if (data.latest_prices.length === 0) {
      pricesBody.innerHTML = '<tr><td colspan="4" style="color:var(--dim);text-align:center">No prices yet</td></tr>'
    } else {
      pricesBody.innerHTML = data.latest_prices.map(p => \`
        <tr>
          <td>\${esc(p.pair)}</td>
          <td>\${esc(p.exchange_buy)} <span class="arrow">→</span> \${esc(p.exchange_sell)}</td>
          <td class="\${spreadClass(p.net_spread_pct)}">\${fmtPct(p.net_spread_pct)}</td>
          <td style="color:var(--dim)">\${fmtAgo(p.fetched_at_ms)}</td>
        </tr>
      \`).join('')
    }

    // Recent opportunities
    const oppsBody = document.getElementById('opps-body')
    if (data.recent_opportunities.length === 0) {
      oppsBody.innerHTML = '<tr><td colspan="9" style="color:var(--dim);text-align:center">No closed opportunities yet</td></tr>'
    } else {
      oppsBody.innerHTML = data.recent_opportunities.map(o => {
        const tag = o.close_reason === 'CONVERGENCE'
          ? '<span class="tag conv">CONV</span>'
          : '<span class="tag err">ERR</span>'
        return \`
          <tr>
            <td style="color:var(--dim)">\${esc(o.id)}</td>
            <td>\${esc(o.pair)}</td>
            <td>\${esc(o.exchange_buy)} <span class="arrow">→</span> \${esc(o.exchange_sell)}</td>
            <td class="\${spreadClass(o.net_spread_pct)}">\${fmtPct(o.net_spread_pct)}</td>
            <td class="\${spreadClass(o.peak_spread_pct)}">\${fmtPct(o.peak_spread_pct)}</td>
            <td class="spread-pos">\${fmtUsdt(o.estimated_pnl_usdt)}</td>
            <td>\${fmtDur(o.duration_ms)}</td>
            <td style="color:var(--dim)">\${fmtAgo(o.closed_at_ms)}</td>
            <td>\${tag}</td>
          </tr>
        \`
      }).join('')
    }
  }

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

app.get('/api/snapshot', (req, res) => {
  try {
    const snapshot = querySnapshot(dbPath)
    if (!snapshot) {
      res.status(503).json({ error: 'Database not available yet' })
      return
    }
    res.json(snapshot)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`)
  console.log(`Reading DB: ${dbPath}`)
})
