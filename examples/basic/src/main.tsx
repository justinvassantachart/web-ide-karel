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
import { createKarelPlugin } from '@web-ide/karel'
import 'web-ide/styles.css'
import '@web-ide/karel/styles.css'

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  brand: 'KAREL',
  terminalName: 'Karel Python',
  plugins: [pythonRuntimePlugin, coreWorkbenchPlugin, createKarelPlugin()],
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
