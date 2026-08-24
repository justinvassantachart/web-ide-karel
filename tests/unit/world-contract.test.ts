import { describe, expect, it } from 'vitest'
import cases from '../fixtures/world-contract-cases.json'
import {
  KAREL_WORLD_DOCUMENT_SCHEMA,
  KAREL_WORLD_SCHEMA_NAME,
  KAREL_WORLD_SCHEMA_VERSION,
  canonicalizeKarelWorldDocument,
  convertBareKarelWorldToDocument,
  convertStandaloneKarelWorldToDocument,
  parseKarelWorldDocument,
  serializeKarelWorldDocument,
} from '../../src'

function canonicalInput(): Record<string, unknown> {
  return structuredClone(cases.canonicalization.input)
}

describe('portable Karel world v1 contract', () => {
  it('exports an immutable, closed portable JSON Schema', () => {
    expect(KAREL_WORLD_DOCUMENT_SCHEMA).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'version', 'world'],
    })
    expect(KAREL_WORLD_DOCUMENT_SCHEMA.properties.schema.const).toBe(
      KAREL_WORLD_SCHEMA_NAME,
    )
    expect(KAREL_WORLD_DOCUMENT_SCHEMA.properties.version.const).toBe(
      KAREL_WORLD_SCHEMA_VERSION,
    )
    expect(Object.isFrozen(KAREL_WORLD_DOCUMENT_SCHEMA)).toBe(true)
    expect(Object.isFrozen(KAREL_WORLD_DOCUMENT_SCHEMA.$defs.world)).toBe(true)
  })

  it('canonicalizes equivalent walls, ordering, and colors deterministically', () => {
    const parsed = parseKarelWorldDocument(canonicalInput())
    expect(parsed).toEqual(cases.canonicalization.expected)
    expect(canonicalizeKarelWorldDocument(parsed)).toEqual(parsed)
    expect(serializeKarelWorldDocument(parsed)).toBe(
      `${JSON.stringify(cases.canonicalization.expected)}\n`,
    )
  })

  it('uses explicit bare and standalone converters without shape sniffing', () => {
    const bare = convertBareKarelWorldToDocument(
      cases.canonicalization.input.world,
    )
    expect(bare.document).toEqual(cases.canonicalization.expected)
    expect(bare.warnings).toEqual([])
    expect(bare.canonicalPreview).toBe(
      `${JSON.stringify(cases.canonicalization.expected)}\n`,
    )

    const standalone = convertStandaloneKarelWorldToDocument(
      cases.standaloneConversion.input,
    )
    expect(standalone.document).toEqual(cases.standaloneConversion.expected)
    expect(standalone.warnings.map(({ code }) => code)).toEqual(
      cases.standaloneConversion.warningCodes,
    )
    expect(standalone.canonicalPreview).toBe(
      `${JSON.stringify(cases.standaloneConversion.expected)}\n`,
    )
    expect(() =>
      parseKarelWorldDocument(cases.standaloneConversion.input),
    ).toThrow('unknown field')
  })

  it('rejects unknown, missing, unsupported, and nested extra fields', () => {
    expect(() =>
      parseKarelWorldDocument({ ...canonicalInput(), extra: true }),
    ).toThrow('unknown field extra')
    const missing = canonicalInput()
    delete missing.version
    expect(() => parseKarelWorldDocument(missing)).toThrow(
      'missing required field version',
    )
    expect(() =>
      parseKarelWorldDocument({ ...canonicalInput(), version: 2 }),
    ).toThrow('unsupported Karel world schema version')

    const nested = canonicalInput() as typeof cases.canonicalization.input & {
      world: typeof cases.canonicalization.input.world & { extra?: boolean }
    }
    nested.world.extra = true
    expect(() => parseKarelWorldDocument(nested)).toThrow(
      'world contains unknown field extra',
    )
  })

  it('rejects prototypes, accessors, symbols, sparse arrays, and array extras', () => {
    const inherited = Object.assign(Object.create({ inherited: true }), canonicalInput())
    expect(() => parseKarelWorldDocument(inherited)).toThrow('plain object')

    const accessor = canonicalInput() as typeof cases.canonicalization.input
    Object.defineProperty(accessor.world, 'name', {
      enumerable: true,
      get: () => 'Accessor World',
    })
    expect(() => parseKarelWorldDocument(accessor)).toThrow(
      'enumerable data property',
    )

    const symbol = canonicalInput()
    Object.defineProperty(symbol, Symbol('hidden'), { value: true })
    expect(() => parseKarelWorldDocument(symbol)).toThrow('symbol properties')

    const sparse = canonicalInput() as typeof cases.canonicalization.input
    sparse.world.beepers = new Array(1) as typeof sparse.world.beepers
    expect(() => parseKarelWorldDocument(sparse)).toThrow('dense array')

    const extra = canonicalInput() as typeof cases.canonicalization.input
    Object.defineProperty(extra.world.walls, 'metadata', {
      enumerable: true,
      value: true,
    })
    expect(() => parseKarelWorldDocument(extra)).toThrow(
      'dense array without extra properties',
    )
  })

  it('rejects invalid dimensions, locations, directions, counts, and colors', () => {
    const oversized = canonicalInput() as typeof cases.canonicalization.input
    oversized.world.columns = 101
    expect(() => parseKarelWorldDocument(oversized)).toThrow('cannot exceed 100')

    const outside = canonicalInput() as typeof cases.canonicalization.input
    outside.world.karel.avenue = 6
    expect(() => parseKarelWorldDocument(outside)).toThrow('outside')

    const invalidDirection = canonicalInput() as typeof cases.canonicalization.input
    Object.defineProperty(invalidDirection.world.karel, 'direction', {
      enumerable: true,
      value: 'up',
    })
    expect(() => parseKarelWorldDocument(invalidDirection)).toThrow(
      'north, east, south, or west',
    )

    const invalidCount = canonicalInput() as typeof cases.canonicalization.input
    invalidCount.world.beepers[0]!.count = 0
    expect(() => parseKarelWorldDocument(invalidCount)).toThrow(
      'greater than or equal to 1',
    )

    const invalidColor = canonicalInput() as typeof cases.canonicalization.input
    invalidColor.world.colors[0]!.color = 'url(https://example.test)'
    expect(() => parseKarelWorldDocument(invalidColor)).toThrow('safe named')
  })

  it('rejects implicit boundary walls and semantically duplicate items', () => {
    const boundary = canonicalInput() as typeof cases.canonicalization.input
    boundary.world.walls = [{ avenue: 5, street: 2, direction: 'east' }]
    expect(() => parseKarelWorldDocument(boundary)).toThrow('implicit boundary')

    const duplicateWall = canonicalInput() as typeof cases.canonicalization.input
    duplicateWall.world.walls = [
      { avenue: 2, street: 1, direction: 'east' },
      { avenue: 3, street: 1, direction: 'west' },
    ]
    expect(() => parseKarelWorldDocument(duplicateWall)).toThrow('duplicates wall')

    const duplicateBeeper = canonicalInput() as typeof cases.canonicalization.input
    duplicateBeeper.world.beepers = [
      { avenue: 1, street: 1, count: 1 },
      { avenue: 1, street: 1, count: 2 },
    ]
    expect(() => parseKarelWorldDocument(duplicateBeeper)).toThrow(
      'duplicates beeper corner',
    )

    const duplicateColor = canonicalInput() as typeof cases.canonicalization.input
    duplicateColor.world.colors = [
      { avenue: 1, street: 1, color: 'blue' },
      { avenue: 1, street: 1, color: '#fff' },
    ]
    expect(() => parseKarelWorldDocument(duplicateColor)).toThrow(
      'duplicates color corner',
    )
  })

  it('rejects ambiguous or malformed standalone evidence instead of defaulting', () => {
    expect(() =>
      convertStandaloneKarelWorldToDocument({
        ...cases.standaloneConversion.input,
        extra: true,
      }),
    ).toThrow('unknown field extra')
    expect(() =>
      convertStandaloneKarelWorldToDocument({
        ...cases.standaloneConversion.input,
        walls: ['1,2,up'],
      }),
    ).toThrow('street,avenue,direction')
    expect(() =>
      convertStandaloneKarelWorldToDocument({
        ...cases.standaloneConversion.input,
        beepers: { '1:2': 1 },
      }),
    ).toThrow('street,avenue format')
  })
})
