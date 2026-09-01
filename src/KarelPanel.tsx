import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { IDEPanelServices } from 'web-ide'
import {
  DEFAULT_KAREL_PLAYBACK_LIMITS,
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
  | 'reset'
  | 'step-back'
  | 'step-forward'

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
    reset: (
      <>
        <path d="M5.5 8.5A8 8 0 1 1 4 14" />
        <path d="M5.5 3.5v5h5" />
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
  if (session.status === 'error') return 'Error'
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

const SPEED_CONTROL_MIN = 0
const MAX_SPEED_CONTROL_STEPS = 100

function speedSteps(minDelayMs: number, maxDelayMs: number): number {
  return Math.min(MAX_SPEED_CONTROL_STEPS, maxDelayMs - minDelayMs)
}

function speedDelay(
  position: number,
  minDelayMs: number,
  maxDelayMs: number,
  steps: number,
) {
  if (steps === 0) return minDelayMs
  const boundedPosition = Math.min(steps, Math.max(0, position))
  const stepsFromFast = steps - boundedPosition
  const cubicDelay = Math.round(
    minDelayMs
      + (maxDelayMs - minDelayMs) * ((stepsFromFast / steps) ** 3),
  )
  return Math.min(
    maxDelayMs,
    Math.max(minDelayMs + stepsFromFast, cubicDelay),
  )
}

function speedPosition(
  delayMs: number,
  minDelayMs: number,
  maxDelayMs: number,
  steps: number,
) {
  let nearestPosition = SPEED_CONTROL_MIN
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let position = SPEED_CONTROL_MIN; position <= steps; position += 1) {
    const distance = Math.abs(
      speedDelay(position, minDelayMs, maxDelayMs, steps) - delayMs,
    )
    if (distance < nearestDistance) {
      nearestPosition = position
      nearestDistance = distance
    }
  }
  return nearestPosition
}

function speedName(position: number, steps: number): string {
  const normalizedPosition = steps === 0 ? 1 : position / steps
  if (normalizedPosition < 0.34) return 'Slow'
  if (normalizedPosition < 0.67) return 'Normal'
  return 'Fast'
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
  const canStepBack = timeline.cursor.mode === 'live'
    ? timeline.frames.length >= 2
    : timeline.cursor.retainedIndex > 0
  const canStepForward = timeline.cursor.mode === 'history'
    || (paused && playback.runtimePaused)
  const visibleStatus = statusLabel(
    session,
    timeline,
    playback.operation,
    playback.runtimePaused,
    playback.hasReachedStudentPause,
  )
  const speedLimits = playbackLimits ?? DEFAULT_KAREL_PLAYBACK_LIMITS
  const speedControlSteps = speedSteps(
    speedLimits.minSpeedMs,
    speedLimits.maxSpeedMs,
  )
  const currentSpeedPosition = speedPosition(
    playback.speedMs,
    speedLimits.minSpeedMs,
    speedLimits.maxSpeedMs,
    speedControlSteps,
  )
  const currentSpeedName = speedName(currentSpeedPosition, speedControlSteps)
  const terminalOutcome = timeline.terminal?.detail.outcome
  const runtimeMessage = session.error
    ?? (terminalOutcome === 'runtime-error' || terminalOutcome === 'limit-exceeded'
      ? playback.message
      : playback.message?.includes('failed')
        ? playback.message
        : undefined)
  const blockedMove = live
    && session.status === 'error'
    && session.lastAction === 'KarelBlockedError'

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
      <div className="karel-playback-controls" aria-label="Karel playback controls">
        <div className="karel-control-group karel-control-group-run" role="group" aria-label="Run controls">
          <button
            className="karel-control-button karel-control-prepare"
            type="button"
            onClick={() => void controller.prepare()}
            disabled={!supportsDebug || active || busy}
            aria-label="Prepare"
            title="Prepare and pause at the first student line"
          >
            <KarelControlIcon name="prepare" />
            <span>Prepare</span>
          </button>
          <button
            className={`karel-control-button ${playing ? 'karel-control-pause' : 'karel-control-play'}`}
            type="button"
            onClick={() => {
              if (playing) controller.pause()
              else void controller.play()
            }}
            disabled={
              playing
                ? playback.operation === 'stopping'
                : !supportsDebug
                  || busy
                  || !live
                  || timeline.phase === 'advancing'
            }
            title={playing ? 'Pause playback' : 'Play continuously'}
          >
            <KarelControlIcon name={playing ? 'pause' : 'play'} />
            <span>{playing ? 'Pause' : 'Play'}</span>
          </button>
          <button
            className="karel-control-button karel-control-reset"
            type="button"
            onClick={() => void controller.reset()}
            disabled={transitionLocked}
            title="Stop the current run and reset the selected world"
          >
            <KarelControlIcon name="reset" />
            <span>Reset</span>
          </button>
        </div>

        <div className="karel-control-group karel-control-group-history" role="group" aria-label="Recorded history controls">
          <button
            className="karel-control-button"
            type="button"
            onClick={() => controller.stepBack()}
            disabled={!canStepBack || playing || busy}
            aria-describedby={historyExplanationId}
            title="Back through recorded history"
          >
            <KarelControlIcon name="step-back" />
            <span>Back</span>
          </button>
          <button
            className="karel-control-button"
            type="button"
            onClick={() => void controller.stepForward()}
            disabled={!canStepForward || playing || busy}
            aria-describedby={historyExplanationId}
            title={
              timeline.cursor.mode === 'history'
                ? 'Forward through history; the newest frame returns to live'
                : 'Advance one live step'
            }
          >
            <KarelControlIcon name="step-forward" />
            <span>Forward</span>
          </button>
        </div>

        <div className="karel-control-settings">
          <label className="karel-control-field karel-speed-control">
            <span>Speed</span>
            <input
              type="range"
              min={SPEED_CONTROL_MIN}
              max={speedControlSteps}
              step="1"
              value={currentSpeedPosition}
              aria-label="Playback speed"
              aria-valuetext={`${currentSpeedName}, ${String(playback.speedMs)} milliseconds between steps`}
              disabled={speedControlSteps === 0}
              onChange={(event) => controller.setSpeed(speedDelay(
                Number(event.target.value),
                speedLimits.minSpeedMs,
                speedLimits.maxSpeedMs,
                speedControlSteps,
              ))}
            />
            <span className="karel-speed-value" aria-hidden="true">
              {currentSpeedName}
            </span>
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

      {runtimeMessage && (
        <p
          className={session.error !== undefined || visibleStatus === 'Error'
            ? 'karel-panel-error'
            : 'karel-panel-message'}
          role={session.error !== undefined || visibleStatus === 'Error' ? 'alert' : 'note'}
          aria-live="polite"
        >
          {runtimeMessage}
        </p>
      )}

      <p id={historyExplanationId} className="karel-visually-hidden">
        Back changes only the displayed recorded world. It does not reverse the
        live Python process. Forward rejoins the live frame after the newest
        recorded frame. At the live frame, Forward advances one runtime step.
      </p>

      <div className="karel-world-viewport">
        <div className="karel-frame-status">
          <span
            className={`karel-status karel-status-${statusTone(visibleStatus)}`}
            data-status={visibleStatus.toLowerCase().replaceAll(' ', '-')}
            role="status"
            aria-live="polite"
          >
            <span className="karel-status-indicator" aria-hidden="true" />
            {visibleStatus}
          </span>
          <span className="karel-frame-position" aria-live="polite">
            {frameLabel(timeline)}
          </span>
          {timeline.retention.truncated && (
            <span>
              {timeline.retention.evictedFrames} older frames discarded
            </span>
          )}
        </div>
        <KarelWorldView
          world={world}
          className="karel-world"
          blockedMove={blockedMove}
        />
      </div>
    </section>
  )
}
