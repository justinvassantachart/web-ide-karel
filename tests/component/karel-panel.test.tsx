// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
        store={store}
        workspace={{ snapshot: () => ({}) }}
        panels={{ reveal: () => undefined }}
      />,
    )

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'avenue 1, street 1',
    )
    expect(screen.getByRole('status').textContent).toContain('Ready')

    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.avenue = 2
    world.karel.direction = 'north'
    const frame = encodeKarelProtocolEvent({
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      type: 'state',
      sequence: 2,
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
})
