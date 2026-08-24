import { useId, useState, type CSSProperties } from 'react'
import karelIconUrl from './assets/karel.png'
import type { KarelDirection, KarelWall, KarelWorld } from './types'

const CELL_SIZE = 72
const LABEL_GUTTER = 34
const OUTER_PADDING = 18
const ACCESSIBLE_ITEM_LIMIT = 20
const ROBOT_SIZE = 50

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
    x: LABEL_GUTTER + (avenue - 0.5) * CELL_SIZE,
    y: OUTER_PADDING + (world.rows - street + 0.5) * CELL_SIZE,
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

/** The owner-provided pixel-art source faces east. */
function rotation(direction: KarelDirection): number {
  return { east: 0, south: 90, west: 180, north: -90 }[direction]
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
  const gridPatternId = `${descriptionId.replaceAll(':', '')}-grid`
  const [iconAvailable, setIconAvailable] = useState(true)
  const gridWidth = world.columns * CELL_SIZE
  const gridHeight = world.rows * CELL_SIZE
  const width = gridWidth + LABEL_GUTTER + OUTER_PADDING
  const height = gridHeight + LABEL_GUTTER + OUTER_PADDING
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
      <title>
        {world.name}. Avenue {world.karel.avenue}, street {world.karel.street},
        {' '}facing {world.karel.direction}.
      </title>
      <desc id={descriptionId}>{describeKarelWorld(world)}</desc>
      <defs aria-hidden="true">
        <pattern
          id={gridPatternId}
          x={LABEL_GUTTER}
          y={OUTER_PADDING}
          width={CELL_SIZE}
          height={CELL_SIZE}
          patternUnits="userSpaceOnUse"
        >
          <path
            className="karel-world-intersection"
            d={`M ${CELL_SIZE / 2 - 4} ${CELL_SIZE / 2} H ${CELL_SIZE / 2 + 4} M ${CELL_SIZE / 2} ${CELL_SIZE / 2 - 4} V ${CELL_SIZE / 2 + 4}`}
          />
        </pattern>
      </defs>
      <rect
        className="karel-world-background"
        x={LABEL_GUTTER}
        y={OUTER_PADDING}
        width={gridWidth}
        height={gridHeight}
        rx="8"
      />

      {world.colors.map((corner) => {
        const point = center(world, corner.avenue, corner.street)
        return (
          <rect
            key={`color-${corner.avenue}-${corner.street}`}
            className="karel-world-color"
            x={point.x - CELL_SIZE / 2 + 3}
            y={point.y - CELL_SIZE / 2 + 3}
            width={CELL_SIZE - 6}
            height={CELL_SIZE - 6}
            rx="6"
            fill={corner.color}
          />
        )
      })}

      <rect
        className="karel-world-grid"
        x={LABEL_GUTTER}
        y={OUTER_PADDING}
        width={gridWidth}
        height={gridHeight}
        fill={`url(#${gridPatternId})`}
        aria-hidden="true"
      />

      <g className="karel-world-labels" aria-hidden="true">
        {Array.from({ length: world.rows }, (_, index) => {
          const street = index + 1
          const point = center(world, 1, street)
          return (
            <text
              key={`street-${street}`}
              x={LABEL_GUTTER / 2}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {street}
            </text>
          )
        })}
        {Array.from({ length: world.columns }, (_, index) => {
          const avenue = index + 1
          const point = center(world, avenue, 1)
          return (
            <text
              key={`avenue-${avenue}`}
              x={point.x}
              y={OUTER_PADDING + gridHeight + LABEL_GUTTER / 2}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {avenue}
            </text>
          )
        })}
      </g>

      <rect
        className="karel-world-boundary"
        x={LABEL_GUTTER}
        y={OUTER_PADDING}
        width={gridWidth}
        height={gridHeight}
        rx="8"
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
          const radius = 16
          return (
            <g key={`beeper-${pile.avenue}-${pile.street}`}>
              <path
                d={`M ${point.x} ${point.y - radius} L ${point.x + radius} ${point.y} L ${point.x} ${point.y + radius} L ${point.x - radius} ${point.y} Z`}
              />
              {pile.count > 1 && (
                <text
                  x={point.x}
                  y={point.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {pile.count}
                </text>
              )}
            </g>
          )
        })}
      </g>

      <g
        className="karel-world-robot"
        data-testid="karel-robot"
        data-direction={world.karel.direction}
        data-icon-state={iconAvailable ? 'ready' : 'fallback'}
        transform={`translate(${robot.x} ${robot.y}) rotate(${rotation(world.karel.direction)})`}
      >
        {iconAvailable ? (
          <image
            className="karel-world-robot-icon"
            data-testid="karel-robot-icon"
            href={karelIconUrl}
            x={-ROBOT_SIZE / 2}
            y={-ROBOT_SIZE / 2}
            width={ROBOT_SIZE}
            height={ROBOT_SIZE}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            onError={() => setIconAvailable(false)}
          />
        ) : (
          <path
            className="karel-world-robot-fallback"
            data-testid="karel-robot-fallback"
            d="M 21 0 L -15 -14 L -8 0 L -15 14 Z"
          />
        )}
      </g>
    </svg>
  )
}
