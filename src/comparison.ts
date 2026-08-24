import type {
  KarelBeeperBag,
  KarelBeeperPile,
  KarelCornerColor,
  KarelDirection,
  KarelLocation,
  KarelWall,
  KarelWorld,
} from './types'
import { cloneKarelWorld } from './world'

export const KAREL_COMPARISON_AUTHORITY = 'formative-only' as const

export type KarelFinalStateAspect =
  | 'dimensions'
  | 'position'
  | 'direction'
  | 'beeper-bag'
  | 'beepers'
  | 'walls'
  | 'colors'
  | 'completion'

export type KarelFinalStateValue =
  | boolean
  | KarelBeeperBag
  | KarelDirection
  | Readonly<KarelLocation>
  | Readonly<{ columns: number; rows: number }>
  | readonly Readonly<KarelBeeperPile>[]
  | readonly Readonly<KarelWall>[]
  | readonly Readonly<KarelCornerColor>[]

export interface KarelFinalStateDifference {
  aspect: KarelFinalStateAspect
  expected: KarelFinalStateValue
  actual: KarelFinalStateValue
}

export interface KarelCompletionComparison {
  expected: boolean
  actual: boolean
}

export interface KarelFinalStateComparisonOptions {
  /** Optional because a world comparison does not infer runtime completion. */
  completion?: KarelCompletionComparison
}

export interface KarelFinalStateComparisonResult {
  /** Explicitly prevents callers from presenting browser evidence as a grade. */
  authority: typeof KAREL_COMPARISON_AUTHORITY
  matches: boolean
  comparedAspects: readonly KarelFinalStateAspect[]
  differences: readonly Readonly<KarelFinalStateDifference>[]
}

const STATE_ASPECTS = Object.freeze([
  'dimensions',
  'position',
  'direction',
  'beeper-bag',
  'beepers',
  'walls',
  'colors',
] as const satisfies readonly KarelFinalStateAspect[])

function compareLocation(left: KarelLocation, right: KarelLocation): number {
  return left.avenue - right.avenue || left.street - right.street
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalBeepers(world: KarelWorld): readonly Readonly<KarelBeeperPile>[] {
  return Object.freeze(
    world.beepers
      .map((pile) => Object.freeze({ ...pile }))
      .sort((left, right) => compareLocation(left, right) || left.count - right.count),
  )
}

function canonicalWalls(world: KarelWorld): readonly Readonly<KarelWall>[] {
  return Object.freeze(
    world.walls
      .map((wall) => Object.freeze({ ...wall }))
      .sort(
        (left, right) =>
          compareLocation(left, right) || compareText(left.direction, right.direction),
      ),
  )
}

function canonicalColors(world: KarelWorld): readonly Readonly<KarelCornerColor>[] {
  return Object.freeze(
    world.colors
      .map((color) => Object.freeze({ ...color }))
      .sort(
        (left, right) =>
          compareLocation(left, right) || compareText(left.color, right.color),
      ),
  )
}

function same(left: KarelFinalStateValue, right: KarelFinalStateValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function addDifference(
  differences: Readonly<KarelFinalStateDifference>[],
  aspect: KarelFinalStateAspect,
  expected: KarelFinalStateValue,
  actual: KarelFinalStateValue,
): void {
  if (!same(expected, actual)) {
    differences.push(Object.freeze({ aspect, expected, actual }))
  }
}

/**
 * Compare validated final worlds without scoring, grading, side effects, or
 * host policy. Results are deterministic and advisory/formative only.
 */
export function compareKarelFinalState(
  actualInput: KarelWorld,
  expectedInput: KarelWorld,
  options: KarelFinalStateComparisonOptions = {},
): Readonly<KarelFinalStateComparisonResult> {
  const actual = cloneKarelWorld(actualInput)
  const expected = cloneKarelWorld(expectedInput)
  const differences: Readonly<KarelFinalStateDifference>[] = []
  const expectedDimensions = Object.freeze({
    columns: expected.columns,
    rows: expected.rows,
  })
  const actualDimensions = Object.freeze({
    columns: actual.columns,
    rows: actual.rows,
  })
  const expectedPosition = Object.freeze({
    avenue: expected.karel.avenue,
    street: expected.karel.street,
  })
  const actualPosition = Object.freeze({
    avenue: actual.karel.avenue,
    street: actual.karel.street,
  })

  addDifference(
    differences,
    'dimensions',
    expectedDimensions,
    actualDimensions,
  )
  addDifference(differences, 'position', expectedPosition, actualPosition)
  addDifference(
    differences,
    'direction',
    expected.karel.direction,
    actual.karel.direction,
  )
  addDifference(
    differences,
    'beeper-bag',
    expected.karel.beepersInBag,
    actual.karel.beepersInBag,
  )
  addDifference(
    differences,
    'beepers',
    canonicalBeepers(expected),
    canonicalBeepers(actual),
  )
  addDifference(
    differences,
    'walls',
    canonicalWalls(expected),
    canonicalWalls(actual),
  )
  addDifference(
    differences,
    'colors',
    canonicalColors(expected),
    canonicalColors(actual),
  )

  const comparedAspects: KarelFinalStateAspect[] = [...STATE_ASPECTS]
  if (options.completion !== undefined) {
    comparedAspects.push('completion')
    addDifference(
      differences,
      'completion',
      options.completion.expected,
      options.completion.actual,
    )
  }

  return Object.freeze({
    authority: KAREL_COMPARISON_AUTHORITY,
    matches: differences.length === 0,
    comparedAspects: Object.freeze(comparedAspects),
    differences: Object.freeze(differences),
  })
}
