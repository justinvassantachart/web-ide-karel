// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  KarelPanel,
  KarelSessionStore,
  cloneKarelWorld,
  encodeKarelProtocolEvent,
} from '../../src'
import { createFakeRuntime } from '../helpers/fake-runtime'

afterEach(cleanup)

describe('Karel panel', () => {
  it('renders a responsive world and updates the robot from runtime events', () => {
    const { runtime, events } = createFakeRuntime()
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)
    const { unmount } = render(
      <KarelPanel
        runtime={runtime}
        execution={{
          start: async () => undefined,
          stop: () => undefined,
          restart: async () => undefined,
        }}
        source={{
          reveal: () => undefined,
          replaceDecorations: () => undefined,
          clearDecorations: () => undefined,
          dispose: () => undefined,
        }}
        store={store}
        workspace={{ snapshot: () => ({}) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'avenue 1, street 1',
    )
    expect(screen.getByText(/Beeper piles: 1 at avenue 4, street 1/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Ready')

    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.avenue = 2
    world.karel.direction = 'north'
    const frame = encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'component-run',
      type: 'state',
      sequence: 0,
      action: 'move',
      world,
    })
    act(() => events.stdout.emit(frame))

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'avenue 2, street 1, facing north',
    )
    expect(screen.getByRole('status').textContent).toContain('Running')
    expect(screen.getByText('Last action: move')).toBeTruthy()

    unmount()
    detach()
    expect(events.stdout.listenerCount).toBe(0)
  })

  it('explains when the selected runtime is not Python', () => {
    const { runtime } = createFakeRuntime(['rust'])
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    store.setUnavailable(
      'Karel requires a selected runtime session that advertises the Python language ID.',
    )

    render(
      <KarelPanel
        runtime={runtime}
        execution={{
          start: async () => undefined,
          stop: () => undefined,
          restart: async () => undefined,
        }}
        source={{
          reveal: () => undefined,
          replaceDecorations: () => undefined,
          clearDecorations: () => undefined,
          dispose: () => undefined,
        }}
        store={store}
        workspace={{ snapshot: () => ({}) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    expect(screen.getByRole('note').textContent).toContain('Select a Python runtime')
    expect(screen.getByRole('alert').textContent).toContain(
      'requires a selected runtime',
    )
  })

  it('exposes accessible playback, source, multi-world, and Strict Mode cleanup', async () => {
    const { runtime, events } = createFakeRuntime()
    Object.assign(runtime.capabilities, { debug: true })
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const reveal = vi.fn()
    const replaceDecorations = vi.fn()
    const secondWorld = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    secondWorld.name = 'Second world'
    secondWorld.karel.avenue = 3

    const { unmount } = render(
      <StrictMode>
        <KarelPanel
          runtime={runtime}
          execution={{ start, stop, restart: vi.fn(async () => undefined) }}
          source={{
            reveal,
            replaceDecorations,
            clearDecorations: vi.fn(),
            dispose: vi.fn(),
          }}
          store={store}
          worlds={[
            { id: 'first', label: 'First world', world: DEFAULT_KAREL_WORLD },
            { id: 'second', label: 'Second world', world: secondWorld },
          ]}
          selectedWorldId="first"
          workspace={{
            snapshot: () => ({ '/workspace/main.py': 'first()\nsecond()\n' }),
          }}
          panels={{ reveal: vi.fn() }}
        />
      </StrictMode>,
    )

    expect(screen.getByLabelText('Karel playback controls')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Prepare & pause' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(screen.getByLabelText('Playback speed')).toBeTruthy()
    expect(screen.getByLabelText('World')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare & pause' }))
    })
    expect(start).toHaveBeenCalledWith('debug')
    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 2,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))
    expect(screen.getByRole('status').textContent).toContain('Paused')
    expect(screen.getByText('Live frame 1 of 1')).toBeTruthy()
    expect(replaceDecorations).toHaveBeenLastCalledWith([
      { path: '/workspace/main.py', line: 2, kind: 'current' },
    ])
    expect(reveal).toHaveBeenLastCalledWith({
      path: '/workspace/main.py',
      line: 2,
    })

    await act(async () => {
      fireEvent.change(screen.getByLabelText('World'), {
        target: { value: 'second' },
      })
    })
    expect(stop).toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Second world' })).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('avenue 3')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    })
    expect(screen.getByRole('status').textContent).toContain('Ready')
    expect(screen.getByText('No recorded frames')).toBeTruthy()

    expect(events.debugPaused.listenerCount).toBe(1)
    unmount()
    expect(events.debugPaused.listenerCount).toBe(0)
    expect(events.stdout.listenerCount).toBe(1)
    detach()
    expect(events.stdout.listenerCount).toBe(0)
  })
})
