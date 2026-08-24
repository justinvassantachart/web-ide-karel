import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KAREL_PLAYBACK_LIMITS,
  KarelPlaybackController,
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

function setup(options: { maxPauses?: number } = {}) {
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
    ...(options.maxPauses === undefined
      ? {}
      : {
          limits: {
            ...DEFAULT_KAREL_PLAYBACK_LIMITS,
            maxPauses: options.maxPauses,
          },
        }),
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
    const stepOver = vi.spyOn(fixture.runtime, 'stepOver')

    await fixture.controller.prepare()
    expect(fixture.start).toHaveBeenCalledWith('debug')

    fixture.events.debugPaused.emit(pause('/sysroot/karel.py', 10))
    expect(stepOver).toHaveBeenCalledTimes(1)
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

  it('advances the live runtime and scrubs recorded history without reversing it', async () => {
    const fixture = setup()
    const stepOver = vi.spyOn(fixture.runtime, 'stepOver')
    await fixture.controller.prepare()
    fixture.events.debugPaused.emit(pause('/main.py', 1))

    await fixture.controller.stepForward()
    expect(stepOver).toHaveBeenCalledTimes(1)
    fixture.events.debugPaused.emit(pause('/main.py', 2))
    expect(fixture.controller.getSnapshot().timeline.frames).toHaveLength(2)

    fixture.controller.stepBack()
    expect(fixture.controller.getSnapshot().timeline.cursor.mode).toBe('history')
    expect(fixture.replaceDecorations).toHaveBeenLastCalledWith([
      { path: '/workspace/main.py', line: 1, kind: 'historical' },
    ])

    await fixture.controller.stepForward()
    expect(fixture.controller.getSnapshot().timeline.cursor.mode).toBe('live')
    expect(stepOver).toHaveBeenCalledTimes(1)
  })

  it('plays at the selected delay and pauses between source lines', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const stepOver = vi.spyOn(fixture.runtime, 'stepOver')
    const play = fixture.controller.play()
    await play
    fixture.events.debugPaused.emit(pause('/main.py', 1))

    await vi.advanceTimersByTimeAsync(299)
    expect(stepOver).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stepOver).toHaveBeenCalledTimes(1)

    fixture.events.debugPaused.emit(pause('/main.py', 2))
    fixture.controller.pause()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stepOver).toHaveBeenCalledTimes(1)
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
    const fixture = setup({ maxPauses: 1 })
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
    const fixture = setup({ maxPauses: 1 })
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
