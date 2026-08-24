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
import 'web-ide/styles.css'
import { createKarelPlugin } from '../../src'

const nestedModuleStarter = `from helpers.steps import move_steps
from karel import run_karel, turn_left, turn_right


def main():
    move_steps(3)
    turn_left()
    move_steps(1)
    turn_right()


if __name__ == "__main__":
    run_karel(main)
`

const nestedStepsModule = `from karel import move


def move_steps(count):
    for _ in range(count):
        move()
`

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  brand: 'KAREL TEST',
  plugins: [pythonRuntimePlugin, coreWorkbenchPlugin, createKarelPlugin()],
}

const host: WebIDEHost = {
  workspace: {
    id: 'karel-browser-host-v1',
    localCache: 'memory',
    readOnly: true,
    initialFiles: {
      '/workspace/main.py': nestedModuleStarter,
      '/workspace/helpers/__init__.py': '',
      '/workspace/helpers/steps.py': nestedStepsModule,
    },
  },
}

initWebIDETheme()
const container = document.querySelector('#root')
if (!container) throw new Error('Web IDE host fixture root is missing')
const root = createRoot(container)
root.render(
  <StrictMode>
    <WebIDEHostProvider host={host}>
      <WebIDE configuration={configuration} />
    </WebIDEHostProvider>
  </StrictMode>,
)

Object.assign(window, { __unmountKarelHost: () => root.unmount() })
