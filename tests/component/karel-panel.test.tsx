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
  KarelWorldView,
  cloneKarelWorld,
  encodeKarelProtocolEvent,
} from '../../src'
import { createFakeRuntime } from '../helpers/fake-runtime'

afterEach(cleanup)

describe('Karel panel', () => {
  it('provides a bounded textual equivalent for every visual world feature', () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.beepers = Array.from({ length: 21 }, (_, index) => ({
      avenue: (index % 10) + 1,
      street: Math.floor(index / 10) + 1,
      count: index + 1,
    }))
    world.walls = [{ avenue: 3, street: 2, direction: 'east' }]
    world.colors = [{ avenue: 4, street: 3, color: 'purple' }]
    const { container } = render(<KarelWorldView world={world} />)

    const image = screen.getByRole('img')
    const descriptionId = image.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    const description = document.getElementById(descriptionId ?? '')?.textContent
    expect(description).toContain('10 avenues by 8 streets')
    expect(description).toContain('Karel is at avenue 1, street 1, facing east')
    expect(description).toContain('Beeper piles: 1 at avenue 1, street 1')
    expect(description).toContain('and 1 more')
    expect(description).toContain('Walls: east of avenue 3, street 2')
    expect(description).toContain('Painted corners: purple at avenue 4, street 3')
    expect(container.querySelectorAll('.karel-world-beepers circle')).toHaveLength(21)
    expect(container.querySelectorAll('.karel-world-walls line')).toHaveLength(1)
  })

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

  it('keeps an explicit stop visible after the runtime clears its terminal', async () => {
    const { runtime, events } = createFakeRuntime()
    Object.assign(runtime.capabilities, { debug: true })
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)
    const stop = vi.fn(async () => {
      events.exit.emit(0)
      events.terminalClear.emit()
    })

    const { unmount } = render(
      <KarelPanel
        runtime={runtime}
        execution={{
          start: async () => undefined,
          stop,
          restart: async () => undefined,
        }}
        source={{
          reveal: () => undefined,
          replaceDecorations: () => undefined,
          clearDecorations: () => undefined,
          dispose: () => undefined,
        }}
        store={store}
        workspace={{ snapshot: () => ({ '/workspace/main.py': 'move()\n' }) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare & pause' }))
    })
    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 1,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Stopped')
    expect(screen.getByText('Karel run stopped.')).toBeTruthy()

    unmount()
    detach()
  })

  it('does not permit run transitions until the runtime actually pauses', async () => {
    const { runtime, events } = createFakeRuntime()
    Object.assign(runtime.capabilities, { debug: true })
    const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
    const detach = store.attach(runtime)
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const restart = vi.fn(async () => undefined)
    const selectWorld = vi.fn()
    const secondWorld = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    secondWorld.name = 'Second world'

    const { unmount } = render(
      <KarelPanel
        runtime={runtime}
        execution={{ start, stop, restart }}
        source={{
          reveal: () => undefined,
          replaceDecorations: () => undefined,
          clearDecorations: () => undefined,
          dispose: () => undefined,
        }}
        store={store}
        worlds={[
          { id: 'first', label: 'First world', world: DEFAULT_KAREL_WORLD },
          { id: 'second', label: 'Second world', world: secondWorld },
        ]}
        selectedWorldId="first"
        onSelectWorld={selectWorld}
        workspace={{ snapshot: () => ({ '/workspace/main.py': 'move()\n' }) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare & pause' }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('debug'))
    expect(screen.getByRole('status').textContent).toContain('Starting')
    const stopButton = screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement
    const resetButton = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement
    const restartButton = screen.getByRole('button', { name: 'Restart' }) as HTMLButtonElement
    const worldSelect = screen.getByLabelText('World') as HTMLSelectElement
    expect(stopButton.disabled).toBe(true)
    expect(resetButton.disabled).toBe(true)
    expect(restartButton.disabled).toBe(true)
    expect(worldSelect.disabled).toBe(true)

    const startupWorld = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    act(() => events.stdout.emit(encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'component-startup',
      type: 'state',
      sequence: 0,
      action: 'load',
      world: startupWorld,
    })))
    expect(screen.getByRole('status').textContent).toContain('Starting')
    expect(stopButton.disabled).toBe(true)
    expect(resetButton.disabled).toBe(true)
    expect(restartButton.disabled).toBe(true)
    expect(worldSelect.disabled).toBe(true)
    fireEvent.click(resetButton)
    fireEvent.click(restartButton)
    fireEvent.change(worldSelect, { target: { value: 'second' } })
    expect(stop).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(selectWorld).not.toHaveBeenCalled()

    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 1,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))
    expect(screen.getByRole('status').textContent).toContain('Paused')
    expect(stopButton.disabled).toBe(false)
    expect(resetButton.disabled).toBe(false)
    expect(restartButton.disabled).toBe(false)
    expect(worldSelect.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(stopButton)
    })
    expect(screen.getByRole('status').textContent).toContain('Stopped')

    unmount()
    detach()
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
    const stepBack = screen.getByRole('button', { name: 'Step back' })
    expect(stepBack.getAttribute('aria-describedby')).toBe(
      'karel-history-explanation',
    )
    expect(document.getElementById('karel-history-explanation')?.textContent).toContain(
      'does not reverse the live Python process',
    )
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect((screen.getByLabelText('Playback speed') as HTMLElement).tabIndex).toBe(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare & pause' }))
    })
    expect(start).toHaveBeenCalledWith('debug')
    const reset = screen.getByRole('button', { name: 'Reset' })
    const playbackSpeed = screen.getByLabelText('Playback speed')
    playbackSpeed.focus()
    expect(document.activeElement).toBe(playbackSpeed)
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
    expect(document.activeElement).toBe(playbackSpeed)
    reset.focus()
    expect(document.activeElement).toBe(reset)

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
