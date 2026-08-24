import type {
  DebugPauseState,
  IDEPanelServices,
  RuntimeBreakpointMap,
  WorkspaceFiles,
} from 'web-ide'
import type { KarelSessionStore } from './session-store'
import {
  KarelTimeline,
  type KarelTimelineLimits,
  type KarelTimelineSnapshot,
  type KarelTraceTerminal,
} from './timeline'
import type {
  KarelLimitReason,
  KarelProtocolEvent,
  KarelSourceLocation,
} from './types'

export const DEFAULT_KAREL_PLAYBACK_LIMITS = Object.freeze({
  maxPauses: 10_000,
  maxElapsedMs: 60_000,
  maxOutputBytes: 16 * 1024 * 1024,
  minSpeedMs: 50,
  maxSpeedMs: 2_000,
  defaultSpeedMs: 300,
} as const)

export interface KarelPlaybackLimits {
  maxPauses: number
  maxElapsedMs: number
  maxOutputBytes: number
  minSpeedMs: number
  maxSpeedMs: number
  defaultSpeedMs: number
}

export interface KarelPlaybackSnapshot {
  timeline: Readonly<KarelTimelineSnapshot>
  speedMs: number
  runtimePaused: boolean
  hasReachedStudentPause: boolean
  operation: 'idle' | 'starting' | 'stopping'
  message?: string
}

export interface KarelPlaybackControllerServices {
  runtime: IDEPanelServices['runtime']
  execution: IDEPanelServices['execution']
  source: IDEPanelServices['source']
  workspace: IDEPanelServices['workspace']
  store: KarelSessionStore
  limits?: KarelPlaybackLimits
  timelineLimits?: KarelTimelineLimits
  now?: () => number
}

type TimerHandle = ReturnType<typeof setTimeout>

const outputEncoder = new TextEncoder()
let nextControllerRun = 1

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function validateLimits(
  value: KarelPlaybackLimits,
): Readonly<KarelPlaybackLimits> {
  const limits = {
    maxPauses: positiveSafeInteger(value.maxPauses, 'maxPauses'),
    maxElapsedMs: positiveSafeInteger(value.maxElapsedMs, 'maxElapsedMs'),
    maxOutputBytes: positiveSafeInteger(value.maxOutputBytes, 'maxOutputBytes'),
    minSpeedMs: positiveSafeInteger(value.minSpeedMs, 'minSpeedMs'),
    maxSpeedMs: positiveSafeInteger(value.maxSpeedMs, 'maxSpeedMs'),
    defaultSpeedMs: positiveSafeInteger(value.defaultSpeedMs, 'defaultSpeedMs'),
  }
  if (limits.minSpeedMs > limits.maxSpeedMs) {
    throw new RangeError('minSpeedMs cannot exceed maxSpeedMs')
  }
  if (
    limits.defaultSpeedMs < limits.minSpeedMs
    || limits.defaultSpeedMs > limits.maxSpeedMs
  ) {
    throw new RangeError('defaultSpeedMs must be inside the speed range')
  }
  return Object.freeze(limits)
}

function sourceFromPause(
  pause: DebugPauseState,
  files: WorkspaceFiles,
): KarelSourceLocation | undefined {
  if (
    typeof pause.file !== 'string'
    || !Number.isSafeInteger(pause.line)
    || (pause.line as number) < 1
  ) {
    return undefined
  }
  const raw = pause.file
  if (
    raw.includes('\\')
    || Array.from(raw).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return undefined
  }
  const relative = raw.startsWith('/workspace/')
    ? raw.slice('/workspace/'.length)
    : raw.replace(/^\/+/, '')
  const segments = relative.split('/')
  if (
    relative === ''
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined
  }
  const absolute = `/workspace/${relative}`
  const content = files[absolute]
  if (typeof content !== 'string') return undefined
  const lines = content.split(/\r\n|\r|\n/u)
  if ((pause.line as number) > lines.length) return undefined
  return Object.freeze({ path: relative, line: pause.line as number })
}

function absoluteSource(source: KarelSourceLocation): string {
  return `/workspace/${source.path}`
}

