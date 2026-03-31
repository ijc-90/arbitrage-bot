export type Results = { pass: number; fail: number }
export const makeResults = (): Results => ({ pass: 0, fail: 0 })

export function check(r: Results, name: string, actual: string, expected: string): void {
  if (actual.includes(expected)) {
    console.log(`PASS [${name}]`)
    r.pass++
  } else {
    console.log(`FAIL [${name}]: expected '${expected}'`)
    console.log(`  got: ${actual.slice(0, 300)}`)
    r.fail++
  }
}

export function checkAbsent(r: Results, name: string, actual: string, absent: string): void {
  if (!actual.includes(absent)) {
    console.log(`PASS [${name}]`)
    r.pass++
  } else {
    console.log(`FAIL [${name}]: should not contain '${absent}'`)
    r.fail++
  }
}

export const get  = (url: string) => fetch(url).then(r => r.text())
export const post = (url: string) => fetch(url, { method: 'POST' }).then(r => r.text())
