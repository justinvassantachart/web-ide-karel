// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_OSC_PREFIX,
  KAREL_OSC_TERMINATOR,
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
    expect(container.querySelectorAll('.karel-world-beepers path')).toHaveLength(21)
    expect(container.querySelectorAll('.karel-world-walls line')).toHaveLength(1)
  })

  it('renders the pixel-art icon at the correct directional rotation with a fallback', () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.direction = 'east'
    const { rerender } = render(<KarelWorldView world={world} />)

    const robot = screen.getByTestId('karel-robot')
    const icon = screen.getByTestId('karel-robot-icon')
    expect(icon.tagName.toLowerCase()).toBe('image')
    expect(icon.getAttribute('href')).toMatch(
      /^(?:data:image\/png;base64,|\/src\/assets\/karel\.png)$/u,
    )
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(robot.getAttribute('transform')).toContain('rotate(0)')
    expect(robot.getAttribute('data-direction')).toBe('east')

    for (const [direction, degrees] of [
      ['north', -90],
      ['south', 90],
      ['west', 180],
    ] as const) {
      const rotated = cloneKarelWorld(world)
      rotated.karel.direction = direction
      rerender(<KarelWorldView world={rotated} />)
      expect(robot.getAttribute('transform')).toContain(`rotate(${degrees})`)
      expect(robot.getAttribute('data-direction')).toBe(direction)
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
        `facing ${direction}`,
      )
    }

    fireEvent.error(screen.getByTestId('karel-robot-icon'))
    expect(robot.getAttribute('data-icon-state')).toBe('fallback')
    expect(screen.getByTestId('karel-robot-fallback')).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-describedby')).toBeTruthy()
  })

  it('renders maximum world dimensions with one repeated grid primitive', () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.columns = 100
    world.rows = 100
    world.beepers = []
    world.walls = []
    world.colors = []

    const { container } = render(<KarelWorldView world={world} />)

    expect(container.querySelectorAll('.karel-world-grid')).toHaveLength(1)
    expect(container.querySelectorAll('.karel-world-intersection')).toHaveLength(1)
    expect(container.querySelectorAll('.karel-world-labels text')).toHaveLength(200)
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

  it('announces a protocol error even while playback was paused', async () => {
    const { runtime, events } = createFakeRuntime()
    Object.assign(runtime.capabilities, { debug: true })
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
        workspace={{ snapshot: () => ({ '/workspace/main.py': 'move()\n' }) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
    })
    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 1,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))
    expect(screen.getByRole('status').textContent).toBe('Paused')

    act(() => events.stdout.emit(
      `${KAREL_OSC_PREFIX}not-base64!${KAREL_OSC_TERMINATOR}`,
    ))

    expect(screen.getByRole('status').textContent).toBe('Error')
    expect(screen.getByRole('alert').textContent).toBeTruthy()

    unmount()
    detach()
  })

  it('uses Reset to settle an active run and restore the initial world', async () => {
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
      fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
    })
    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 1,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    })

    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('Ready')
    expect(screen.getByText('No recorded frames')).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'avenue 1, street 1, facing east',
    )
    expect(screen.queryByText('Karel run stopped.')).toBeNull()

    unmount()
    detach()
  })

  it('locks Reset and world selection until the runtime actually pauses', async () => {
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
      fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('debug'))
    expect(screen.getByRole('status').textContent).toContain('Starting')
    const resetButton = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement
    const worldSelect = screen.getByLabelText('World') as HTMLSelectElement
    expect(resetButton.disabled).toBe(true)
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
    expect(resetButton.disabled).toBe(true)
    expect(worldSelect.disabled).toBe(true)
    fireEvent.click(resetButton)
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
    expect(resetButton.disabled).toBe(false)
    expect(worldSelect.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(resetButton)
    })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Ready')

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

    const { container, unmount } = render(
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
    expect(screen.getByRole('group', { name: 'Run controls' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Recorded history controls' })).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim()))
      .toEqual(['Prepare', 'Play', 'Reset', 'Back', 'Forward'])
    expect(
      (screen.getByRole('button', { name: 'Prepare' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return to live' })).toBeNull()
    expect(container.querySelector('.karel-panel-header')).toBeNull()
    expect(container.querySelector('.karel-panel-footer')).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(container.querySelector('svg title')?.textContent).toContain(
      'Avenue 1, street 1',
    )
    const playbackSpeed = screen.getByLabelText('Playback speed') as HTMLInputElement
    expect(playbackSpeed.type).toBe('range')
    expect(playbackSpeed.min).toBe('0')
    expect(playbackSpeed.max).toBe('100')
    expect(playbackSpeed.value).toBe('50')
    expect(playbackSpeed.getAttribute('aria-valuetext')).toBe(
      'Normal, 300 milliseconds between steps',
    )
    fireEvent.change(playbackSpeed, { target: { value: '100' } })
    expect(playbackSpeed.value).toBe('100')
    expect(playbackSpeed.getAttribute('aria-valuetext')).toBe(
      'Fast, 50 milliseconds between steps',
    )
    fireEvent.change(playbackSpeed, { target: { value: '95' } })
    expect(playbackSpeed.value).toBe('95')
    expect(playbackSpeed.getAttribute('aria-valuetext')).toMatch(
      /^Fast, (?!50\b)\d+ milliseconds between steps$/u,
    )
    expect(screen.getByLabelText('World')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Prepare' }).querySelector(
      '[data-karel-control-icon="prepare"]',
    )).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Play' }).querySelector(
      '[data-karel-control-icon="play"]',
    )).toBeTruthy()
    const back = screen.getByRole('button', { name: 'Back' })
    const forward = screen.getByRole('button', { name: 'Forward' })
    const historyExplanationId = back.getAttribute('aria-describedby')
    expect(historyExplanationId).toBeTruthy()
    expect(forward.getAttribute('aria-describedby')).toBe(historyExplanationId)
    expect(document.getElementById(historyExplanationId!)?.textContent).toContain(
      'does not reverse the live Python process',
    )
    expect(document.getElementById(historyExplanationId!)?.textContent).toContain(
      'Forward rejoins the live frame',
    )
    expect(document.getElementById(historyExplanationId!)?.textContent).toContain(
      'Forward advances one runtime step',
    )
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(playbackSpeed.tabIndex).toBe(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
    })
    expect(start).toHaveBeenCalledWith('debug')
    const reset = screen.getByRole('button', { name: 'Reset' })
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause' }).querySelector(
      '[data-karel-control-icon="pause"]',
    )).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Play' }).querySelector(
      '[data-karel-control-icon="play"]',
    )).toBeTruthy()
    reset.focus()
    expect(document.activeElement).toBe(reset)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('World'), {
        target: { value: 'second' },
      })
    })
    expect(stop).toHaveBeenCalled()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'Second world: Karel at avenue 3',
    )
    expect(container.querySelector('svg title')?.textContent).toContain(
      'Second world. Avenue 3',
    )

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

  it('labels the live frontier and recorded history without claiming process rewind', async () => {
    const { runtime, events } = createFakeRuntime()
    Object.assign(runtime.capabilities, { debug: true })
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
        workspace={{ snapshot: () => ({ '/workspace/main.py': 'move()\n' }) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prepare' }))
    })
    act(() => events.debugPaused.emit({
      file: '/main.py',
      line: 1,
      func: 'main',
      callStack: [],
      memorySnapshot: null,
    }))

    const moved = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    moved.karel.avenue = 2
    act(() => events.stdout.emit(encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'history-labels',
      type: 'state',
      sequence: 0,
      action: 'move',
      world: moved,
    })))

    expect(screen.getByText('Live frame 2 of 2')).toBeTruthy()
    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement
    const forward = screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement
    expect(back.disabled).toBe(false)
    fireEvent.click(back)
    expect(screen.getByRole('status').textContent).toContain('History')
    expect(screen.getByText('Recorded frame 1 of 2')).toBeTruthy()
    expect(screen.queryByText(/Viewing recorded history/)).toBeNull()
    expect(back.disabled).toBe(true)
    expect(forward.disabled).toBe(false)
    expect(forward.title).toContain('newest frame returns to live')
    expect(screen.queryByRole('button', { name: 'Return to live' })).toBeNull()

    await act(async () => {
      fireEvent.click(forward)
    })
    expect(screen.getByText('Live frame 2 of 2')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Paused')
    expect(back.disabled).toBe(false)

    act(() => events.stdout.emit(encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'history-labels',
      type: 'terminal',
      sequence: 1,
      outcome: 'limit-exceeded',
      reason: 'event-limit',
      message: 'Karel action limit reached.',
      world: moved,
    })))
    expect(screen.getByRole('status').textContent).toContain('Limit reached')
    expect(screen.getByText('Karel action limit reached.')).toBeTruthy()

    unmount()
    detach()
  })
})
