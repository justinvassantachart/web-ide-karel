import type {
  KarelBeeperBag,
  KarelBeeperPile,
  KarelCornerColor,
  KarelDirection,
  KarelRobot,
  KarelWall,
  KarelWorld,
} from './types'

export const KAREL_WORLD_SCHEMA_NAME = 'web-ide-karel/world' as const
export const KAREL_WORLD_SCHEMA_VERSION = 1 as const
export const MAX_KAREL_WORLD_DIMENSION = 100
export const MAX_KAREL_WORLD_ITEMS = 10_000
export const MAX_KAREL_WORLD_NAME_LENGTH = 256

export type KarelWorldBodyV1 = KarelWorld

export interface KarelWorldDocumentV1 {
  schema: typeof KAREL_WORLD_SCHEMA_NAME
  version: typeof KAREL_WORLD_SCHEMA_VERSION
  world: KarelWorldBodyV1
}

export interface KarelWorldConversionWarning {
  code:
    | 'standalone-id-omitted'
    | 'infinite-beeper-bag-assumed'
    | 'unsupported-corner-colors-empty'
  message: string
}

export interface KarelWorldConversionResult {
  document: KarelWorldDocumentV1
  canonicalPreview: string
  warnings: readonly KarelWorldConversionWarning[]
}

const DIRECTIONS = new Set<KarelDirection>([
  'north',
  'east',
  'south',
  'west',
])
const COLOR_PATTERN = /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{1,24})$/i

type StrictObject = Record<string, unknown>

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}

/** Portable JSON Schema for the strict v1 envelope. Semantic checks remain in the parser. */
export const KAREL_WORLD_DOCUMENT_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Web IDE Karel world document v1',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'version', 'world'],
  properties: {
    schema: { const: KAREL_WORLD_SCHEMA_NAME },
    version: { const: KAREL_WORLD_SCHEMA_VERSION },
    world: { $ref: '#/$defs/world' },
  },
  $defs: {
    positiveInteger: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    coordinate: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_KAREL_WORLD_DIMENSION,
    },
    direction: { enum: ['north', 'east', 'south', 'west'] },
    location: {
      type: 'object',
      additionalProperties: false,
      required: ['avenue', 'street'],
      properties: {
        avenue: { $ref: '#/$defs/coordinate' },
        street: { $ref: '#/$defs/coordinate' },
      },
    },
    robot: {
      type: 'object',
      additionalProperties: false,
      required: ['avenue', 'street', 'direction', 'beepersInBag'],
      properties: {
        avenue: { $ref: '#/$defs/coordinate' },
        street: { $ref: '#/$defs/coordinate' },
        direction: { $ref: '#/$defs/direction' },
        beepersInBag: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            { const: 'infinite' },
          ],
        },
      },
    },
    beeper: {
      type: 'object',
      additionalProperties: false,
      required: ['avenue', 'street', 'count'],
      properties: {
        avenue: { $ref: '#/$defs/coordinate' },
        street: { $ref: '#/$defs/coordinate' },
        count: { $ref: '#/$defs/positiveInteger' },
      },
    },
    wall: {
      type: 'object',
      additionalProperties: false,
      required: ['avenue', 'street', 'direction'],
      properties: {
        avenue: { $ref: '#/$defs/coordinate' },
        street: { $ref: '#/$defs/coordinate' },
        direction: { $ref: '#/$defs/direction' },
      },
    },
    color: {
      type: 'object',
      additionalProperties: false,
      required: ['avenue', 'street', 'color'],
      properties: {
        avenue: { $ref: '#/$defs/coordinate' },
        street: { $ref: '#/$defs/coordinate' },
        color: {
          type: 'string',
          pattern:
            '^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-zA-Z]{1,24})$',
        },
      },
    },
    world: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'columns', 'rows', 'karel', 'beepers', 'walls', 'colors'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_KAREL_WORLD_NAME_LENGTH,
          pattern: '^[^\\u0000-\\u001f\\u007f]*$',
        },
        columns: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_KAREL_WORLD_DIMENSION,
        },
        rows: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_KAREL_WORLD_DIMENSION,
        },
        karel: { $ref: '#/$defs/robot' },
        beepers: {
          type: 'array',
          maxItems: MAX_KAREL_WORLD_ITEMS,
          items: { $ref: '#/$defs/beeper' },
        },
        walls: {
          type: 'array',
          maxItems: MAX_KAREL_WORLD_ITEMS,
          items: { $ref: '#/$defs/wall' },
        },
        colors: {
          type: 'array',
          maxItems: MAX_KAREL_WORLD_ITEMS,
          items: { $ref: '#/$defs/color' },
        },
      },
    },
  },
} as const)

