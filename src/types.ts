export const KAREL_PROTOCOL_NAME = 'web-ide-karel' as const
export const KAREL_PROTOCOL_VERSION = 2 as const
export const KAREL_OSC_CODE = 777 as const

/** Defensive transport quotas shared by the decoder and bundled runtime. */
export const KAREL_PROTOCOL_LIMITS = Object.freeze({
  maxFrameCharacters: 2_000_000,
  maxEventsPerRun: 100_000,
  maxEventsPerChunk: 1_024,
  maxErrorsPerChunk: 64,
  maxProtocolCharactersPerRun: 8 * 1024 * 1024,
  maxRunIdCharacters: 128,
  maxSourcePathCharacters: 512,
  maxActionCharacters: 64,
  maxMessageCharacters: 4_096,
  maxErrorTypeCharacters: 128,
} as const)

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
  runId: string
  sequence: number
}

/** A normalized, relative POSIX path in the student source plane. */
export interface KarelSourceLocation {
  path: string
  line: number
  column?: number
}

export interface KarelStateEvent extends KarelProtocolEventBase {
  type: 'state'
  action: string
  world: KarelWorld
  source?: KarelSourceLocation
}

export type KarelTerminalOutcome =
  | 'completed'
  | 'runtime-error'
  | 'aborted'
  | 'limit-exceeded'

export type KarelLimitReason =
  | 'event-limit'
  | 'protocol-byte-limit'
  | 'pause-limit'
  | 'elapsed-time-limit'
  | 'output-byte-limit'
  | 'queue-limit'

interface KarelTerminalEventBase extends KarelProtocolEventBase {
  type: 'terminal'
  outcome: KarelTerminalOutcome
  source?: KarelSourceLocation
}

export interface KarelCompletedEvent extends KarelTerminalEventBase {
  outcome: 'completed'
  world: KarelWorld
}

export interface KarelRuntimeErrorEvent extends KarelTerminalEventBase {
  outcome: 'runtime-error'
  message: string
  errorType?: string
  world?: KarelWorld
}

export interface KarelAbortedEvent extends KarelTerminalEventBase {
  outcome: 'aborted'
  world?: KarelWorld
}

export interface KarelLimitExceededEvent extends KarelTerminalEventBase {
  outcome: 'limit-exceeded'
  reason: KarelLimitReason
  message?: string
  world?: KarelWorld
}

export type KarelTerminalEvent =
  | KarelCompletedEvent
  | KarelRuntimeErrorEvent
  | KarelAbortedEvent
  | KarelLimitExceededEvent

export type KarelProtocolEvent =
  | KarelStateEvent
  | KarelTerminalEvent

export type KarelSessionStatus =
  | 'waiting'
  | 'running'
  | 'complete'
  | 'error'
  | 'exited'

export interface KarelSessionSnapshot {
  world: KarelWorld
  status: KarelSessionStatus
  runId?: string
  lastAction?: string
  error?: string
  sequence: number
}
