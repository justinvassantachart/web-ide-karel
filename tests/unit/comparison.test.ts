import { describe, expect, it } from 'vitest'
import { DEFAULT_KAREL_WORLD } from '../../src/assets'
import {
  KAREL_COMPARISON_AUTHORITY,
  compareKarelFinalState,
} from '../../src/comparison'
import { cloneKarelWorld } from '../../src/world'

describe('compareKarelFinalState', () => {
  it('returns stable formative evidence for semantically equal final worlds', () => {
    const expected = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    expected.name = 'Expected state'
    expected.beepers.reverse()
    expected.walls.reverse()
    const actual = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    actual.name = 'Student-selected display name'

    const first = compareKarelFinalState(actual, expected, {
      completion: { actual: true, expected: true },
    })
    const second = compareKarelFinalState(actual, expected, {
      completion: { actual: true, expected: true },
    })

    expect(first).toEqual(second)
    expect(first).toEqual({
      authority: KAREL_COMPARISON_AUTHORITY,
      matches: true,
      comparedAspects: [
        'dimensions',
        'position',
        'direction',
        'beeper-bag',
        'beepers',
        'walls',
        'colors',
        'completion',
      ],
      differences: [],
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.comparedAspects)).toBe(true)
  })

  it('reports every mismatch in a fixed dimension order without a score or grade', () => {
    const expected = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    const actual = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    actual.columns += 1
    actual.karel.avenue = 3
    actual.karel.direction = 'south'
    actual.karel.beepersInBag = 4
    actual.beepers = [{ avenue: 1, street: 1, count: 2 }]
    actual.walls = []
    actual.colors = [{ avenue: 3, street: 3, color: 'red' }]

    const result = compareKarelFinalState(actual, expected, {
      completion: { actual: false, expected: true },
    })

    expect(result.authority).toBe('formative-only')
    expect(result.matches).toBe(false)
    expect(result.differences.map(({ aspect }) => aspect)).toEqual([
      'dimensions',
      'position',
      'direction',
      'beeper-bag',
      'beepers',
      'walls',
      'colors',
      'completion',
    ])
    expect(result).not.toHaveProperty('score')
    expect(result).not.toHaveProperty('grade')
  })

  it('validates and snapshots inputs instead of retaining caller-owned arrays', () => {
    const expected = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    const actual = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    actual.beepers = [...actual.beepers, { avenue: 2, street: 2, count: 3 }]

    const result = compareKarelFinalState(actual, expected)
    const difference = result.differences.find(({ aspect }) => aspect === 'beepers')
    actual.beepers[0]!.count = 99

    expect(difference?.actual).toEqual([
      { avenue: 2, street: 2, count: 3 },
      { avenue: 4, street: 1, count: 1 },
      { avenue: 7, street: 4, count: 2 },
    ])
    expect(Object.isFrozen(difference)).toBe(true)
    expect(Object.isFrozen(difference?.actual)).toBe(true)
  })

  it('does not infer completion when no explicit terminal fact is supplied', () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    const result = compareKarelFinalState(world, world)

    expect(result.matches).toBe(true)
    expect(result.comparedAspects).not.toContain('completion')
  })
})