function strictObject(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): StrictObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`)
  }

  const allowed = new Set([...required, ...optional])
  const result = Object.create(null) as StrictObject
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${field} must not contain symbol properties`)
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${field} contains unknown field ${key}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`)
    }
    result[key] = descriptor.value
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) {
      throw new TypeError(`${field} is missing required field ${key}`)
    }
  }
  return result
}

function strictDynamicObject(value: unknown, field: string): StrictObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`)
  }
  const result = Object.create(null) as StrictObject
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${field} must not contain symbol properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`)
    }
    result[key] = descriptor.value
  }
  return result
}

function strictArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${field} must be a plain array`)
  }
  if (value.length > MAX_KAREL_WORLD_ITEMS) {
    throw new RangeError(`${field} exceeds the ${MAX_KAREL_WORLD_ITEMS}-item limit`)
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${field} must not contain symbol properties`)
  }
  if (keys.length !== value.length + 1) {
    throw new TypeError(`${field} must be a dense array without extra properties`)
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field}[${index}] must be an enumerable data property`)
    }
    result.push(descriptor.value)
  }
  return result
}

function integer(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    )
  }
  return value as number
}

function dimension(value: unknown, field: string): number {
  const parsed = integer(value, field)
  if (parsed > MAX_KAREL_WORLD_DIMENSION) {
    throw new RangeError(
      `${field} cannot exceed ${MAX_KAREL_WORLD_DIMENSION}`,
    )
  }
  return parsed
}

function name(value: unknown, field: string): string {
  const containsControlCharacter =
    typeof value === 'string' &&
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_KAREL_WORLD_NAME_LENGTH ||
    containsControlCharacter
  ) {
    throw new TypeError(
      `${field} must be a non-empty control-free string of at most ${MAX_KAREL_WORLD_NAME_LENGTH} characters`,
    )
  }
  return value
}

