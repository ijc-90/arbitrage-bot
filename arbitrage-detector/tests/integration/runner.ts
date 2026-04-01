import { spawn, ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { clearLogs } from './helpers'
import { runUnit } from './suites/suite_unit'
import { runNoOpportunity } from './suites/suite_no_opportunity'
import { runOpportunityOpens } from './suites/suite_opportunity_opens'
import { runHoldout } from './suites/suite_holdout'
import { runBelowFees } from './suites/suite_below_fees'
import { runBelowBuffer } from './suites/suite_below_buffer'
import { runPricesIntersect } from './suites/suite_prices_intersect'
import { runInversion } from './suites/suite_inversion'

const MODULE_ROOT    = path.resolve(__dirname, '../..')
const MOCK_WORKSPACE = path.join(MODULE_ROOT, '../mock-exchanges')
const ARB_WORKSPACE  = MODULE_ROOT
const LOGS_DIR       = path.join(ARB_WORKSPACE, 'logs')
const DB_PATH        = path.join(LOGS_DIR, 'arb.db')
const MOCK_BASE      = 'http://localhost:3000'

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { await fetch(url); return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Server not ready: ${url}`)
}

async function startMock(): Promise<ChildProcess> {
  const server = spawn('npx', ['ts-node', 'server.ts'], {
    cwd: MOCK_WORKSPACE,
    stdio: 'pipe',
  })
  server.on('error', (e: Error) => { console.error('Mock server error:', e); process.exit(1) })
  await waitForServer(`${MOCK_BASE}/scenario/status`)
  return server
}

async function runDetector(scenario: string, steps: number): Promise<void> {
  // Load scenario on mock before starting detector
  await fetch(`${MOCK_BASE}/scenario/load/${scenario}`, { method: 'POST' })

  return new Promise((resolve, reject) => {
    const det = spawn('npx', [
      'ts-node', 'detector.ts',
      '--config', 'config.test.yaml',
      '--steps', String(steps),
      '--advance-url', MOCK_BASE,
      '--db', DB_PATH,
    ], {
      cwd: ARB_WORKSPACE,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'test' },
    })
    det.on('error', reject)
    det.on('close', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`Detector exited with code ${code}`))
    })
  })
}

async function main() {
  const mock = await startMock()

  let pass = 0, fail = 0
  const add = (r: { pass: number; fail: number }) => { pass += r.pass; fail += r.fail }

  // Unit tests — no server needed
  add(await runUnit())

  // Integration tests — each clears logs+db before running
  clearLogs(LOGS_DIR)
  add(await runNoOpportunity(DB_PATH, () => runDetector('scenario_detector_001_no_opportunity', 3)))

  clearLogs(LOGS_DIR)
  add(await runOpportunityOpens(DB_PATH, () => runDetector('scenario_detector_002_opportunity_opens', 3)))

  clearLogs(LOGS_DIR)
  add(await runHoldout(DB_PATH, () => runDetector('scenario_detector_003_holdout', 3)))

  clearLogs(LOGS_DIR)
  add(await runBelowFees(DB_PATH, () => runDetector('scenario_detector_004_below_fees', 3)))

  clearLogs(LOGS_DIR)
  add(await runBelowBuffer(DB_PATH, () => runDetector('scenario_detector_005_below_buffer', 3)))

  clearLogs(LOGS_DIR)
  add(await runPricesIntersect(DB_PATH, () => runDetector('scenario_detector_006_prices_intersect', 3)))

  clearLogs(LOGS_DIR)
  add(await runInversion(DB_PATH, () => runDetector('scenario_detector_007_inversion', 5)))

  mock.kill()
  await new Promise(r => setTimeout(r, 200))

  const total = pass + fail
  const score = total > 0 ? Math.round((pass / total) * 100) : 0
  console.log(`\nResults: ${pass}/${total} passed  —  Score: ${score}/100`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