function playbackBreakpoints(files: WorkspaceFiles): RuntimeBreakpointMap {
  const breakpoints: Record<string, readonly number[]> = {}
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    if (!path.startsWith('/workspace/') || !path.endsWith('.py')) continue
    const lines = content
      .split(/\r\n|\r|\n/u)
      .flatMap((line, index) => {
        const trimmed = line.trim()
        return trimmed === '' || trimmed.startsWith('#') ? [] : [index + 1]
      })
    if (lines.length > 0) breakpoints[path] = Object.freeze(lines)
  }
  return Object.freeze(breakpoints)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Karel playback operation failed'
}

/**
 * One instance-scoped bridge between public Web IDE execution/debug/source
 * services and Karel's pure bounded visual timeline.
 */
export class KarelPlaybackController {
  private readonly runtime: IDEPanelServices['runtime']
  private readonly execution: IDEPanelServices['execution']
  private readonly source: IDEPanelServices['source']
  private readonly workspace: IDEPanelServices['workspace']
  private readonly store: KarelSessionStore
  private readonly limits: Readonly<KarelPlaybackLimits>
  private readonly now: () => number
  private readonly timeline: KarelTimeline
  private readonly breakpointOverlayOwner = Object.freeze({})
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void)[] = []
  private snapshotValue: Readonly<KarelPlaybackSnapshot>
  private runId: string | undefined
  private protocolRunId: string | undefined
  private nextSequence = 0
  private pauseCount = 0
  private outputBytes = 0
  private startedAt = 0
  private speedMs: number
  private runtimePaused = false
  private hasReachedStudentPause = false
  private resumePending = false
  private operation: KarelPlaybackSnapshot['operation'] = 'idle'
  private message: string | undefined
  private playbackTimer: TimerHandle | undefined
  private elapsedTimer: TimerHandle | undefined
  private pendingStop: Promise<void> | undefined
  private activated = false
  private disposed = false
  private breakpointOverlayInstalled = false
  private pendingBreakpointOverlayInstall: Promise<void> | undefined
  private pendingBreakpointOverlayClear: Promise<void> | undefined
  private executionGeneration = 0

  constructor(services: KarelPlaybackControllerServices) {
    this.runtime = services.runtime
    this.execution = services.execution
    this.source = services.source
    this.workspace = services.workspace
    this.store = services.store
    this.limits = validateLimits(
      services.limits ?? DEFAULT_KAREL_PLAYBACK_LIMITS,
    )
    this.timeline = services.timelineLimits === undefined
      ? new KarelTimeline()
      : new KarelTimeline(services.timelineLimits)
    this.now = services.now ?? (() => performance.now())
    this.speedMs = this.limits.defaultSpeedMs
    this.snapshotValue = this.createSnapshot()
  }

  /** Attaches runtime/store listeners after React commit; safe to replay. */
  activate(): () => void {
    this.assertActive()
    if (this.activated) return () => this.deactivate()
    this.activated = true
    this.unsubscribe = [
      this.store.subscribeProtocol((event) => this.acceptProtocol(event)),
      this.runtime.events.debugPaused.subscribe((pause) => this.acceptPause(pause)),
      this.runtime.events.debugResumed.subscribe(() => {
        this.runtimePaused = false
        this.publish()
      }),
      this.runtime.events.stdout.subscribe((chunk) => this.acceptOutput(chunk)),
      this.runtime.events.stderr.subscribe((chunk) => this.acceptOutput(chunk)),
      this.runtime.events.exit.subscribe((code) => this.acceptExit(code)),
    ]
    return () => this.deactivate()
  }

  readonly getSnapshot = (): Readonly<KarelPlaybackSnapshot> => this.snapshotValue

  readonly subscribe = (listener: () => void): (() => void) => {
    this.assertActive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Compiles/starts in debug mode and pauses at the first eligible student line. */
  async prepare(): Promise<void> {
    await this.awaitPendingStop()
    if (this.operation !== 'idle') return
    this.beginRun(false)
    await this.startExecution()
  }

  /** Starts or resumes continuous line-by-line playback. */
  async play(): Promise<void> {
    this.assertActive()
    await this.awaitPendingStop()
    if (this.operation !== 'idle') return
    const current = this.timeline.getSnapshot()
    if (current.activeRunId === undefined || current.phase === 'terminal') {
      this.beginRun(true)
      await this.startExecution()
      return
    }
    const result = this.timeline.play()
    if (!result.accepted) return
    this.message = undefined
    this.publish()
    if (this.runtimePaused) this.scheduleResume()
  }

  /** Stops automatic resume; an in-flight step settles at the next source line. */
  pause(): void {
    this.assertActive()
    this.clearPlaybackTimer()
    const result = this.timeline.pause()
    if (result.accepted) {
      this.message = 'Playback paused; the live process has not been reversed.'
      this.publish()
    }
  }

  async stepForward(): Promise<void> {
    this.assertActive()
    const current = this.timeline.getSnapshot()
    if (current.cursor.mode === 'history') {
      if (this.timeline.stepRecordedForward()) {
        this.presentDisplayedSource()
        this.publish()
      }
      return
    }
    if (!this.runtimePaused) return
    const result = this.timeline.advance()
    if (!result.accepted) return
    this.message = undefined
    this.publish()
    await this.resumeOnce()
  }

  stepBack(): void {
    this.assertActive()
    if (!this.timeline.stepBack()) return
    this.clearPlaybackTimer()
    this.message = 'Viewing recorded history; live Python is not reversed.'
    this.presentDisplayedSource()
    this.publish()
  }

  showLive(): void {
    this.assertActive()
    this.timeline.showLive()
    this.message = undefined
    this.presentDisplayedSource()
    this.publish()
  }

  setSpeed(speedMs: number): void {
    this.assertActive()
    if (!Number.isSafeInteger(speedMs)) {
      throw new TypeError('Playback speed must be a safe integer')
    }
    this.speedMs = Math.min(
      this.limits.maxSpeedMs,
      Math.max(this.limits.minSpeedMs, speedMs),
    )
    this.publish()
    if (this.runtimePaused && this.timeline.getSnapshot().phase === 'playing') {
      this.scheduleResume()
    }
  }

  async stop(): Promise<void> {
    this.assertActive()
    this.executionGeneration += 1
    if (this.pendingStop) {
      await this.pendingStop
      return
    }
    const activeRun = this.runId
    if (!activeRun || this.timeline.getSnapshot().phase === 'terminal') {
      await this.clearBreakpointOverlay()
      return
    }
    this.clearRunTimers()
    await this.requestExecutionStop(() => {
      if (this.runId === activeRun && this.timeline.getSnapshot().phase !== 'terminal') {
        this.settle({
          runId: activeRun,
          sequence: this.takeSequence(),
          detail: {
            outcome: 'aborted',
            world: this.store.getSnapshot().world,
          },
        })
      }
    })
    await this.clearBreakpointOverlay()
  }

  async restart(): Promise<void> {
    this.assertActive()
    await this.stop()
    this.beginRun(true)
    await this.startExecution()
  }

  async reset(): Promise<void> {
    this.assertActive()
    await this.stop()
    await this.clearBreakpointOverlay()
    this.clearRunTimers()
    this.timeline.reset()
    this.runId = undefined
    this.protocolRunId = undefined
    this.runtimePaused = false
    this.hasReachedStudentPause = false
    this.operation = 'idle'
    this.message = undefined
    this.store.reset()
    this.clearSource()
    this.publish()
  }

  /** Replaces the next run's initial world without touching student code. */
  async selectWorld(world: Parameters<KarelSessionStore['setInitialWorld']>[0]): Promise<void> {
    await this.reset()
    this.store.setInitialWorld(world)
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.deactivate()
    this.disposed = true
    this.listeners.clear()
  }

  private deactivate(): void {
    if (!this.activated) return
    const shouldStop = this.runId !== undefined
      && this.timeline.getSnapshot().phase !== 'terminal'
    if (shouldStop) void this.requestExecutionStop()
    this.activated = false
    this.executionGeneration += 1
    this.clearRunTimers()
    this.releaseBreakpointOverlay()
    for (const dispose of this.unsubscribe.splice(0).reverse()) dispose()
    this.clearSource()
    this.timeline.reset()
    this.runId = undefined
    this.protocolRunId = undefined
    this.runtimePaused = false
    this.hasReachedStudentPause = false
    this.operation = 'idle'
    this.message = undefined
    this.publish()
  }

  private beginRun(playing: boolean): void {
    this.assertActive()
    this.clearRunTimers()
    this.executionGeneration += 1
    this.store.reset()
    this.runId = `karel-playback-${nextControllerRun++}`
    this.protocolRunId = undefined
    this.nextSequence = 0
    this.pauseCount = 0
    this.outputBytes = 0
    this.startedAt = this.now()
    this.runtimePaused = false
    this.hasReachedStudentPause = false
    this.resumePending = false
    this.operation = 'starting'
    this.message = undefined
    this.timeline.beginRun(this.runId)
    if (playing) this.timeline.play()
    this.elapsedTimer = setTimeout(
      () => this.triggerLimit('elapsed-time-limit', 'Karel run exceeded the elapsed-time limit.'),
      this.limits.maxElapsedMs,
    )
    this.publish()
  }

  private async startExecution(): Promise<void> {
    const activeRun = this.runId
    const generation = this.executionGeneration
    if (!activeRun) return
    try {
      await this.installBreakpointOverlay()
      if (this.runId !== activeRun || this.executionGeneration !== generation) {
        await this.clearBreakpointOverlay()
        return
      }
      await this.execution.start('debug')
    } catch (error) {
      if (this.runId === activeRun) this.fail(error)
    } finally {
      if (this.runId === activeRun) {
        this.operation = 'idle'
        this.publish()
      }
    }
  }

  private acceptProtocol(event: KarelProtocolEvent): void {
    if (this.disposed || !this.runId) return
    this.protocolRunId ??= event.runId
    if (event.runId !== this.protocolRunId) return

    if (event.type === 'state') {
      this.operation = 'idle'
      this.timeline.append({
        kind: 'action',
        runId: this.runId,
        sequence: this.takeSequence(),
        action: event.action,
        world: event.world,
        ...(event.source === undefined ? {} : { source: event.source }),
      })
      this.presentDisplayedSource()
      this.publish()
      return
    }

    const detail = event.outcome === 'completed'
      ? { outcome: 'completed' as const, world: event.world, ...(event.source ? { source: event.source } : {}) }
      : event.outcome === 'runtime-error'
        ? {
            outcome: 'runtime-error' as const,
            message: event.message,
            ...(event.errorType ? { errorType: event.errorType } : {}),
            ...(event.source ? { source: event.source } : {}),
            ...(event.world ? { world: event.world } : {}),
          }
        : event.outcome === 'limit-exceeded'
          ? {
              outcome: 'limit-exceeded' as const,
              reason: event.reason,
              ...(event.message ? { message: event.message } : {}),
              ...(event.source ? { source: event.source } : {}),
              ...(event.world ? { world: event.world } : {}),
            }
          : {
              outcome: 'aborted' as const,
              ...(event.source ? { source: event.source } : {}),
              ...(event.world ? { world: event.world } : {}),
            }
    this.settle({
      runId: this.runId,
      sequence: this.takeSequence(),
      detail,
    })
  }

  private acceptPause(pause: DebugPauseState): void {
    if (this.disposed || !this.runId) return
    this.operation = 'idle'
    this.runtimePaused = true
    this.pauseCount += 1
    if (this.pauseCount > this.limits.maxPauses) {
      this.triggerLimit('pause-limit', 'Karel run exceeded the debugger-pause limit.')
      return
    }

    const source = sourceFromPause(pause, this.workspace.snapshot())
    if (!source) {
      void this.resumeOnce()
      return
    }
    this.hasReachedStudentPause = true
    this.timeline.append({
      kind: 'line',
      runId: this.runId,
      sequence: this.takeSequence(),
      source,
      world: this.store.getSnapshot().world,
    })
    this.presentDisplayedSource()
    this.publish()
    if (this.timeline.getSnapshot().phase === 'playing') this.scheduleResume()
  }

  private acceptOutput(chunk: string): void {
    if (this.disposed || !this.runId || this.timeline.getSnapshot().phase === 'terminal') {
      return
    }
    this.outputBytes += outputEncoder.encode(chunk).byteLength
    if (this.outputBytes > this.limits.maxOutputBytes) {
      this.triggerLimit('output-byte-limit', 'Karel run exceeded the output-byte limit.')
    }
  }

  private acceptExit(code: number): void {
    if (this.disposed || !this.runId || this.timeline.getSnapshot().phase === 'terminal') {
      return
    }
    // Web IDE's settled stop may publish exit before its promise resolves.
    // The stop owner supplies the authoritative aborted/error settlement.
    if (this.pendingStop) return
    this.fail(new Error(
      code === 0
        ? 'Python exited without a Karel terminal event.'
        : `Python exited with code ${code} before Karel settled.`,
    ))
  }

  private scheduleResume(): void {
    this.clearPlaybackTimer()
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = undefined
      if (
        !this.disposed
        && this.runtimePaused
        && this.timeline.getSnapshot().phase === 'playing'
      ) {
        void this.resumeOnce()
      }
    }, this.speedMs)
  }

  private async resumeOnce(): Promise<void> {
    if (this.resumePending || !this.runtimePaused || this.disposed) return
    this.resumePending = true
    this.runtimePaused = false
    this.publish()
    try {
      // The owner-scoped overlay makes continue deterministic across nested
      // student callbacks while preserving editor-owned breakpoints.
      await this.runtime.continueExecution()
    } catch (error) {
      this.fail(error)
    } finally {
      this.resumePending = false
    }
  }

  private triggerLimit(reason: KarelLimitReason, message: string): void {
    if (!this.runId || this.timeline.getSnapshot().phase === 'terminal') return
    const stopping = this.requestExecutionStop()
    this.settle({
      runId: this.runId,
      sequence: this.takeSequence(),
      detail: {
        outcome: 'limit-exceeded',
        reason,
        message,
        world: this.store.getSnapshot().world,
      },
    })
    void stopping
  }

  private fail(error: unknown): void {
    if (!this.runId || this.timeline.getSnapshot().phase === 'terminal') return
    const message = errorMessage(error)
    this.settle({
      runId: this.runId,
      sequence: this.takeSequence(),
      detail: {
        outcome: 'runtime-error',
        message,
        world: this.store.getSnapshot().world,
      },
    })
  }

  private settle(terminal: KarelTraceTerminal): void {
    this.clearRunTimers()
    this.releaseBreakpointOverlay()
    this.runtimePaused = false
    this.operation = this.pendingStop ? 'stopping' : 'idle'
    this.timeline.settle(terminal)
    const detail = terminal.detail
    this.message = detail.outcome === 'runtime-error'
      ? detail.message
      : detail.outcome === 'limit-exceeded'
        ? detail.message ?? `Karel stopped at the ${detail.reason}.`
        : detail.outcome === 'aborted'
          ? 'Karel run stopped.'
          : 'Karel run completed.'
    this.presentDisplayedSource(
      detail.outcome === 'runtime-error' || detail.outcome === 'limit-exceeded'
        ? 'error'
        : 'current',
      detail.source,
    )
    this.publish()
  }

  private presentDisplayedSource(
    forcedKind?: 'current' | 'historical' | 'error',
    forcedSource?: KarelSourceLocation,
  ): void {
    const snapshot = this.timeline.getSnapshot()
    const source = forcedSource ?? snapshot.displayedFrame?.source
    if (!source) {
      if (forcedKind) this.clearSource()
      return
    }
    const kind = forcedKind ?? (snapshot.cursor.mode === 'history' ? 'historical' : 'current')
    const location = {
      path: absoluteSource(source),
      line: source.line,
      ...(source.column === undefined ? {} : { column: source.column }),
    }
    try {
      this.source.replaceDecorations([{ ...location, kind }])
      this.source.reveal(location)
    } catch {
      // Protocol/source races or deleted files fail closed at Web IDE's owner.
    }
  }

  private clearSource(): void {
    try {
      this.source.clearDecorations()
    } catch {
      // The host may already have revoked this contribution owner.
    }
  }

  private async installBreakpointOverlay(): Promise<void> {
    const replace = this.runtime.replaceBreakpointOverlay
    const clear = this.runtime.clearBreakpointOverlay
    if (replace === undefined || clear === undefined) {
      throw new Error(
        'The selected runtime does not support isolated Karel line playback.',
      )
    }
    const breakpoints = playbackBreakpoints(this.workspace.snapshot())
    if (Object.keys(breakpoints).length === 0) {
      throw new Error('Karel playback requires an executable workspace Python file.')
    }
    const pending = (async () => {
      if (this.pendingBreakpointOverlayClear) {
        await this.pendingBreakpointOverlayClear
      }
      await replace.call(this.runtime, this.breakpointOverlayOwner, breakpoints)
      this.breakpointOverlayInstalled = true
    })().finally(() => {
      if (this.pendingBreakpointOverlayInstall === pending) {
        this.pendingBreakpointOverlayInstall = undefined
      }
    })
    this.pendingBreakpointOverlayInstall = pending
    await pending
  }

  private async clearBreakpointOverlay(): Promise<void> {
    if (this.pendingBreakpointOverlayInstall) {
      try {
        await this.pendingBreakpointOverlayInstall
      } catch {
        return
      }
    }
    if (this.pendingBreakpointOverlayClear) {
      await this.pendingBreakpointOverlayClear
      return
    }
    if (!this.breakpointOverlayInstalled) return
    const clear = this.runtime.clearBreakpointOverlay
    if (clear === undefined) return
    const pending = clear.call(this.runtime, this.breakpointOverlayOwner)
      .then(() => {
        this.breakpointOverlayInstalled = false
      })
      .finally(() => {
        if (this.pendingBreakpointOverlayClear === pending) {
          this.pendingBreakpointOverlayClear = undefined
        }
      })
    this.pendingBreakpointOverlayClear = pending
    await pending
  }

  private releaseBreakpointOverlay(): void {
    void this.clearBreakpointOverlay().catch((error: unknown) => {
      if (this.disposed) return
      this.message = `Karel breakpoint cleanup failed: ${errorMessage(error)}`
      this.publish()
    })
  }

  private takeSequence(): number {
    const sequence = this.nextSequence
    this.nextSequence += 1
    return sequence
  }

  private async awaitPendingStop(): Promise<void> {
    this.assertActive()
    if (this.pendingStop) await this.pendingStop
    this.assertActive()
  }

  /** Starts at most one settled stop and keeps it observable until completion. */
  private requestExecutionStop(onSuccess?: () => void): Promise<void> {
    if (this.pendingStop) return this.pendingStop
    this.operation = 'stopping'
    this.publish()

    const pending = Promise.resolve()
      .then(() => this.execution.stop())
      .then(
        () => onSuccess?.(),
        (error: unknown) => {
          if (this.runId && this.timeline.getSnapshot().phase !== 'terminal') {
            this.fail(error)
          } else if (this.activated) {
            const stopError = errorMessage(error)
            this.message = this.message
              ? `${this.message} Runtime stop failed: ${stopError}`
              : `Runtime stop failed: ${stopError}`
            this.publish()
          }
        },
      )
      .finally(() => {
        if (this.pendingStop !== pending) return
        this.pendingStop = undefined
        if (!this.activated) return
        this.operation = 'idle'
        this.publish()
      })
    this.pendingStop = pending
    return pending
  }

  private clearPlaybackTimer(): void {
    if (this.playbackTimer !== undefined) clearTimeout(this.playbackTimer)
    this.playbackTimer = undefined
  }

  private clearRunTimers(): void {
    this.clearPlaybackTimer()
    if (this.elapsedTimer !== undefined) clearTimeout(this.elapsedTimer)
    this.elapsedTimer = undefined
  }

  private createSnapshot(): Readonly<KarelPlaybackSnapshot> {
    return Object.freeze({
      timeline: this.timeline.getSnapshot(),
      speedMs: this.speedMs,
      runtimePaused: this.runtimePaused,
      hasReachedStudentPause: this.hasReachedStudentPause,
      operation: this.operation,
      ...(this.message === undefined ? {} : { message: this.message }),
    })
  }

  private publish(): void {
    if (this.disposed) return
    this.snapshotValue = this.createSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Karel playback controller is disposed')
  }
}
