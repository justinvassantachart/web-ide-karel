import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KAREL_PLAYBACK_LIMITS,
  KarelPlaybackController,
  type KarelPlaybackLimits,
} from '../../src/playback-controller'
import { DEFAULT_KAREL_WORLD } from '../../src/assets'
import { KarelSessionStore } from '../../src/session-store'
import {
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  type KarelProtocolEvent,
} from '../../src/types'
import { cloneKarelWorld } from '../../src/world'
import { encodeKarelProtocolEvent } from '../../src/protocol'
import { createFakeRuntime } from '../helpers/fake-runtime'

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  vi.useRealTimers()
})

function setup(options: {
  limits?: Partial<KarelPlaybackLimits>
  now?: () => number
} = {}) {
  const fake = createFakeRuntime()
  const start = vi.fn(async () => undefined)
  const stop = vi.fn(async () => undefined)
  const restart = vi.fn(async () => undefined)
  const reveal = vi.fn()
  const replaceDecorations = vi.fn()
  const clearDecorations = vi.fn()
  const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
  const detach = store.attach(fake.runtime)
  const services = {
    runtime: fake.runtime,
    execution: { start, stop, restart },
    source: {
      reveal,
      replaceDecorations,
      clearDecorations,
      dispose: vi.fn(),
    },
    workspace: {
      snapshot: () => ({
        '/workspace/main.py': 'first()\nsecond()\nthird()\n',
        '/workspace/helpers/steps.py': 'move()\n',
      }),
    },
    store,
    ...(options.limits === undefined
      ? {}
      : {
          limits: {
            ...DEFAULT_KAREL_PLAYBACK_LIMITS,
            ...options.limits,
          },
        }),
    ...(options.now === undefined ? {} : { now: options.now }),
  } satisfies ConstructorParameters<typeof KarelPlaybackController>[0]
  const controller = new KarelPlaybackController(services)
  const deactivate = controller.activate()
  cleanup.push(() => controller.dispose(), deactivate, detach)
  return {
    ...fake,
    controller,
    store,
    start,
    stop,
    restart,
    reveal,
    replaceDecorations,
    clearDecorations,
  }
}

function pause(file: string, line: number) {
  return {
    file,
    line,
    func: 'main',
    callStack: [],
    memorySnapshot: null,
  }
}

function frame(event: KarelProtocolEvent): string {
  return encodeKarelProtocolEvent(event)
}

