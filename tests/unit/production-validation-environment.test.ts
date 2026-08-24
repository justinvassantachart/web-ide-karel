import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = path.resolve(
  process.cwd(),
  'scripts/check-production-validation-environment.mjs',
)

describe('production validation environment', () => {
  it('accepts only an unfiltered packed-production matrix', () => {
    const completeEnvironment = { ...process.env }
    delete completeEnvironment.KAREL_PRODUCTION_DIAGNOSTIC_GREP
    const complete = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: completeEnvironment,
    })
    expect(complete.status).toBe(0)
    expect(complete.stdout).toContain('complete matrix')

    const filtered = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...completeEnvironment,
        KAREL_PRODUCTION_DIAGNOSTIC_GREP: 'nested source',
      },
    })
    expect(filtered.status).toBe(1)
    expect(filtered.stderr).toContain('must be unset')
  })
})
