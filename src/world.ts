import type {
  KarelBeeperBag,
  KarelBeeperPile,
  KarelCornerColor,
  KarelDirection,
  KarelRobot,
  KarelWall,
  KarelWorld,
} from './types'

const DIRECTIONS = new Set<KarelDirection>([
  'north',
  'east',
  'south',
  'west',
])
const MAX_WORLD_DIMENSION = 100
const MAX_WORLD_ITEMS = 10_000

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  if (value.length > MAX_WORLD_ITEMS) {
    throw new RangeError(`${field} exceeds the ${MAX_WORLD_ITEMS}-item limit`)
  }
  return value
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

function safeColor(value: unknown, field: string): string {
  const parsed = nonEmptyString(value, field)
  if (!/^(?:#[0-9a-f]{3,8}|[a-z]{1,24})$/i.test(parsed)) {
    throw new TypeError(
      `${field} must be a named color or a 3- to 8-digit hexadecimal color`,
    )
  }
  return parsed
}

function integer(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${field} must be an integer greater than or equal to ${minimum}`)
  }
  return value as number
}

function direction(value: unknown, field: string): KarelDirection {
  if (!DIRECTIONS.has(value as KarelDirection)) {
    throw new TypeError(`${field} must be north, east, south, or west`)
  }
  return value as KarelDirection
}

function location(
  value: Record<string, unknown>,
  field: string,
  columns: number,
  rows: number,
): { avenue: number; street: number } {
  const avenue = integer(value.avenue, `${field}.avenue`)
  const street = integer(value.street, `${field}.street`)
  if (avenue > columns || street > rows) {
    throw new RangeError(`${field} is outside the ${columns}x${rows} world`)
  }
  return { avenue, street }
}

/** Parse untrusted JSON/runtime data into the package's canonical world shape. */
export function parseKarelWorld(value: unknown): KarelWorld {
  const raw = object(value, 'world')
  const columns = integer(raw.columns, 'world.columns')
  const rows = integer(raw.rows, 'world.rows')
  if (columns > MAX_WORLD_DIMENSION || rows > MAX_WORLD_DIMENSION) {
    throw new RangeError(
      `world dimensions cannot exceed ${MAX_WORLD_DIMENSION}x${MAX_WORLD_DIMENSION}`,
    )
  }

  const rawKarel = object(raw.karel, 'world.karel')
  const bag = rawKarel.beepersInBag
  let beepersInBag: KarelBeeperBag
  if (bag === 'infinite') beepersInBag = bag
  else beepersInBag = integer(bag, 'world.karel.beepersInBag', 0)

  const karel: KarelRobot = {
    ...location(rawKarel, 'world.karel', columns, rows),
    direction: direction(rawKarel.direction, 'world.karel.direction'),
    beepersInBag,
  }

  const beepers: KarelBeeperPile[] = array(raw.beepers, 'world.beepers').map(
    (item, index) => {
      const pile = object(item, `world.beepers[${index}]`)
      return {
        ...location(pile, `world.beepers[${index}]`, columns, rows),
        count: integer(pile.count, `world.beepers[${index}].count`),
      }
    },
  )

  const walls: KarelWall[] = array(raw.walls, 'world.walls').map(
    (item, index) => {
      const wall = object(item, `world.walls[${index}]`)
      return {
        ...location(wall, `world.walls[${index}]`, columns, rows),
        direction: direction(wall.direction, `world.walls[${index}].direction`),
      }
    },
  )

  const colors: KarelCornerColor[] = array(raw.colors, 'world.colors').map(
    (item, index) => {
      const corner = object(item, `world.colors[${index}]`)
      return {
        ...location(corner, `world.colors[${index}]`, columns, rows),
        color: safeColor(corner.color, `world.colors[${index}].color`),
      }
    },
  )

  return {
    name: nonEmptyString(raw.name, 'world.name'),
    columns,
    rows,
    karel,
    beepers,
    walls,
    colors,
  }
}

export function cloneKarelWorld(world: KarelWorld): KarelWorld {
  return parseKarelWorld(structuredClone(world))
}

export function serializeKarelWorld(world: KarelWorld): string {
  return `${JSON.stringify(parseKarelWorld(world), null, 2)}\n`
}
