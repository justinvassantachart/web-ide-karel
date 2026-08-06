import type {
  IDECommandContribution,
  IDEPanelServices,
  IDEPlugin,
} from 'web-ide'
import {
  createKarelWorkspaceFiles,
  type KarelWorkspaceResourcesOptions,
} from './assets'
import { KarelPanel } from './KarelPanel'
import { KarelSessionStore, type KarelRuntimeSession } from './session-store'
import type { KarelWorld } from './types'
import { DEFAULT_KAREL_WORLD } from './assets'

export const DEFAULT_KAREL_PLUGIN_ID = 'web-ide-karel'
export const DEFAULT_KAREL_PANEL_ID = 'web-ide-karel.world'
export const DEFAULT_KAREL_RESOURCE_ID = 'web-ide-karel.resources'
export const DEFAULT_KAREL_RUN_COMMAND_ID = 'web-ide-karel.run'

export interface CreateKarelPluginOptions extends KarelWorkspaceResourcesOptions {
  pluginId?: string
  panelId?: string
  resourceId?: string
  runCommandId?: string
  panelTitle?: string
  panelOrder?: number
  commandOrder?: number
  /** Set false when the host already supplies its own run affordance. */
  contributeRunCommand?: boolean
}

function id(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new TypeError(`${field} must be a non-empty contribution ID`)
  }
  return value
}

/**
 * Create an instance-safe Karel plugin for a host's plugin list.
 *
 * The plugin deliberately contributes no runtime. It composes with whichever
 * generic Python runtime provider the host selects and only consumes public
 * session events exposed by Web IDE.
 */
export function createKarelPlugin(options: CreateKarelPluginOptions = {}): IDEPlugin {
  const pluginId = id(options.pluginId ?? DEFAULT_KAREL_PLUGIN_ID, 'pluginId')
  const panelId = id(options.panelId ?? DEFAULT_KAREL_PANEL_ID, 'panelId')
  const resourceId = id(
    options.resourceId ?? DEFAULT_KAREL_RESOURCE_ID,
    'resourceId',
  )
  const runCommandId = id(
    options.runCommandId ?? DEFAULT_KAREL_RUN_COMMAND_ID,
    'runCommandId',
  )
  const initialWorld: KarelWorld = options.world ?? DEFAULT_KAREL_WORLD
  const stores = new WeakMap<KarelRuntimeSession, KarelSessionStore>()
  const storeFor = (runtime: KarelRuntimeSession): KarelSessionStore => {
    let store = stores.get(runtime)
    if (!store) {
      store = new KarelSessionStore(initialWorld)
      stores.set(runtime, store)
    }
    return store
  }

  function PluginKarelPanel(services: IDEPanelServices) {
    return <KarelPanel {...services} store={storeFor(services.runtime)} />
  }

  const runCommand: IDECommandContribution = {
    id: runCommandId,
    title: 'Run Karel',
    icon: 'run',
    group: 'run',
    surface: 'toolbar',
    tone: 'success',
    order: options.commandOrder ?? 15,
    enabled: (snapshot) =>
      snapshot.runtimeReady &&
      !snapshot.isCompiling &&
      snapshot.runState === 'idle',
    disabledReason: (snapshot) =>
      snapshot.runtimeReady
        ? 'Stop the active program before running Karel again.'
        : 'The Python runtime is still starting.',
    async execute(context) {
      context.panels.reveal(panelId)
      await context.execution.start('run')
    },
  }

  return {
    id: pluginId,
    contributes: {
      panels: [
        {
          id: panelId,
          title: options.panelTitle ?? 'Karel',
          order: options.panelOrder ?? 25,
          component: PluginKarelPanel,
        },
      ],
      resources: [
        {
          id: resourceId,
          order: options.panelOrder ?? 25,
          files: createKarelWorkspaceFiles({
            world: initialWorld,
            starterCode: options.starterCode,
          }),
        },
      ],
    },
    activate(context) {
      if (!context.runtime) return
      const store = storeFor(context.runtime)
      const supportsPython = context.runtime.languageIds.some(
        (languageId) => languageId.toLowerCase() === 'python',
      )
      if (!supportsPython) {
        store.setUnavailable(
          'Karel requires a selected runtime session that advertises the Python language ID.',
        )
        return
      }

      context.register(store.attach(context.runtime))
      if (options.contributeRunCommand !== false) {
        context.commands.register(runCommand)
      }
    },
  }
}
