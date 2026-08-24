import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  WebIDE,
  WebIDEHostProvider,
  initWebIDETheme,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import { pythonRuntimePlugin } from 'web-ide/runtimes'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_WORLD_SCHEMA_NAME,
  KAREL_WORLD_SCHEMA_VERSION,
  createKarelPlugin,
  type KarelWorldDocumentV1,
} from '@web-ide/karel'
import 'web-ide/styles.css'
import '@web-ide/karel/styles.css'

const beeperTrail: KarelWorldDocumentV1 = {
  schema: KAREL_WORLD_SCHEMA_NAME,
  version: KAREL_WORLD_SCHEMA_VERSION,
  world: {
    name: 'Beeper Trail',
    columns: 6,
    rows: 5,
    karel: {
      avenue: 1,
      street: 1,
      direction: 'east',
      beepersInBag: 0,
    },
    beepers: [
      { avenue: 2, street: 1, count: 1 },
      { avenue: 4, street: 1, count: 2 },
    ],
    walls: [{ avenue: 3, street: 2, direction: 'north' }],
    colors: [{ avenue: 6, street: 5, color: '#22c55e' }],
  },
}

const karelPlugin = createKarelPlugin({
  worlds: [
    {
      id: 'first-steps',
      document: {
        schema: KAREL_WORLD_SCHEMA_NAME,
        version: KAREL_WORLD_SCHEMA_VERSION,
        world: DEFAULT_KAREL_WORLD,
      },
    },
    { id: 'beeper-trail', document: beeperTrail },
  ],
})

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  brand: 'KAREL',
  terminalName: 'Karel Python',
  initialLayout: {
    selectedPanelId: 'web-ide-karel.world',
    panelColumnPercent: 50,
    panelContentPercent: 85,
  },
  plugins: [pythonRuntimePlugin, coreWorkbenchPlugin, karelPlugin],
}

const host: WebIDEHost = {
  workspace: {
    id: 'web-ide-karel-basic-v1',
    localCache: 'memory',
  },
}

initWebIDETheme()
createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <WebIDEHostProvider host={host}>
      <WebIDE configuration={configuration} />
    </WebIDEHostProvider>
  </StrictMode>,
)
