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
const browserRuntime = {
  ...runtime,
  capabilities: { ...runtime.capabilities, debug: true },
}
const store = new KarelSessionStore(DEFAULT_KAREL_WORLD)
let sequence = 0

export function Fixture() {
  useEffect(() => store.attach(browserRuntime), [])

  const move = () => {
    const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    world.karel.avenue = 2
    world.karel.direction = 'south'
    events.stdout.emit(
      encodeKarelProtocolEvent({
        protocol: KAREL_PROTOCOL_NAME,
        version: KAREL_PROTOCOL_VERSION,
        runId: 'browser-fixture',
        type: 'state',
        sequence,
        action: 'move',
        source: { path: 'main.py', line: 1 },
        world,
      }),
    )
    sequence += 1
  }

  const blockedMove = () => {
    events.stdout.emit(
      encodeKarelProtocolEvent({
        protocol: KAREL_PROTOCOL_NAME,
        version: KAREL_PROTOCOL_VERSION,
        runId: 'browser-fixture',
        type: 'terminal',
        sequence,
        outcome: 'runtime-error',
        message: 'Karel cannot move: the front is blocked',
        errorType: 'KarelBlockedError',
        world: cloneKarelWorld(DEFAULT_KAREL_WORLD),
      }),
    )
    sequence += 1
  }

  return (
    <main id="fixture">
      <div id="controls">
        <button type="button" onClick={move}>
          Emit move
        </button>
        <button type="button" onClick={blockedMove}>
          Emit blocked move
        </button>
      </div>
      <KarelPanel
        runtime={browserRuntime}
        execution={{
          start: async () => {
            events.debugPaused.emit({
              file: '/workspace/main.py',
              line: 1,
              func: 'main',
              callStack: [],
              memorySnapshot: null,
            })
          },
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
        timelineLimits={{ maxFrames: 4, maxBytes: 1024 * 1024 }}
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
