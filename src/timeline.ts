import type {
  KarelLimitReason,
  KarelSourceLocation,
  KarelTerminalOutcome,
  KarelWorld,
} from './types'
import { cloneKarelWorld } from './world'

export const DEFAULT_KAREL_TIMELINE_LIMITS = Object.freeze({
  maxFrames: 128,
  maxBytes: 8 * 1024 * 1024,
} as const)

export interface KarelTimelineLimits {
  /** Maximum number of world snapshots retained for recorded playback. */
  maxFrames: number
  /** Maximum UTF-8 JSON bytes retained across recorded playback frames. */
  maxBytes: number
}

interface KarelTraceFrameBase {
  /** Opaque lifecycle correlation value supplied by the execution controller. */
  runId: string
  /** Strictly increasing within one run; gaps are permitted. */
  sequence: number
  /** The already-validated student source associated with this frame. */
  source?: KarelSourceLocation
  /** The validated world after this line or action. */
  world: KarelWorld
}

export interface KarelLineTraceFrame extends KarelTraceFrameBase {
  kind: 'line'
  source: KarelSourceLocation
}

export interface KarelActionTraceFrame extends KarelTraceFrameBase {
  kind: 'action'
  action: string
}

/** A validated, source-correlated snapshot ready for bounded retention. */
export type KarelTraceFrame = KarelLineTraceFrame | KarelActionTraceFrame

export interface KarelCompletedTerminal {
  outcome: Extract<KarelTerminalOutcome, 'completed'>
  source?: KarelSourceLocation
  world: KarelWorld
}

export interface KarelRuntimeErrorTerminal {
  outcome: Extract<KarelTerminalOutcome, 'runtime-error'>
  message: string
  errorType?: string
  source?: KarelSourceLocation
  world?: KarelWorld
}

export interface KarelAbortedTerminal {
  outcome: Extract<KarelTerminalOutcome, 'aborted'>
  source?: KarelSourceLocation
  world?: KarelWorld
}

export interface KarelLimitExceededTerminal {
  outcome: Extract<KarelTerminalOutcome, 'limit-exceeded'>
  reason: KarelLimitReason
  message?: string
  source?: KarelSourceLocation
  world?: KarelWorld
}

export type KarelTerminalDetail =
  | KarelCompletedTerminal
  | KarelRuntimeErrorTerminal
  | KarelAbortedTerminal
  | KarelLimitExceededTerminal

export interface KarelTraceTerminal {
  runId: string
  sequence: number
  detail: KarelTerminalDetail
}

export type KarelTimelinePhase =
  | 'idle'
  | 'paused'
  | 'advancing'
  | 'playing'
  | 'terminal'

export type KarelTimelineCursor =
  | Readonly<{ mode: 'live' }>
  | Readonly<{ mode: 'history'; sequence: number; retainedIndex: number }>

export interface KarelTimelineRetention {
  maxFrames: number
  maxBytes: number
  retainedFrames: number
  retainedBytes: number
  truncated: boolean
  evictedFrames: number
  evictedBytes: number
}

export interface KarelTimelineSnapshot {
  activeRunId?: string
  phase: KarelTimelinePhase
  frames: readonly Readonly<KarelTraceFrame>[]
  liveFrame?: Readonly<KarelTraceFrame>
  displayedFrame?: Readonly<KarelTraceFrame>
  cursor: KarelTimelineCursor
  retention: Readonly<KarelTimelineRetention>
  /** Kept separately from bounded frames so eviction cannot erase a failure. */
  terminal?: Readonly<KarelTraceTerminal>
}

export type KarelTraceRejectionReason =
  | 'no-active-run'
  | 'stale-run'
  | 'non-monotonic-sequence'
  | 'post-terminal'
  | 'invalid-frame'
  | 'frame-too-large'

export type KarelTraceAcceptance =
  | Readonly<{
      accepted: true
      evictedFrames: number
      evictedBytes: number
    }>
  | Readonly<{
      accepted: false
      reason: KarelTraceRejectionReason
    }>

export type KarelTimelineControlRejection =
  | 'not-active'
  | 'not-paused'
  | 'not-playing'
  | 'history-view'

export type KarelTimelineControlResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false
      reason: KarelTimelineControlRejection
    }>

interface RetainedFrame {
  frame: Readonly<KarelTraceFrame>
  bytes: number
}

const LIVE_CURSOR = Object.freeze({ mode: 'live' } as const)
const encoder = new TextEncoder()

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function validRunId(value: string): boolean {
  return typeof value === 'string' && value.length > 0
}

function validSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function cloneSource(
  source: KarelSourceLocation | undefined,
): Readonly<KarelSourceLocation> | undefined {
  if (source === undefined) return undefined
  if (
    typeof source.path !== 'string' ||
    source.path.length === 0 ||
    !Number.isSafeInteger(source.line) ||
    source.line < 1 ||
    (source.column !== undefined &&
      (!Number.isSafeInteger(source.column) || source.column < 1))
  ) {
    throw new TypeError('trace source location is invalid')
  }
  return Object.freeze({
    path: source.path,
    line: source.line,
    ...(source.column === undefined ? {} : { column: source.column }),
  })
}

function freezeWorld(world: KarelWorld): KarelWorld {
  Object.freeze(world.karel)
  for (const item of world.beepers) Object.freeze(item)
  for (const item of world.walls) Object.freeze(item)
  for (const item of world.colors) Object.freeze(item)
  Object.freeze(world.beepers)
  Object.freeze(world.walls)
  Object.freeze(world.colors)
  return Object.freeze(world)
}

function cloneFrame(frame: KarelTraceFrame): Readonly<KarelTraceFrame> {
  if (!validRunId(frame.runId) || !validSequence(frame.sequence)) {
    throw new TypeError('trace correlation is invalid')
  }
  const source = cloneSource(frame.source)
  const world = freezeWorld(cloneKarelWorld(frame.world))
  if (frame.kind === 'line') {
    if (source === undefined) throw new TypeError('line trace requires a source')
    return Object.freeze({
      kind: 'line',
      runId: frame.runId,
      sequence: frame.sequence,
      source,
      world,
    })
  }
  if (frame.kind !== 'action' || typeof frame.action !== 'string' || frame.action === '') {
    throw new TypeError('trace action is invalid')
  }
  return Object.freeze({
    kind: 'action',
    runId: frame.runId,
    sequence: frame.sequence,
    ...(source === undefined ? {} : { source }),
    action: frame.action,
    world,
  })
}

function serializableFrame(frame: Readonly<KarelTraceFrame>): object {
  return {
    kind: frame.kind,
    runId: frame.runId,
    sequence: frame.sequence,
    source: frame.source ?? null,
    action: frame.kind === 'action' ? frame.action : null,
    world: frame.world,
  }
}

/** Exact UTF-8 JSON accounting used by the bounded retained timeline. */
export function measureKarelTraceFrameBytes(frame: KarelTraceFrame): number {
  return encoder.encode(JSON.stringify(serializableFrame(cloneFrame(frame)))).byteLength
}

function cloneTerminalDetail(
  detail: KarelTerminalDetail,
): Readonly<KarelTerminalDetail> {
  switch (detail.outcome) {
    case 'completed': {
      const source = cloneSource(detail.source)
      return Object.freeze({
        outcome: 'completed',
        ...(source === undefined ? {} : { source }),
        world: freezeWorld(cloneKarelWorld(detail.world)),
      })
    }
    case 'runtime-error': {
      if (typeof detail.message !== 'string' || detail.message.length === 0) {
        throw new TypeError('runtime error terminal requires a message')
      }
      if (detail.errorType !== undefined && typeof detail.errorType !== 'string') {
        throw new TypeError('runtime error type must be a string')
      }
      const source = cloneSource(detail.source)
      const world =
        detail.world === undefined
          ? undefined
          : freezeWorld(cloneKarelWorld(detail.world))
      return Object.freeze({
        outcome: 'runtime-error',
        message: detail.message,
        ...(detail.errorType === undefined ? {} : { errorType: detail.errorType }),
        ...(source === undefined ? {} : { source }),
        ...(world === undefined ? {} : { world }),
      })
    }
    case 'aborted': {
      const source = cloneSource(detail.source)
      const world =
        detail.world === undefined
          ? undefined
          : freezeWorld(cloneKarelWorld(detail.world))
      return Object.freeze({
        outcome: 'aborted',
        ...(source === undefined ? {} : { source }),
        ...(world === undefined ? {} : { world }),
      })
    }
    case 'limit-exceeded': {
      if (typeof detail.reason !== 'string' || detail.reason.length === 0) {
        throw new TypeError('limit terminal requires a reason')
      }
      if (detail.message !== undefined && typeof detail.message !== 'string') {
        throw new TypeError('limit terminal message must be a string')
      }
      const source = cloneSource(detail.source)
      const world =
        detail.world === undefined
          ? undefined
          : freezeWorld(cloneKarelWorld(detail.world))
      return Object.freeze({
        outcome: 'limit-exceeded',
        reason: detail.reason,
        ...(detail.message === undefined ? {} : { message: detail.message }),
        ...(source === undefined ? {} : { source }),
        ...(world === undefined ? {} : { world }),
      })
    }
  }
}

