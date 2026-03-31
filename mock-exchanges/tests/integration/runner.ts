import { spawn, ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { runBaseline } from './suites/suite_baseline'
import { runScenarios } from './suites/suite_scenarios'
import { runHoldout } from './suites/suite_holdout'
import { runSpreadInversion } from './suites/suite_spread_inversion'

const MODULE_ROOT = path.resolve(__dirname, '../..')
const WORKSPACE   = MODULE_ROOT
const BASE        = 'http://localhost:3000'

async function waitForServer(timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { await fetch(`${BASE}/scenario/status`); return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('Server did not become ready within timeout')
}

async function main() {
  const server: ChildProcess = spawn('npx', ['ts-node', 'server.ts'], {
    cwd: WORKSPACE,
    stdio: 'pipe',
  })
  server.on('error', e => { console.error('Server failed:', e); process.exit(1) })

  await waitForServer()

  let pass = 0, fail = 0
  const add = (r: { pass: number; fail: number }) => { pass += r.pass; fail += r.fail }

  add(await runBaseline(BASE))
  add(await runScenarios(BASE))
  add(await runHoldout(BASE))
  add(await runSpreadInversion(BASE))

  server.kill()
  await new Promise(r => setTimeout(r, 200))

  const total = pass + fail
  const score = total > 0 ? Math.round((pass / total) * 100) : 0
  console.log(`\nResults: ${pass}/${total} passed  —  Score: ${score}/100`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
