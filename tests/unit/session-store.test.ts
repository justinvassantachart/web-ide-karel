import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  KarelSessionStore,
  cloneKarelWorld,
  encodeKarelProtocolEvent,
} from '../../src'
import { createFakeRuntime } from '../helpers/fake-runtime'

describe('Karel session store', () => {
  it('tracks state frames and notifies subscribers', () => {
    const { runtime, events } = createFakeRuntime()
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const listener = vi.fn()
    store.subscribe(listener)
    const detach = store.attach(runtime)
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.avenue = 2
    const frame = encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'session-run',
      type: 'state',
      sequence: 0,
      action: 'move',
      world,
    })

    events.stdout.emit(frame.slice(0, 12))
    expect(listener).not.toHaveBeenCalled()
    events.stdout.emit(frame.slice(12))

    expect(store.getSnapshot()).toMatchObject({
      status: 'running',
      runId: 'session-run',
      lastAction: 'move',
      sequence: 0,
      world: { karel: { avenue: 2 } },
    })
    expect(listener).toHaveBeenCalledTimes(1)
    detach()
  })

  it('reference-counts runtime attachment and cleans every event listener', () => {
    const { runtime, events } = createFakeRuntime()
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const first = store.attach(runtime)
    const second = store.attach(runtime)

    expect(events.stdout.listenerCount).toBe(1)
    expect(events.terminalClear.listenerCount).toBe(1)
    expect(events.exit.listenerCount).toBe(1)
    first()
    expect(events.stdout.listenerCount).toBe(1)
    second()
    second()
    expect(events.stdout.listenerCount).toBe(0)
    expect(events.terminalClear.listenerCount).toBe(0)
    expect(events.exit.listenerCount).toBe(0)
  })

  it('resets on terminal clear and reports unsuccessful process exit', () => {
    const { runtime, events } = createFakeRuntime()
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)

    store.setUnavailable('temporary')
    events.terminalClear.emit()
    expect(store.getSnapshot()).toMatchObject({ status: 'waiting', sequence: -1 })
    events.exit.emit(3)
    expect(store.getSnapshot()).toMatchObject({
      status: 'exited',
      error: 'Python exited with code 3',
    })
    detach()
  })

  it('turns malformed private frames into a visible Karel error', () => {
    const { runtime, events } = createFakeRuntime()
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)

    events.stdout.emit('\u001b]777;web-ide-karel;not-valid!\u0007')
    expect(store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'Karel OSC payload is not valid base64url',
    })
    detach()
  })
})