function cloneTerminal(terminal: KarelTraceTerminal): Readonly<KarelTraceTerminal> {
  if (!validRunId(terminal.runId) || !validSequence(terminal.sequence)) {
    throw new TypeError('terminal correlation is invalid')
  }
  return Object.freeze({
    runId: terminal.runId,
    sequence: terminal.sequence,
    detail: cloneTerminalDetail(terminal.detail),
  })
}

function rejected(reason: KarelTraceRejectionReason): KarelTraceAcceptance {
  return Object.freeze({ accepted: false, reason })
}

function controlRejected(
  reason: KarelTimelineControlRejection,
): KarelTimelineControlResult {
  return Object.freeze({ accepted: false, reason })
}

/**
 * Pure state machine for a single Karel activity's recorded visual history.
 * It owns no timer or runtime operation; callers execute accepted control
 * requests and feed back only validated, run-correlated frames.
 */
export class KarelTimeline {
  private readonly limits: Readonly<KarelTimelineLimits>
  private retained: RetainedFrame[] = []
  private retainedBytes = 0
  private evictedFrames = 0
  private evictedBytes = 0
  private activeRunId: string | undefined
  private highestSequence = -1
  private phaseValue: KarelTimelinePhase = 'idle'
  private historySequence: number | undefined
  private terminalValue: Readonly<KarelTraceTerminal> | undefined

  constructor(limits: KarelTimelineLimits = DEFAULT_KAREL_TIMELINE_LIMITS) {
    this.limits = Object.freeze({
      maxFrames: positiveSafeInteger(limits.maxFrames, 'maxFrames'),
      maxBytes: positiveSafeInteger(limits.maxBytes, 'maxBytes'),
    })
  }

  /** Starts a distinct run and atomically drops all prior run presentation. */
  beginRun(runId: string): void {
    if (!validRunId(runId)) throw new TypeError('runId must be a non-empty string')
    this.clearRetained()
    this.activeRunId = runId
    this.highestSequence = -1
    this.phaseValue = 'paused'
    this.historySequence = undefined
    this.terminalValue = undefined
  }

  /** Returns to an inert state; late frames then fail as having no active run. */
  reset(): void {
    this.clearRetained()
    this.activeRunId = undefined
    this.highestSequence = -1
    this.phaseValue = 'idle'
    this.historySequence = undefined
    this.terminalValue = undefined
  }

  play(): KarelTimelineControlResult {
    if (this.activeRunId === undefined || this.phaseValue === 'terminal') {
      return controlRejected('not-active')
    }
    if (this.historySequence !== undefined) return controlRejected('history-view')
    if (this.phaseValue !== 'paused') return controlRejected('not-paused')
    this.phaseValue = 'playing'
    return Object.freeze({ accepted: true })
  }

  pause(): KarelTimelineControlResult {
    if (this.activeRunId === undefined || this.phaseValue === 'terminal') {
      return controlRejected('not-active')
    }
    if (this.phaseValue !== 'playing') return controlRejected('not-playing')
    this.phaseValue = 'paused'
    return Object.freeze({ accepted: true })
  }

  /** Requests one live forward step; a subsequent accepted frame pauses it. */
  advance(): KarelTimelineControlResult {
    if (this.activeRunId === undefined || this.phaseValue === 'terminal') {
      return controlRejected('not-active')
    }
    if (this.historySequence !== undefined) return controlRejected('history-view')
    if (this.phaseValue !== 'paused') return controlRejected('not-paused')
    this.phaseValue = 'advancing'
    return Object.freeze({ accepted: true })
  }

