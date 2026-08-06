import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
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

const { runtime, events } = createFakeRuntime()
const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)

export function Fixture() {
  useEffect(() => store.attach(runtime), [])

  const move = () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.avenue = 2
    events.stdout.emit(
      encodeKarelProtocolEvent({
        protocol: KAREL_PROTOCOL_NAME,
        version: KAREL_PROTOCOL_VERSION,
        type: 'state',
        sequence: 1,
        action: 'move',
        world,
      }),
    )
  }

  return (
    <main id="fixture">
      <div id="controls">
        <button type="button" onClick={move}>
          Emit move
        </button>
      </div>
      <KarelPanel
        runtime={runtime}
        store={store}
        workspace={{ snapshot: () => ({}) }}
        panels={{ reveal: () => undefined }}
      />
    </main>
  )
}

const container = document.querySelector('#root')
if (!container) throw new Error('Browser fixture root is missing')
const root = createRoot(container)
root.render(<Fixture />)

Object.assign(window, {
  __karelBrowserTest: {
    unmount: () => root.unmount(),
    stdoutListenerCount: () => events.stdout.listenerCount,
  },
})
