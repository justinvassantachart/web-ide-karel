import {
  useEffect,
  useId,
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

type KarelControlIconName =
  | 'prepare'
  | 'play'
  | 'pause'
  | 'stop'
  | 'reset'
  | 'restart'
  | 'step-back'
  | 'step-forward'
  | 'live'

function KarelControlIcon({ name }: { name: KarelControlIconName }) {
  const content = {
    prepare: (
      <>
        <path d="m14.5 5.5 4 4" />
        <path d="m3.5 20.5 8.75-8.75" />
        <path d="m9.5 4.5 2-2 5 1 3 3-2 2-3-3-2 2Z" />
        <path d="m2.5 18.5 3 3" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: (
      <>
        <path d="M8 5v14" />
        <path d="M16 5v14" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
    reset: (
      <>
        <path d="M5.5 8.5A8 8 0 1 1 4 14" />
        <path d="M5.5 3.5v5h5" />
      </>
    ),
    restart: (
      <>
        <path d="M5.5 8.5A8 8 0 1 1 4 14" />
        <path d="M5.5 3.5v5h5" />
        <path d="m10 9 6 3-6 3Z" />
      </>
    ),
    'step-back': (
      <>
        <path d="M6 5v14" />
        <path d="m18 6-9 6 9 6Z" />
      </>
    ),
    'step-forward': (
      <>
        <path d="M18 5v14" />
        <path d="m6 6 9 6-9 6Z" />
      </>
    ),
    live: (
      <>
        <path d="M5 12a7 7 0 0 1 12-4.9L19.5 9" />
        <path d="M19.5 4v5h-5" />
        <circle cx="12" cy="12" r="2" />
      </>
    ),
  }[name]

  return (
    <svg
      className="karel-control-icon"
      data-karel-control-icon={name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {content}
    </svg>
  )
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

function statusTone(label: string): string {
  if (label === 'Complete') return 'complete'
  if (label === 'Error' || label === 'Limit reached') return 'error'
  if (label === 'History') return 'history'
  if (label === 'Ready' || label === 'Stopped') return 'idle'
  return 'active'
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

function runtimeFeedback(visibleStatus: string): string {
  return {
    Ready: 'Ready to prepare or play.',
    Starting: 'Preparing the Karel runtime.',
    Running: 'Receiving live Karel state.',
    Playing: 'Playing live Karel state.',
    Pausing: 'Waiting for the runtime to pause.',
    Paused: 'Playback is paused at the live frame.',
    Stepping: 'Advancing one live step.',
    History: 'Recorded history is shown; the live process is unchanged.',
    Stopping: 'Stopping the current Karel run.',
    Stopped: 'Run stopped; prepare or restart to continue.',
    Complete: 'Run completed; reset or restart to run again.',
    Error: 'Run ended with an error; review the runtime message.',
    'Limit reached': 'Run reached a configured safety limit.',
  }[visibleStatus] ?? `Karel status: ${visibleStatus}.`
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
  const historyExplanationId = useId()
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
  const visibleStatus = statusLabel(
    session,
    timeline,
    playback.operation,
    playback.runtimePaused,
    playback.hasReachedStudentPause,
  )

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
        <div className="karel-panel-title">
          <span className="karel-panel-eyebrow">Karel world</span>
          <h2>{world.name}</h2>
          <p>
            Avenue {world.karel.avenue}, street {world.karel.street}
            {' · '}
            facing {world.karel.direction}
          </p>
        </div>
        <span
          className={`karel-status karel-status-${statusTone(visibleStatus)}`}
          data-status={visibleStatus.toLowerCase().replaceAll(' ', '-')}
          role="status"
          aria-live="polite"
        >
          <span className="karel-status-indicator" aria-hidden="true" />
          {visibleStatus}
        </span>
      </header>

      <div className="karel-playback-controls" aria-label="Karel playback controls">
        <div className="karel-control-group karel-control-group-run" role="group" aria-label="Run controls">
          <button
            className="karel-control-button karel-control-prepare"
            type="button"
            onClick={() => void controller.prepare()}
            disabled={!supportsDebug || active || busy}
            aria-label="Prepare & pause"
            title="Prepare and pause at the first student line"
          >
            <KarelControlIcon name="prepare" />
            <span>Prepare</span>
          </button>
          <button
            className="karel-control-button karel-control-play"
            type="button"
            onClick={() => void controller.play()}
            disabled={!supportsDebug || playing || busy || !live}
            title="Play continuously"
          >
            <KarelControlIcon name="play" />
            <span>Play</span>
          </button>
          <button
            className="karel-control-button karel-control-pause"
            type="button"
            onClick={() => controller.pause()}
            disabled={!playing}
            title="Pause playback"
          >
            <KarelControlIcon name="pause" />
            <span>Pause</span>
          </button>
          <button
            className="karel-control-button karel-control-stop"
            type="button"
            onClick={() => void controller.stop()}
            disabled={
              !active
              || transitionLocked
              || !playback.hasReachedStudentPause
            }
            title="Stop the current run"
          >
            <KarelControlIcon name="stop" />
            <span>Stop</span>
          </button>
          <button
            className="karel-control-button karel-control-reset"
            type="button"
            onClick={() => void controller.reset()}
            disabled={transitionLocked}
            title="Reset to the selected world"
          >
            <KarelControlIcon name="reset" />
            <span>Reset</span>
          </button>
          <button
            className="karel-control-button"
            type="button"
            onClick={() => void controller.restart()}
            disabled={!supportsDebug || transitionLocked}
            title="Restart playback"
          >
            <KarelControlIcon name="restart" />
            <span>Restart</span>
          </button>
        </div>

        <div className="karel-control-group karel-control-group-history" role="group" aria-label="Recorded history controls">
          <button
            className="karel-control-button"
            type="button"
            onClick={() => controller.stepBack()}
            disabled={!canStepBack}
            aria-describedby={historyExplanationId}
            title="Step back through recorded history"
          >
            <KarelControlIcon name="step-back" />
            <span>Step back</span>
          </button>
          <button
            className="karel-control-button"
            type="button"
            onClick={() => void controller.stepForward()}
            disabled={!canStepForward}
            title="Step forward"
          >
            <KarelControlIcon name="step-forward" />
            <span>Step forward</span>
          </button>
          <button
            className="karel-control-button"
            type="button"
            onClick={() => controller.showLive()}
            disabled={live}
            title="Return to the live frame"
          >
            <KarelControlIcon name="live" />
            <span>Return to live</span>
          </button>
        </div>

        <div className="karel-control-settings">
          <label className="karel-control-field">
            <span>Speed</span>
            <select
              value={playback.speedMs}
              aria-label="Playback speed"
              onChange={(event) => controller.setSpeed(Number(event.target.value))}
            >
              <option value="1000">Slow</option>
              <option value="300">Normal</option>
              <option value="100">Fast</option>
            </select>
          </label>

          {worlds.length > 0 && (
            <label className="karel-control-field karel-world-selector">
              <span>World</span>
              <select
                value={worldId}
                onChange={(event) => chooseWorld(event.target.value)}
                disabled={transitionLocked || worlds.length < 2}
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
      </div>

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

      <p id={historyExplanationId} className="karel-visually-hidden">
        Step back changes only the displayed recorded world. It does not reverse
        the live Python process.
      </p>

      <div className="karel-world-viewport">
        <div className="karel-frame-status" aria-live="polite">
          <span>{frameLabel(timeline)}</span>
          <span>
            {timeline.retention.truncated
              ? `${timeline.retention.evictedFrames} older frames discarded within the memory limit`
              : `${timeline.retention.retainedFrames} retained`}
          </span>
        </div>
        <KarelWorldView world={world} className="karel-world" />
      </div>

      <footer className="karel-panel-footer" aria-label="Karel runtime feedback">
        <span className="karel-runtime-feedback">
          <strong>Runtime</strong>
          {runtimeFeedback(visibleStatus)}
        </span>
        <span>Last action: {session.lastAction ?? 'waiting for run'}</span>
        <span>Bag: {String(world.karel.beepersInBag)} beepers</span>
        <span className="karel-world-summary">
          {world.beepers.length} beeper piles, {world.walls.length} walls,
          {' '}{world.colors.length} painted corners
        </span>
      </footer>
    </section>
  )
}