  append(frame: KarelTraceFrame): KarelTraceAcceptance {
    if (this.activeRunId === undefined) return rejected('no-active-run')
    if (frame.runId !== this.activeRunId) return rejected('stale-run')
    if (this.phaseValue === 'terminal') return rejected('post-terminal')
    if (!validSequence(frame.sequence) || frame.sequence <= this.highestSequence) {
      return rejected('non-monotonic-sequence')
    }

    let cloned: Readonly<KarelTraceFrame>
    let bytes: number
    try {
      cloned = cloneFrame(frame)
      bytes = encoder.encode(JSON.stringify(serializableFrame(cloned))).byteLength
    } catch {
      return rejected('invalid-frame')
    }
    if (bytes > this.limits.maxBytes) return rejected('frame-too-large')

    this.retained.push({ frame: cloned, bytes })
    this.retainedBytes += bytes
    this.highestSequence = cloned.sequence
    if (this.phaseValue === 'advancing') this.phaseValue = 'paused'

    let evictedFrames = 0
    let evictedBytes = 0
    while (
      this.retained.length > this.limits.maxFrames ||
      this.retainedBytes > this.limits.maxBytes
    ) {
      const evicted = this.retained.shift()
      if (!evicted) break
      this.retainedBytes -= evicted.bytes
      evictedFrames += 1
      evictedBytes += evicted.bytes
    }
    this.evictedFrames += evictedFrames
    this.evictedBytes += evictedBytes
    this.reconcileHistoryCursor()

    return Object.freeze({ accepted: true, evictedFrames, evictedBytes })
  }

  settle(terminal: KarelTraceTerminal): KarelTraceAcceptance {
    if (this.activeRunId === undefined) return rejected('no-active-run')
    if (terminal.runId !== this.activeRunId) return rejected('stale-run')
    if (this.phaseValue === 'terminal') return rejected('post-terminal')
    if (
      !validSequence(terminal.sequence) ||
      terminal.sequence <= this.highestSequence
    ) {
      return rejected('non-monotonic-sequence')
    }
    try {
      this.terminalValue = cloneTerminal(terminal)
    } catch {
      return rejected('invalid-frame')
    }
    this.highestSequence = terminal.sequence
    this.phaseValue = 'terminal'
    return Object.freeze({ accepted: true, evictedFrames: 0, evictedBytes: 0 })
  }

  /** Move backward through retained display state without touching live Python. */
  stepBack(): boolean {
    if (this.retained.length < 2) return false
    if (this.historySequence === undefined) {
      this.historySequence = this.retained[this.retained.length - 2]?.frame.sequence
      return this.historySequence !== undefined
    }
    const index = this.historyIndex()
    if (index <= 0) return false
    this.historySequence = this.retained[index - 1]?.frame.sequence
    return this.historySequence !== undefined
  }

  /** Move toward the live frame; reaching the newest frame rejoins live mode. */
  stepRecordedForward(): boolean {
    if (this.historySequence === undefined) return false
    const index = this.historyIndex()
    if (index < 0) {
      this.reconcileHistoryCursor()
      return false
    }
    if (index >= this.retained.length - 2) {
      this.historySequence = undefined
      return true
    }
    this.historySequence = this.retained[index + 1]?.frame.sequence
    return this.historySequence !== undefined
  }

  showLive(): void {
    this.historySequence = undefined
  }

  getSnapshot(): Readonly<KarelTimelineSnapshot> {
    const frames = Object.freeze(this.retained.map(({ frame }) => frame))
    const liveFrame = frames.at(-1)
    const historyIndex = this.historyIndex()
    const cursor: KarelTimelineCursor =
      historyIndex < 0
        ? LIVE_CURSOR
        : Object.freeze({
            mode: 'history',
            sequence: this.historySequence as number,
            retainedIndex: historyIndex,
          })
    const displayedFrame = historyIndex < 0 ? liveFrame : frames[historyIndex]
    const retention = Object.freeze({
      maxFrames: this.limits.maxFrames,
      maxBytes: this.limits.maxBytes,
      retainedFrames: frames.length,
      retainedBytes: this.retainedBytes,
      truncated: this.evictedFrames > 0,
      evictedFrames: this.evictedFrames,
      evictedBytes: this.evictedBytes,
    })
    return Object.freeze({
      ...(this.activeRunId === undefined ? {} : { activeRunId: this.activeRunId }),
      phase: this.phaseValue,
      frames,
      ...(liveFrame === undefined ? {} : { liveFrame }),
      ...(displayedFrame === undefined ? {} : { displayedFrame }),
      cursor,
      retention,
      ...(this.terminalValue === undefined ? {} : { terminal: this.terminalValue }),
    })
  }

  private historyIndex(): number {
    if (this.historySequence === undefined) return -1
    return this.retained.findIndex(
      ({ frame }) => frame.sequence === this.historySequence,
    )
  }

  private reconcileHistoryCursor(): void {
    if (this.historySequence === undefined || this.historyIndex() >= 0) return
    this.historySequence = this.retained[0]?.frame.sequence
  }

  private clearRetained(): void {
    this.retained = []
    this.retainedBytes = 0
    this.evictedFrames = 0
    this.evictedBytes = 0
  }
}
