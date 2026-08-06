import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  cloneKarelWorld,
  parseKarelWorld,
  serializeKarelWorld,
} from '../../src'

describe('Karel world model', () => {
  it('normalizes and round-trips the bundled world', () => {
    const clone = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    expect(clone).toEqual(DEFAULT_KAREL_WORLD)
    expect(clone).not.toBe(DEFAULT_KAREL_WORLD)
    expect(parseKarelWorld(JSON.parse(serializeKarelWorld(clone)))).toEqual(clone)
  })

  it('accepts finite and infinite beeper bags', () => {
    const finite = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    finite.karel.beepersInBag = 0
    expect(parseKarelWorld(finite).karel.beepersInBag).toBe(0)
    finite.karel.beepersInBag = 'infinite'
    expect(parseKarelWorld(finite).karel.beepersInBag).toBe('infinite')
  })

  it('rejects out-of-bounds and oversized runtime worlds', () => {
    const outOfBounds = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    outOfBounds.karel.avenue = outOfBounds.columns + 1
    expect(() => parseKarelWorld(outOfBounds)).toThrow('outside')

    const oversized = { ...DEFAULT_KAREL_WORLD, columns: 101 }
    expect(() => parseKarelWorld(oversized)).toThrow('cannot exceed')
  })

  it('rejects invalid directions and unsafe beeper counts', () => {
    expect(() =>
      parseKarelWorld({
        ...DEFAULT_KAREL_WORLD,
        karel: { ...DEFAULT_KAREL_WORLD.karel, direction: 'up' },
      }),
    ).toThrow('north, east, south, or west')

    expect(() =>
      parseKarelWorld({
        ...DEFAULT_KAREL_WORLD,
        beepers: [{ avenue: 1, street: 1, count: 0 }],
      }),
    ).toThrow('greater than or equal to 1')
  })

  it('rejects active CSS values in runtime-provided corner colors', () => {
    expect(() =>
      parseKarelWorld({
        ...DEFAULT_KAREL_WORLD,
        colors: [{ avenue: 1, street: 1, color: 'url(https://example.test)' }],
      }),
    ).toThrow('named color')
  })
})
