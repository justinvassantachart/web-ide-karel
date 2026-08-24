import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EXPECTED_KAREL_ICON_SHA256 =
  '7650ed9c8dfcbb118c826762260b6bfb57507833ab3a2dd87d9a816f61a2aebb'

describe('Karel presentation asset', () => {
  it('retains the exact owner-authorized pixel-art icon bytes', () => {
    const icon = readFileSync(
      new URL('../../src/assets/karel.png', import.meta.url),
    )
    expect(icon.byteLength).toBe(3_897)
    expect(createHash('sha256').update(icon).digest('hex')).toBe(
      EXPECTED_KAREL_ICON_SHA256,
    )
  })
})
