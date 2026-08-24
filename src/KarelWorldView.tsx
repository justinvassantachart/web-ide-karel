import { useId, type CSSProperties } from 'react'
import type { KarelDirection, KarelWall, KarelWorld } from './types'

const CELL_SIZE = 64
const PADDING = 24
const ACCESSIBLE_ITEM_LIMIT = 20

function boundedList(items: readonly string[], empty: string): string {
  if (items.length === 0) return empty
  const visible = items.slice(0, ACCESSIBLE_ITEM_LIMIT)
  const remainder = items.length - visible.length
  return `${visible.join('; ')}${remainder > 0 ? `; and ${remainder} more` : ''}`
}

/** A bounded textual equivalent for the visual world state. */
function describeKarelWorld(world: KarelWorld): string {
  const beepers = boundedList(
    world.beepers.map(
      ({ avenue, street, count }) => `${count} at avenue ${avenue}, street ${street}`,
    ),
    'none',
  )
  const walls = boundedList(
    world.walls.map(
      ({ avenue, street, direction }) =>
        `${direction} of avenue ${avenue}, street ${street}`,
    ),
    'none',
  )
  const colors = boundedList(
    world.colors.map(
      ({ avenue, street, color }) => `${color} at avenue ${avenue}, street ${street}`,
    ),
    'none',
  )
  return [
    `${world.columns} avenues by ${world.rows} streets.`,
    `Karel is at avenue ${world.karel.avenue}, street ${world.karel.street}, facing ${world.karel.direction}, with ${String(world.karel.beepersInBag)} beepers in the bag.`,
    `Beeper piles: ${beepers}.`,
    `Walls: ${walls}.`,
    `Painted corners: ${colors}.`,
  ].join(' ')
}

function center(
  world: KarelWorld,
  avenue: number,
  street: number,
): { x: number; y: number } {
  return {
    x: PADDING + (avenue - 0.5) * CELL_SIZE,
    y: PADDING + (world.rows - street + 0.5) * CELL_SIZE,
  }
}

function wallLine(world: KarelWorld, wall: KarelWall) {
  const { x, y } = center(world, wall.avenue, wall.street)
  const half = CELL_SIZE / 2
  switch (wall.direction) {
    case 'north':
      return { x1: x - half, y1: y - half, x2: x + half, y2: y - half }
    case 'east':
      return { x1: x + half, y1: y - half, x2: x + half, y2: y + half }
    case 'south':
      return { x1: x - half, y1: y + half, x2: x + half, y2: y + half }
    case 'west':
      return { x1: x - half, y1: y - half, x2: x - half, y2: y + half }
  }
}

function rotation(direction: KarelDirection): number {
  return { north: 0, east: 90, south: 180, west: -90 }[direction]
}

export interface KarelWorldViewProps {
  world: KarelWorld
  className?: string
  style?: CSSProperties
}

export function KarelWorldView({
  world,
  className,
  style,
}: KarelWorldViewProps) {
  const descriptionId = useId()
  const width = world.columns * CELL_SIZE + PADDING * 2
  const height = world.rows * CELL_SIZE + PADDING * 2
  const robot = center(world, world.karel.avenue, world.karel.street)

  return (
    <svg
      className={className}
      style={style}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${world.name}: Karel at avenue ${world.karel.avenue}, street ${world.karel.street}, facing ${world.karel.direction}`}
      aria-describedby={descriptionId}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{world.name}</title>
      <desc id={descriptionId}>{describeKarelWorld(world)}</desc>
      <rect className="karel-world-background" width={width} height={height} rx="12" />

      {world.colors.map((corner) => {
        const point = center(world, corner.avenue, corner.street)
        return (
          <rect
            key={`color-${corner.avenue}-${corner.street}`}
            x={point.x - CELL_SIZE / 2 + 3}
            y={point.y - CELL_SIZE / 2 + 3}
            width={CELL_SIZE - 6}
            height={CELL_SIZE - 6}
            rx="7"
            fill={corner.color}
            opacity="0.32"
          />
        )
      })}

      <g className="karel-world-grid">
        {Array.from({ length: world.columns + 1 }, (_, index) => (
          <line
            key={`vertical-${index}`}
            x1={PADDING + index * CELL_SIZE}
            y1={PADDING}
            x2={PADDING + index * CELL_SIZE}
            y2={height - PADDING}
          />
        ))}
        {Array.from({ length: world.rows + 1 }, (_, index) => (
          <line
            key={`horizontal-${index}`}
            x1={PADDING}
            y1={PADDING + index * CELL_SIZE}
            x2={width - PADDING}
            y2={PADDING + index * CELL_SIZE}
          />
        ))}
      </g>

      <rect
        className="karel-world-boundary"
        x={PADDING}
        y={PADDING}
        width={world.columns * CELL_SIZE}
        height={world.rows * CELL_SIZE}
      />

      <g className="karel-world-walls">
        {world.walls.map((wall, index) => (
          <line
            key={`wall-${wall.avenue}-${wall.street}-${wall.direction}-${index}`}
            {...wallLine(world, wall)}
          />
        ))}
      </g>

      <g className="karel-world-beepers">
        {world.beepers.map((pile) => {
          const point = center(world, pile.avenue, pile.street)
          return (
            <g key={`beeper-${pile.avenue}-${pile.street}`}>
              <circle cx={point.x} cy={point.y} r="15" />
              <text x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central">
                {pile.count}
              </text>
            </g>
          )
        })}
      </g>

      <g
        className="karel-world-robot"
        data-testid="karel-robot"
        transform={`translate(${robot.x} ${robot.y}) rotate(${rotation(world.karel.direction)})`}
      >
        <circle r="22" />
        <path d="M 0 -17 L 11 8 L 0 3 L -11 8 Z" />
        <circle className="karel-world-robot-eye" cx="-6" cy="-5" r="2.5" />
        <circle className="karel-world-robot-eye" cx="6" cy="-5" r="2.5" />
      </g>
    </svg>
  )
}
