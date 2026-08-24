import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { IDEPanelServices } from 'web-ide'
import {
  KarelPlaybackController,
  type KarelPlaybackLimits,
} from './playback-controller'
import { KarelWorldView } from './KarelWorldView'
import type { KarelSessionStore } from './session-store'
import type {
  KarelTimelineLimits,
  KarelTimelineSnapshot,
} from './timeline'
import type { KarelSessionSnapshot, KarelWorld } from './types'

export interface KarelPanelWorldOption {
  id: string
  label: string
  world: KarelWorld
}

export interface KarelPanelProps extends IDEPanelServices {
  store: KarelSessionStore
  worlds?: readonly KarelPanelWorldOption[]
  selectedWorldId?: string
  onSelectWorld?(id: string): void
  /** Optional host-owned cumulative execution limits. */
  playbackLimits?: KarelPlaybackLimits
  /** Optional host-owned retained-history limits. */
  timelineLimits?: KarelTimelineLimits
}

function statusLabel(
  session: KarelSessionSnapshot,
  timeline: Readonly<KarelTimelineSnapshot>,
  operation: 'idle' | 'starting' | 'stopping',
  runtimePaused: boolean,
  hasReachedStudentPause: boolean,
): string {
  if (timeline.cursor.mode === 'history') return 'History'
  const terminalOutcome = timeline.terminal?.detail.outcome
  if (terminalOutcome === 'limit-exceeded') return 'Limit reached'
  if (terminalOutcome === 'runtime-error') return 'Error'
  if (terminalOutcome === 'completed') return 'Complete'
  if (terminalOutcome === 'aborted') return 'Stopped'
  if (operation === 'starting') return 'Starting'
  if (operation === 'stopping') return 'Stopping'
  if (timeline.activeRunId !== undefined && !hasReachedStudentPause) {
    return 'Starting'
  }
  if (timeline.phase === 'playing') return 'Playing'
  if (timeline.phase === 'advancing') return 'Stepping'
  if (timeline.phase === 'paused' && !runtimePaused) return 'Pausing'
  if (timeline.phase === 'paused') return 'Paused'
  return {
    waiting: 'Ready',
    running: 'Running',
    complete: 'Complete',
    error: 'Error',
    exited: 'Stopped',
  }[session.status]
}

function terminalWorld(
  timeline: Readonly<KarelTimelineSnapshot>,
): KarelWorld | undefined {
  const detail = timeline.terminal?.detail
  return detail && 'world' in detail ? detail.world : undefined
}

function frameLabel(timeline: Readonly<KarelTimelineSnapshot>): string {
  if (timeline.frames.length === 0) return 'No recorded frames'
  if (timeline.cursor.mode === 'history') {
    return `Recorded frame ${timeline.cursor.retainedIndex + 1} of ${timeline.frames.length}`
  }
  return `Live frame ${timeline.frames.length} of ${timeline.frames.length}`
}