function direction(value: unknown, field: string): KarelDirection {
  if (!DIRECTIONS.has(value as KarelDirection)) {
    throw new TypeError(`${field} must be north, east, south, or west`)
  }
  return value as KarelDirection
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a safe named or hexadecimal color`)
  }
  return value.toLowerCase()
}

function location(
  raw: StrictObject,
  field: string,
  columns: number,
  rows: number,
): { avenue: number; street: number } {
  const avenue = integer(raw.avenue, `${field}.avenue`)
  const street = integer(raw.street, `${field}.street`)
  if (avenue > columns || street > rows) {
    throw new RangeError(`${field} is outside the ${columns}x${rows} world`)
  }
  return { avenue, street }
}

function locationKey(value: { avenue: number; street: number }): string {
  return `${value.street},${value.avenue}`
}

function compareLocations(
  left: { avenue: number; street: number },
  right: { avenue: number; street: number },
): number {
  return left.street - right.street || left.avenue - right.avenue
}

function canonicalWall(
  value: KarelWall,
  columns: number,
  rows: number,
  field: string,
): KarelWall {
  switch (value.direction) {
    case 'east':
      if (value.avenue === columns) {
        throw new RangeError(`${field} describes an implicit boundary wall`)
      }
      return value
    case 'west':
      if (value.avenue === 1) {
        throw new RangeError(`${field} describes an implicit boundary wall`)
      }
      return { avenue: value.avenue - 1, street: value.street, direction: 'east' }
    case 'north':
      if (value.street === rows) {
        throw new RangeError(`${field} describes an implicit boundary wall`)
      }
      return value
    case 'south':
      if (value.street === 1) {
        throw new RangeError(`${field} describes an implicit boundary wall`)
      }
      return { avenue: value.avenue, street: value.street - 1, direction: 'north' }
  }
}

/** Parse and canonicalize a strict v1 world body without accepting an envelope implicitly. */
export function parseKarelWorldBodyV1(value: unknown): KarelWorldBodyV1 {
  const raw = strictObject(value, 'world', [
    'name',
    'columns',
    'rows',
    'karel',
    'beepers',
    'walls',
    'colors',
  ])
  const columns = dimension(raw.columns, 'world.columns')
  const rows = dimension(raw.rows, 'world.rows')

  const rawKarel = strictObject(raw.karel, 'world.karel', [
    'avenue',
    'street',
    'direction',
    'beepersInBag',
  ])
  const bag = rawKarel.beepersInBag
  const beepersInBag: KarelBeeperBag =
    bag === 'infinite' ? bag : integer(bag, 'world.karel.beepersInBag', 0)
  const karel: KarelRobot = {
    ...location(rawKarel, 'world.karel', columns, rows),
    direction: direction(rawKarel.direction, 'world.karel.direction'),
    beepersInBag,
  }

  const beeperKeys = new Set<string>()
  const beepers: KarelBeeperPile[] = strictArray(
    raw.beepers,
    'world.beepers',
  ).map((value, index) => {
    const field = `world.beepers[${index}]`
    const item = strictObject(value, field, ['avenue', 'street', 'count'])
    const parsed = {
      ...location(item, field, columns, rows),
      count: integer(item.count, `${field}.count`),
    }
    const key = locationKey(parsed)
    if (beeperKeys.has(key)) {
      throw new TypeError(`${field} duplicates beeper corner ${key}`)
    }
    beeperKeys.add(key)
    return parsed
  })
  beepers.sort(compareLocations)

  const wallKeys = new Set<string>()
  const walls: KarelWall[] = strictArray(raw.walls, 'world.walls').map(
    (value, index) => {
      const field = `world.walls[${index}]`
      const item = strictObject(value, field, ['avenue', 'street', 'direction'])
      const parsed = canonicalWall(
        {
          ...location(item, field, columns, rows),
          direction: direction(item.direction, `${field}.direction`),
        },
        columns,
        rows,
        field,
      )
      const key = `${locationKey(parsed)},${parsed.direction}`
      if (wallKeys.has(key)) {
        throw new TypeError(`${field} duplicates wall ${key}`)
      }
      wallKeys.add(key)
      return parsed
    },
  )
  walls.sort(
    (left, right) =>
      compareLocations(left, right) ||
      (left.direction === right.direction ? 0 : left.direction < right.direction ? -1 : 1),
  )

  const colorKeys = new Set<string>()
  const colors: KarelCornerColor[] = strictArray(raw.colors, 'world.colors').map(
    (value, index) => {
      const field = `world.colors[${index}]`
      const item = strictObject(value, field, ['avenue', 'street', 'color'])
      const parsed = {
        ...location(item, field, columns, rows),
        color: color(item.color, `${field}.color`),
      }
      const key = locationKey(parsed)
      if (colorKeys.has(key)) {
        throw new TypeError(`${field} duplicates color corner ${key}`)
      }
      colorKeys.add(key)
      return parsed
    },
  )
  colors.sort(compareLocations)

  return {
    name: name(raw.name, 'world.name'),
    columns,
    rows,
    karel,
    beepers,
    walls,
    colors,
  }
}

/** Strictly parse and canonicalize a portable Karel world v1 envelope. */
export function parseKarelWorldDocument(value: unknown): KarelWorldDocumentV1 {
  const raw = strictObject(value, 'document', ['schema', 'version', 'world'])
  if (raw.schema !== KAREL_WORLD_SCHEMA_NAME) {
    throw new TypeError(`document.schema must be ${KAREL_WORLD_SCHEMA_NAME}`)
  }
  if (raw.version !== KAREL_WORLD_SCHEMA_VERSION) {
    throw new TypeError('unsupported Karel world schema version')
  }
  return {
    schema: KAREL_WORLD_SCHEMA_NAME,
    version: KAREL_WORLD_SCHEMA_VERSION,
    world: parseKarelWorldBodyV1(raw.world),
  }
}

export function canonicalizeKarelWorldDocument(
  value: unknown,
): KarelWorldDocumentV1 {
  return parseKarelWorldDocument(value)
}

export function serializeKarelWorldDocument(value: unknown): string {
  return `${JSON.stringify(parseKarelWorldDocument(value))}\n`
}

function conversionResult(
  document: KarelWorldDocumentV1,
  warnings: readonly KarelWorldConversionWarning[],
): KarelWorldConversionResult {
  return {
    document,
    canonicalPreview: serializeKarelWorldDocument(document),
    warnings,
  }
}

/** Explicitly convert the companion's former bare world shape into v1. */
export function convertBareKarelWorldToDocument(
  value: unknown,
): KarelWorldConversionResult {
  const document = parseKarelWorldDocument({
    schema: KAREL_WORLD_SCHEMA_NAME,
    version: KAREL_WORLD_SCHEMA_VERSION,
    world: value,
  })
  return conversionResult(document, [])
}

/** Explicitly convert the documented standalone r/c/cols world format into v1. */
export function convertStandaloneKarelWorldToDocument(
  value: unknown,
): KarelWorldConversionResult {
  const raw = strictObject(
    value,
    'standaloneWorld',
    ['name', 'rows', 'cols', 'karel', 'walls', 'beepers'],
    ['id'],
  )
  const rows = dimension(raw.rows, 'standaloneWorld.rows')
  const columns = dimension(raw.cols, 'standaloneWorld.cols')
  const robot = strictObject(raw.karel, 'standaloneWorld.karel', ['r', 'c', 'dir'])

  const rawBeepers = strictDynamicObject(
    raw.beepers,
    'standaloneWorld.beepers',
  )
  if (Object.keys(rawBeepers).length > MAX_KAREL_WORLD_ITEMS) {
    throw new RangeError(
      `standaloneWorld.beepers exceeds the ${MAX_KAREL_WORLD_ITEMS}-item limit`,
    )
  }
  const beepers = Object.entries(rawBeepers).map(([key, countValue]) => {
    const match = /^([1-9]\d*),([1-9]\d*)$/.exec(key)
    if (!match) {
      throw new TypeError(
        `standaloneWorld.beepers key ${key} must use the street,avenue format`,
      )
    }
    return {
      street: integer(Number(match[1]), `standaloneWorld.beepers.${key}.street`),
      avenue: integer(Number(match[2]), `standaloneWorld.beepers.${key}.avenue`),
      count: integer(countValue, `standaloneWorld.beepers.${key}`),
    }
  })

  const walls = strictArray(raw.walls, 'standaloneWorld.walls').map(
    (wallValue, index) => {
      if (typeof wallValue !== 'string') {
        throw new TypeError(`standaloneWorld.walls[${index}] must be a string`)
      }
      const match = /^([1-9]\d*),([1-9]\d*),(north|east|south|west)$/.exec(
        wallValue,
      )
      if (!match) {
        throw new TypeError(
          `standaloneWorld.walls[${index}] must use street,avenue,direction`,
        )
      }
      return {
        street: integer(Number(match[1]), `standaloneWorld.walls[${index}].street`),
        avenue: integer(Number(match[2]), `standaloneWorld.walls[${index}].avenue`),
        direction: direction(
          match[3],
          `standaloneWorld.walls[${index}].direction`,
        ),
      }
    },
  )

  const document = parseKarelWorldDocument({
    schema: KAREL_WORLD_SCHEMA_NAME,
    version: KAREL_WORLD_SCHEMA_VERSION,
    world: {
      name: name(raw.name, 'standaloneWorld.name'),
      columns,
      rows,
      karel: {
        avenue: integer(robot.c, 'standaloneWorld.karel.c'),
        street: integer(robot.r, 'standaloneWorld.karel.r'),
        direction: direction(robot.dir, 'standaloneWorld.karel.dir'),
        beepersInBag: 'infinite',
      },
      beepers,
      walls,
      colors: [],
    },
  })
  const warnings: KarelWorldConversionWarning[] = []
  if (Object.hasOwn(raw, 'id')) {
    name(raw.id, 'standaloneWorld.id')
    warnings.push({
      code: 'standalone-id-omitted',
      message: 'The standalone world id is host metadata and was not included.',
    })
  }
  warnings.push(
    {
      code: 'infinite-beeper-bag-assumed',
      message: 'The standalone format has no bag count; its unlimited bag was preserved.',
    },
    {
      code: 'unsupported-corner-colors-empty',
      message: 'The standalone format has no corner colors; colors were set to empty.',
    },
  )
  return conversionResult(document, warnings)
}
