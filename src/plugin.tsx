import type {
  IDECommandContribution,
  IDEPanelServices,
  IDEPlugin,
} from 'web-ide'
import {
  createKarelExecutionFiles,
  createKarelWorkspaceFiles,
  KAREL_RUN_EXECUTION_PATH,
  type KarelRunResource,
  type KarelWorkspaceResourcesOptions,
} from './assets'
import {
  KarelPanel,
  type KarelPanelWorldOption,
} from './KarelPanel'
import type { KarelPlaybackLimits } from './playback-controller'
import { KarelSessionStore, type KarelRuntimeSession } from './session-store'
import type { KarelTimelineLimits } from './timeline'
import { DEFAULT_KAREL_WORLD } from './assets'
import {
  parseKarelWorldDocument,
  type KarelWorldDocumentV1,
} from './world-contract'

export const DEFAULT_KAREL_PLUGIN_ID = 'web-ide-karel'
export const DEFAULT_KAREL_PANEL_ID = 'web-ide-karel.world'
export const DEFAULT_KAREL_RESOURCE_ID = 'web-ide-karel.resources'
export const DEFAULT_KAREL_RUN_COMMAND_ID = 'web-ide-karel.run'

export interface KarelPluginWorldOption {
  id: string
  label?: string
  document: KarelWorldDocumentV1
}

export interface CreateKarelPluginOptions extends KarelWorkspaceResourcesOptions {
  pluginId?: string
  panelId?: string
  resourceId?: string
  runCommandId?: string
  panelTitle?: string
  panelOrder?: number
  commandOrder?: number
  /** Strict portable worlds selectable by this activity instance. */
  worlds?: readonly KarelPluginWorldOption[]
  /** Defaults to the first configured world. */
  initialWorldId?: string
  /** Set false when the host already supplies its own run affordance. */
  contributeRunCommand?: boolean
  /** Cumulative execution limits owned by this Karel activity instance. */
  playbackLimits?: KarelPlaybackLimits
  /** Retained visual-history limits owned by this Karel activity instance. */
  timelineLimits?: KarelTimelineLimits
}

interface KarelRuntimeState {
  selectedWorld: KarelPanelWorldOption
  store: KarelSessionStore
}

function id(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new TypeError(`${field} must be a non-empty contribution ID`)
  }
  return value
}

function label(value: string, field: string): string {
  if (
    value.trim() === ''
    || value.length > 128
    || Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  ) {
    throw new TypeError(`${field} must be a non-empty control-free label`)
  }
  return value
}

function configuredWorlds(
  options: CreateKarelPluginOptions,
): KarelPanelWorldOption[] {
  if (options.world !== undefined && options.worlds !== undefined) {
    throw new TypeError('Configure either world or worlds, not both')
  }
  if (options.worlds === undefined) {
    const world = options.world ?? DEFAULT_KAREL_WORLD
    return [{ id: 'default', label: world.name, world }]
  }
  if (options.worlds.length === 0) {
    throw new TypeError('worlds must contain at least one strict world document')
  }
  const seen = new Set<string>()
  return options.worlds.map((option, index) => {
    const optionId = id(option.id, `worlds[${index}].id`)
    if (seen.has(optionId)) {
      throw new TypeError(`Duplicate Karel world ID: ${optionId}`)
    }
    seen.add(optionId)
    const document = parseKarelWorldDocument(option.document)
    return {
      id: optionId,
      label: label(option.label ?? document.world.name, `worlds[${index}].label`),
      world: document.world,
    }
  })
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
  const worlds = configuredWorlds(options)
  const initialSelection = options.initialWorldId === undefined
    ? worlds[0]!
    : worlds.find(({ id: worldId }) => worldId === options.initialWorldId)
  if (!initialSelection) {
    throw new TypeError(`Unknown initial Karel world ID: ${options.initialWorldId}`)
  }
  const runtimeStates = new WeakMap<KarelRuntimeSession, KarelRuntimeState>()
  const stateFor = (runtime: KarelRuntimeSession): KarelRuntimeState => {
    let state = runtimeStates.get(runtime)
    if (!state) {
      state = {
        selectedWorld: initialSelection,
        store: new KarelSessionStore(initialSelection.world),
      }
      runtimeStates.set(runtime, state)
    }
    return state
  }

  function PluginKarelPanel(services: IDEPanelServices) {
    const state = stateFor(services.runtime)
    return (
      <KarelPanel
        {...services}
        store={state.store}
        worlds={worlds}
        selectedWorldId={state.selectedWorld.id}
        onSelectWorld={(worldId) => {
          state.selectedWorld =
            worlds.find((world) => world.id === worldId) ?? state.selectedWorld
        }}
        {...(options.playbackLimits === undefined
          ? {}
          : { playbackLimits: options.playbackLimits })}
        {...(options.timelineLimits === undefined
          ? {}
          : { timelineLimits: options.timelineLimits })}
      />
    )
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
          id: `${resourceId}.workspace`,
          order: options.panelOrder ?? 25,
          files: createKarelWorkspaceFiles({
            starterCode: options.starterCode,
          }),
        },
      ],
    },
    activate(context) {
      if (!context.runtime) return
      const state = stateFor(context.runtime)
      context.resources.register({
        id: resourceId,
        order: options.panelOrder ?? 25,
        scope: 'execution-only',
        files: () => {
          const files = createKarelExecutionFiles({
            world: state.selectedWorld.world,
            createRunId: options.createRunId,
          })
          const run = JSON.parse(
            files[KAREL_RUN_EXECUTION_PATH] ?? 'null',
          ) as KarelRunResource | null
          if (!run) throw new Error('Karel run resource was not materialized')
          state.store.expectRun(run.runId)
          return files
        },
      })
      const supportsPython = context.runtime.languageIds.some(
        (languageId) => languageId.toLowerCase() === 'python',
      )
      if (!supportsPython) {
        state.store.setUnavailable(
          'Karel requires a selected runtime session that advertises the Python language ID.',
        )
        return
      }

      context.register(state.store.attach(context.runtime))
      if (options.contributeRunCommand !== false) {
        context.commands.register(runCommand)
      }
    },
  }
}
