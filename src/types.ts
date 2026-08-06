export const KAREL_PROTOCOL_NAME = 'web-ide-karel' as const
export const KAREL_PROTOCOL_VERSION = 1 as const
export const KAREL_OSC_CODE = 777 as const

export type KarelDirection = 'north' | 'east' | 'south' | 'west'
export type KarelBeeperBag = number | 'infinite'

export interface KarelLocation {
  avenue: number
  street: number
}

export interface KarelRobot extends KarelLocation {
  direction: KarelDirection
  beepersInBag: KarelBeeperBag
}

export interface KarelBeeperPile extends KarelLocation {
  count: number
}

export interface KarelWall extends KarelLocation {
  direction: KarelDirection
}

export interface KarelCornerColor extends KarelLocation {
  color: string
}

/** JSON-serializable world shared by the bundled Python library and panel. */
export interface KarelWorld {
  name: string
  columns: number
  rows: number
  karel: KarelRobot
  beepers: KarelBeeperPile[]
  walls: KarelWall[]
  colors: KarelCornerColor[]
}

interface KarelProtocolEventBase {
  protocol: typeof KAREL_PROTOCOL_NAME
  version: typeof KAREL_PROTOCOL_VERSION
  sequence: number
}

export interface KarelStateEvent extends KarelProtocolEventBase {
  type: 'state'
  action: string
  world: KarelWorld
}

export interface KarelCompleteEvent extends KarelProtocolEventBase {
  type: 'complete'
  world: KarelWorld
}

export interface KarelErrorEvent extends KarelProtocolEventBase {
  type: 'error'
  message: string
  errorType?: string
}

export type KarelProtocolEvent =
  | KarelStateEvent
  | KarelCompleteEvent
  | KarelErrorEvent

export type KarelSessionStatus =
  | 'waiting'
  | 'running'
  | 'complete'
  | 'error'
  | 'exited'

export interface KarelSessionSnapshot {
  world: KarelWorld
  status: KarelSessionStatus
  lastAction?: string
  error?: string
  sequence: number
}