export function KarelPanel({
  runtime,
  execution,
  source,
  workspace,
  store,
  worlds = [],
  selectedWorldId,
  onSelectWorld,
  playbackLimits,
  timelineLimits,
}: KarelPanelProps) {
  const session = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const controller = useMemo(
    () => new KarelPlaybackController({
      runtime,
      execution,
      source,
      workspace: { snapshot: workspace.snapshot },
      store,
      ...(playbackLimits === undefined ? {} : { limits: playbackLimits }),
      ...(timelineLimits === undefined ? {} : { timelineLimits }),
    }),
    [
      execution,
      playbackLimits,
      runtime,
      source,
      store,
      timelineLimits,
      workspace.snapshot,
    ],
  )
  useEffect(() => controller.activate(), [controller])
  const playback = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [worldId, setWorldId] = useState(
    selectedWorldId ?? worlds[0]?.id ?? '',
  )

  const supportsPython = runtime.languageIds.some(
    (languageId) => languageId.toLowerCase() === 'python',
  )
  const supportsDebug = supportsPython && runtime.capabilities.debug
  const timeline = playback.timeline
  const world = timeline.displayedFrame?.world
    ?? terminalWorld(timeline)
    ?? session.world
  const active = timeline.activeRunId !== undefined && timeline.phase !== 'terminal'
  const live = timeline.cursor.mode === 'live'
  const paused = timeline.phase === 'paused'
  const playing = timeline.phase === 'playing'
  const busy = playback.operation !== 'idle'
  const awaitingStudentPause = active && !playback.hasReachedStudentPause
  const transitionLocked = busy || awaitingStudentPause
  const canStepBack = timeline.frames.length >= 2
  const canStepForward = timeline.cursor.mode === 'history'
    || (paused && playback.runtimePaused)

  const chooseWorld = (id: string) => {
    if (transitionLocked) return
    const choice = worlds.find((candidate) => candidate.id === id)
    if (!choice) return
    setWorldId(id)
    onSelectWorld?.(id)
    void controller.selectWorld(choice.world)
  }

  return (
    <section className="karel-panel" aria-label="Karel world and playback">
      <header className="karel-panel-header">
        <div>
          <h2>{world.name}</h2>
          <p>
            Avenue {world.karel.avenue}, street {world.karel.street}
            {' · '}
            facing {world.karel.direction}
          </p>
        </div>
        <span
          className={`karel-status karel-status-${session.status}`}
          role="status"
          aria-live="polite"
        >
          {statusLabel(
            session,
            timeline,
            playback.operation,
            playback.runtimePaused,
            playback.hasReachedStudentPause,
          )}
        </span>
      </header>

      {!supportsPython && (
        <p className="karel-panel-notice" role="note">
          Select a Python runtime session to run this Karel workspace.
        </p>
      )}
      {supportsPython && !runtime.capabilities.debug && (
        <p className="karel-panel-notice" role="note">
          The selected Python runtime does not support line playback.
        </p>
      )}

      {(session.error || playback.message) && (
        <p
          className={session.error ? 'karel-panel-error' : 'karel-panel-message'}
          role={session.error ? 'alert' : 'note'}
          aria-live="polite"
        >
          {session.error ?? playback.message}
        </p>
      )}

      <div className="karel-playback-controls" aria-label="Karel playback controls">
        <button
          type="button"
          onClick={() => void controller.prepare()}
          disabled={!supportsDebug || active || busy}
        >
          Prepare &amp; pause
        </button>
        <button
          type="button"
          onClick={() => void controller.play()}
          disabled={!supportsDebug || playing || busy || !live}
        >
          Play
        </button>
        <button
          type="button"
          onClick={() => controller.pause()}
          disabled={!playing}
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() => void controller.stop()}
          disabled={
            !active
            || transitionLocked
            || !playback.hasReachedStudentPause
          }
        >
          Stop
        </button>
        <button
          type="button"
          onClick={() => void controller.reset()}
          disabled={transitionLocked}
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => void controller.restart()}
          disabled={!supportsDebug || transitionLocked}
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => controller.stepBack()}
          disabled={!canStepBack}
          aria-describedby="karel-history-explanation"
        >
          Step back
        </button>
        <button
          type="button"
          onClick={() => void controller.stepForward()}
          disabled={!canStepForward}
        >
          Step forward
        </button>
        <button
          type="button"
          onClick={() => controller.showLive()}
          disabled={live}
        >
          Return to live
        </button>

        <label className="karel-control-field">
          <span>Playback speed</span>
          <select
            value={playback.speedMs}
            onChange={(event) => controller.setSpeed(Number(event.target.value))}
          >
            <option value="1000">Slow</option>
            <option value="300">Normal</option>
            <option value="100">Fast</option>
          </select>
        </label>

        {worlds.length > 1 && (
          <label className="karel-control-field">
            <span>World</span>
            <select
              value={worldId}
              onChange={(event) => chooseWorld(event.target.value)}
              disabled={transitionLocked}
            >
              {worlds.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="karel-frame-status" aria-live="polite">
        <span>{frameLabel(timeline)}</span>
        <span>
          {timeline.retention.truncated
            ? `${timeline.retention.evictedFrames} older frames discarded within the memory limit`
            : `${timeline.retention.retainedFrames} retained`}
        </span>
      </div>

      <p id="karel-history-explanation" className="karel-visually-hidden">
        Step back changes only the displayed recorded world. It does not reverse
        the live Python process.
      </p>

      <div className="karel-world-viewport">
        <KarelWorldView world={world} className="karel-world" />
      </div>

      <footer className="karel-panel-footer">
        <span>Last action: {session.lastAction ?? 'waiting for run'}</span>
        <span>
          Beepers: {String(world.karel.beepersInBag)}
        </span>
        <span className="karel-world-summary">
          {world.beepers.length} beeper piles, {world.walls.length} walls,
          {' '}{world.colors.length} painted corners
        </span>
      </footer>
    </section>
  )
}