describe('KarelPlaybackController', () => {
  it('filters support pauses and records only eligible workspace lines', async () => {
    const fixture = setup()
    const continueExecution = vi.spyOn(fixture.runtime, 'continueExecution')

    await fixture.controller.prepare()
    expect(fixture.start).toHaveBeenCalledWith('debug')

    fixture.events.debugPaused.emit(pause('/sysroot/karel.py', 10))
    expect(continueExecution).toHaveBeenCalledTimes(1)
    fixture.events.debugPaused.emit(pause('/main.py', 2))

    const snapshot = fixture.controller.getSnapshot()
    expect(snapshot.timeline.frames).toHaveLength(1)
    expect(snapshot.timeline.displayedFrame?.source).toEqual({
      path: 'main.py',
      line: 2,
    })
    expect(fixture.replaceDecorations).toHaveBeenLastCalledWith([
      { path: '/workspace/main.py', line: 2, kind: 'current' },
    ])
    expect(fixture.reveal).toHaveBeenLastCalledWith({
      path: '/workspace/main.py',
      line: 2,
    })
  })

  it('owns a transient workspace overlay and clears only that owner', async () => {
    const fixture = setup()
    const replace = vi.spyOn(fixture.runtime, 'replaceBreakpointOverlay')
    const clear = vi.spyOn(fixture.runtime, 'clearBreakpointOverlay')

    await fixture.controller.prepare()

    expect(replace).toHaveBeenCalledTimes(1)
    const [owner, breakpoints] = replace.mock.calls[0] as unknown as [
      object,
      Record<string, readonly number[]>,
    ]
    expect(typeof owner).toBe('object')
    expect(breakpoints).toEqual({
      '/workspace/helpers/steps.py': [1],
      '/workspace/main.py': [1, 2, 3],
    })

    await fixture.controller.stop()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(owner)
  })

  it('fails closed when the selected runtime lacks isolated overlays', async () => {
    const fixture = setup()
    const unsupportedRuntime = fixture.runtime as Partial<typeof fixture.runtime>
    delete unsupportedRuntime.replaceBreakpointOverlay
    delete unsupportedRuntime.clearBreakpointOverlay

    await fixture.controller.prepare()

    expect(fixture.start).not.toHaveBeenCalled()
    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'runtime-error',
      message: 'The selected runtime does not support isolated Karel line playback.',
    })
  })

  it('cancels an in-flight overlay install before reset can start Python', async () => {
    const fixture = setup()
    let finishInstall: (() => void) | undefined
    const replace = vi.spyOn(fixture.runtime, 'replaceBreakpointOverlay')
      .mockImplementation(() => new Promise<undefined>((resolve) => {
        finishInstall = () => resolve(undefined)
      }))
    const clear = vi.spyOn(fixture.runtime, 'clearBreakpointOverlay')

    const preparing = fixture.controller.prepare()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    const resetting = fixture.controller.reset()
    finishInstall?.()
    await Promise.all([preparing, resetting])

    expect(fixture.start).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(fixture.controller.getSnapshot().timeline.activeRunId).toBeUndefined()
  })

  it('coalesces concurrent prepare requests into one runtime start', async () => {
    const fixture = setup()
    const replace = vi.spyOn(fixture.runtime, 'replaceBreakpointOverlay')

    await Promise.all([
      fixture.controller.prepare(),
      fixture.controller.prepare(),
    ])

    expect(replace).toHaveBeenCalledTimes(1)
    expect(fixture.start).toHaveBeenCalledTimes(1)
  })

  it('advances the live runtime and scrubs recorded history without reversing it', async () => {
    const fixture = setup()
    const continueExecution = vi.spyOn(fixture.runtime, 'continueExecution')
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))

    await fixture.controller.stepForward()
    expect(continueExecution).toHaveBeenCalledTimes(1)
    fixture.events.debugPaused.emit(pause('/main.py', 2))
    expect(fixture.controller.getSnapshot().timeline.frames).toHaveLength(2)

    fixture.controller.stepBack()
    expect(fixture.controller.getSnapshot().timeline.cursor.mode).toBe('history')
    expect(fixture.replaceDecorations).toHaveBeenLastCalledWith([
      { path: '/workspace/main.py', line: 1, kind: 'historical' },
    ])

    await fixture.controller.stepForward()
    expect(fixture.controller.getSnapshot().timeline.cursor.mode).toBe('live')
    expect(continueExecution).toHaveBeenCalledTimes(1)
  })

  it('plays at the selected delay and pauses between source lines', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const continueExecution = vi.spyOn(fixture.runtime, 'continueExecution')
    const play = fixture.controller.play()
    await play
    fixture.events.debugPaused.emit(pause('/main.py', 1))

    await vi.advanceTimersByTimeAsync(299)
    expect(continueExecution).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(continueExecution).toHaveBeenCalledTimes(1)

    fixture.events.debugPaused.emit(pause('/main.py', 2))
    fixture.controller.pause()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(continueExecution).toHaveBeenCalledTimes(1)
    expect(fixture.controller.getSnapshot().message).toContain('not been reversed')
  })

  it('correlates validated protocol actions and preserves terminal detail', async () => {
    const fixture = setup()
    await fixture.controller.prepare()
    const moved = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    moved.karel.avenue = 2
    fixture.events.stdout.emit(frame({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'runtime-run',
      sequence: 0,
      type: 'state',
      action: 'move',
      source: { path: 'main.py', line: 2 },
      world: moved,
    }))
    fixture.events.stdout.emit(frame({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'runtime-run',
      sequence: 1,
      type: 'terminal',
      outcome: 'completed',
      source: { path: 'main.py', line: 3 },
      world: moved,
    }))

    const timeline = fixture.controller.getSnapshot().timeline
    expect(timeline.frames.at(-1)).toMatchObject({
      kind: 'action',
      action: 'move',
      world: { karel: { avenue: 2 } },
    })
    expect(timeline.terminal?.detail).toMatchObject({
      outcome: 'completed',
      world: { karel: { avenue: 2 } },
    })
    expect(fixture.controller.getSnapshot().message).toBe('Karel run completed.')
  })

  it('settles and stops on pause limits', async () => {
    const fixture = setup({ limits: { maxPauses: 1 } })
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))
    fixture.events.debugPaused.emit(pause('/main.py', 2))
    await Promise.resolve()

    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'limit-exceeded',
      reason: 'pause-limit',
    })
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })

  it('reports an exit without a protocol settlement and revokes subscriptions', async () => {
    const fixture = setup()
    await fixture.controller.prepare()
    const beforeDispose = fixture.events.debugPaused.listenerCount
    fixture.events.exit.emit(0)
    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'runtime-error',
      message: 'Python exited without a Karel terminal event.',
    })

    fixture.controller.dispose()
    expect(fixture.events.debugPaused.listenerCount).toBe(beforeDispose - 1)
    expect(fixture.clearDecorations).toHaveBeenCalled()
  })

  it('stops active Python and clears its overlay when the panel deactivates', async () => {
    const fixture = setup()
    const clear = vi.spyOn(fixture.runtime, 'clearBreakpointOverlay')
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))

    const deactivate = fixture.controller.activate()
    deactivate()
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1))

    expect(fixture.events.debugPaused.listenerCount).toBe(0)
  })

  it('settles an exit emitted by an explicit settled stop as aborted', async () => {
    const fixture = setup()
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))
    fixture.stop.mockImplementationOnce(async () => {
      fixture.events.exit.emit(0)
    })

    await fixture.controller.stop()

    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'aborted',
    })
    expect(fixture.controller.getSnapshot().message).toBe('Karel run stopped.')
  })

  it('awaits a limit-triggered stop before starting a replacement run', async () => {
    const fixture = setup({ limits: { maxPauses: 1 } })
    let releaseStop: (() => void) | undefined
    fixture.stop.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        releaseStop = () => resolve(undefined)
      }),
    )
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))
    fixture.events.debugPaused.emit(pause('/main.py', 2))
    await Promise.resolve()

    const restart = fixture.controller.restart()
    await Promise.resolve()
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    expect(fixture.start).toHaveBeenCalledTimes(1)
    expect(fixture.controller.getSnapshot().operation).toBe('stopping')

    releaseStop?.()
    await restart
    expect(fixture.start).toHaveBeenCalledTimes(2)
    expect(fixture.start).toHaveBeenLastCalledWith('debug')
  })

  it('bounds line-only support pauses even when no Karel action is emitted', async () => {
    const fixture = setup({ limits: { maxPauses: 2 } })
    await fixture.controller.prepare()

    fixture.events.debugPaused.emit(pause('/sysroot/karel.py', 10))
    fixture.events.debugPaused.emit(pause('/sysroot/karel.py', 11))
    fixture.events.debugPaused.emit(pause('/sysroot/karel.py', 12))
    await Promise.resolve()

    expect(fixture.controller.getSnapshot().timeline.frames).toEqual([])
    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'limit-exceeded',
      reason: 'pause-limit',
    })
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })

  it('combines UTF-8 stdout and stderr bytes under one output limit', async () => {
    const fixture = setup({ limits: { maxOutputBytes: 6 } })
    await fixture.controller.prepare()

    fixture.events.stdout.emit('abc')
    fixture.events.stderr.emit('🟦')
    await Promise.resolve()

    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'limit-exceeded',
      reason: 'output-byte-limit',
    })
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    fixture.events.stdout.emit('ignored after settlement')
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })

  it('settles and stops at the elapsed-time limit without a runtime event', async () => {
    vi.useFakeTimers()
    const fixture = setup({ limits: { maxElapsedMs: 25 } })
    await fixture.controller.prepare()

    await vi.advanceTimersByTimeAsync(24)
    expect(fixture.controller.getSnapshot().timeline.terminal).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(fixture.controller.getSnapshot().timeline.terminal?.detail).toMatchObject({
      outcome: 'limit-exceeded',
      reason: 'elapsed-time-limit',
    })
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })

  it('clamps playback speed deterministically and rejects non-integers', () => {
    const fixture = setup()

    fixture.controller.setSpeed(1)
    expect(fixture.controller.getSnapshot().speedMs).toBe(
      DEFAULT_KAREL_PLAYBACK_LIMITS.minSpeedMs,
    )
    fixture.controller.setSpeed(10_000)
    expect(fixture.controller.getSnapshot().speedMs).toBe(
      DEFAULT_KAREL_PLAYBACK_LIMITS.maxSpeedMs,
    )
    expect(() => fixture.controller.setSpeed(1.5)).toThrow('safe integer')
  })

  it('does not admit a late prior-run frame after restart', async () => {
    const fixture = setup()
    await fixture.controller.prepare()
    const staleWorld = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    staleWorld.karel.avenue = 2
    const stale = frame({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'prior-runtime-run',
      sequence: 0,
      type: 'state',
      action: 'move',
      world: staleWorld,
    })
    fixture.events.stdout.emit(stale)
    expect(fixture.controller.getSnapshot().timeline.frames).toHaveLength(1)

    await fixture.controller.restart()
    expect(fixture.controller.getSnapshot().timeline.frames).toEqual([])
    fixture.events.stdout.emit(stale)

    expect(fixture.controller.getSnapshot().timeline.frames).toEqual([])
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: 'waiting',
      sequence: -1,
      world: { karel: { avenue: 1 } },
    })
  })

  it('isolates two controller instances and disposes only owned listeners', async () => {
    const first = setup()
    const second = setup()
    await first.controller.prepare()
    await second.controller.prepare()

    first.events.debugPaused.emit(pause('/main.py', 1))
    expect(first.controller.getSnapshot().timeline.frames).toHaveLength(1)
    expect(second.controller.getSnapshot().timeline.frames).toEqual([])
    expect(first.events.debugPaused.listenerCount).toBe(1)
    expect(second.events.debugPaused.listenerCount).toBe(1)

    first.controller.dispose()
    expect(first.events.debugPaused.listenerCount).toBe(0)
    expect(second.events.debugPaused.listenerCount).toBe(1)
    second.events.debugPaused.emit(pause('/main.py', 2))
    expect(second.controller.getSnapshot().timeline.frames).toHaveLength(1)
  })

  it('selects a new reset world without mutating student files', async () => {
    const fixture = setup()
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.name = 'Second world'
    world.karel.avenue = 3

    await fixture.controller.selectWorld(world)
    expect(fixture.store.getSnapshot()).toMatchObject({
      status: 'waiting',
      world: { name: 'Second world', karel: { avenue: 3 } },
    })
    expect(fixture.controller.getSnapshot().timeline.phase).toBe('idle')
    expect(fixture.clearDecorations).toHaveBeenCalled()
  })
})
