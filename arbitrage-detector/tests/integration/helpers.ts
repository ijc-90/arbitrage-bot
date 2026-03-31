import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

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

// Read JSONL file, return parsed lines
export function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
}

// Clear logs dir before each test run
export function clearLogs(logsDir: string): void {
  if (fs.existsSync(logsDir)) {
    fs.rmSync(logsDir, { recursive: true })
  }
  fs.mkdirSync(logsDir, { recursive: true })
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const post = (url: string) =>
  fetch(url, { method: 'POST' }).then(r => r.text())
