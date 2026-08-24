import { describe, expect, it, vi } from 'vitest'
import type {
  Disposable,
  DisposableLike,
  IDECommandContext,
  IDEContributionRegistrar,
  IDEPanelContribution,
  IDEPanelServices,
  IDEPluginContext,
  IDEWorkspaceResourceContribution,
} from 'web-ide'
import {
  DEFAULT_KAREL_PANEL_ID,
  DEFAULT_KAREL_PLAYBACK_LIMITS,
  DEFAULT_KAREL_RESOURCE_ID,
  DEFAULT_KAREL_RUN_COMMAND_ID,
  DEFAULT_KAREL_TIMELINE_LIMITS,
  KAREL_LIBRARY_EXECUTION_PATH,
  KAREL_RUN_EXECUTION_PATH,
  KAREL_STARTER_WORKSPACE_PATH,
  KAREL_WORLD_SCHEMA_NAME,
  KAREL_WORLD_SCHEMA_VERSION,
  KAREL_WORLD_EXECUTION_PATH,
  DEFAULT_KAREL_WORLD,
  cloneKarelWorld,
  createKarelPlugin,
} from '../../src'
import { createFakeRuntime } from '../helpers/fake-runtime'

function disposable(value?: DisposableLike): Disposable {
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (typeof value === 'function') value()
      else value?.dispose()
    },
  }
}

function activationContext(
  runtime: IDEPluginContext['runtime'],
  onCommand: (value: Parameters<IDEPluginContext['commands']['register']>[0]) => void,
  capture: {
    onResource?(value: IDEWorkspaceResourceContribution): void
  } = {},
) {
  const cleanups: Disposable[] = []
  const registrar = { register: () => disposable() } as IDEContributionRegistrar<never>
  const context = {
    activities: registrar,
    panels: registrar,
    resources: {
      register(value) {
        capture.onResource?.(value)
        const cleanup = disposable()
        cleanups.push(cleanup)
        return cleanup
      },
    },
    runtimeProviders: registrar,
    testProviders: registrar,
    commands: {
      register(value) {
        onCommand(value)
        const cleanup = disposable()
        cleanups.push(cleanup)
        return cleanup
      },
    },
    runtime,
    register(value) {
      const cleanup = disposable(value)
      cleanups.push(cleanup)
      return cleanup
    },
  } as IDEPluginContext
  return {
    context,
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup.dispose()),
  }
}

function panelServices(
  runtime: IDEPanelServices['runtime'],
): IDEPanelServices {
  return {
    runtime,
    execution: {
      start: async () => undefined,
      stop: () => undefined,
      restart: async () => undefined,
    },
    source: {
      reveal: () => undefined,
      replaceDecorations: () => undefined,
      clearDecorations: () => undefined,
      dispose: () => undefined,
    },
    workspace: { snapshot: () => ({}) },
    panels: { reveal: () => undefined },
  }
}

interface KarelPanelElement {
  props: {
    playbackLimits?: unknown
    selectedWorldId?: string
    onSelectWorld?(worldId: string): void
    store: unknown
    timelineLimits?: unknown
  }
}

function renderPluginPanel(
  panel: IDEPanelContribution,
  services: IDEPanelServices,
): KarelPanelElement {
  return (panel.component as unknown as (
    value: IDEPanelServices,
  ) => KarelPanelElement)(services)
}

describe('host-created Karel plugin', () => {
  it('keeps only starter code editable and materializes a fresh execution run', () => {
    let run = 0
    const plugin = createKarelPlugin({ createRunId: () => `run-${++run}` })
    const panel = plugin.contributes?.panels?.[0]
    const workspace = plugin.contributes?.resources?.find(
      ({ scope }) => scope !== 'execution-only',
    )
    const python = createFakeRuntime()
    const resources: IDEWorkspaceResourceContribution[] = []
    const activation = activationContext(python.runtime, vi.fn(), {
      onResource: (resource) => resources.push(resource),
    })
    plugin.activate?.(activation.context)
    const execution = resources.find(({ scope }) => scope === 'execution-only')

    expect(panel).toMatchObject({ id: DEFAULT_KAREL_PANEL_ID, title: 'Karel' })
    expect(workspace?.files).toEqual(expect.objectContaining({
      [KAREL_STARTER_WORKSPACE_PATH]: expect.any(String),
    }))
    expect(Object.keys(workspace?.files ?? {})).toEqual([KAREL_STARTER_WORKSPACE_PATH])
    expect(execution).toMatchObject({
      id: DEFAULT_KAREL_RESOURCE_ID,
      scope: 'execution-only',
    })
    expect(typeof execution?.files).toBe('function')
    if (typeof execution?.files !== 'function') return

    const first = execution.files()
    const second = execution.files()
    expect(first[KAREL_LIBRARY_EXECUTION_PATH]).toContain('def run_karel(')
    expect(first[KAREL_WORLD_EXECUTION_PATH]).toContain('First Steps')
    expect(JSON.parse(first[KAREL_RUN_EXECUTION_PATH] ?? '')).toMatchObject({
      protocol: 'web-ide-karel',
      version: 2,
      runId: 'run-1',
    })
    expect(JSON.parse(second[KAREL_RUN_EXECUTION_PATH] ?? '')).toMatchObject({
      runId: 'run-2',
    })
    activation.dispose()
  })

  it('registers Run Karel only for a selected Python runtime session', async () => {
    const plugin = createKarelPlugin()
    const python = createFakeRuntime(['PYTHON'])
    const commands: Parameters<IDEPluginContext['commands']['register']>[0][] = []
    const activation = activationContext(python.runtime, (command) =>
      commands.push(command),
    )

    plugin.activate?.(activation.context)
    expect(commands.map(({ id }) => id)).toEqual([DEFAULT_KAREL_RUN_COMMAND_ID])
    expect(python.events.stdout.listenerCount).toBe(1)

    const start = vi.fn<IDECommandContext['execution']['start']>()
    const reveal = vi.fn<IDECommandContext['panels']['reveal']>()
    await commands[0]?.execute({
      execution: { start, stop: vi.fn(), restart: vi.fn() },
      workspace: { snapshot: () => ({}) },
      panels: { reveal },
    })
    expect(reveal).toHaveBeenCalledWith(DEFAULT_KAREL_PANEL_ID)
    expect(start).toHaveBeenCalledWith('run')

    activation.dispose()
    expect(python.events.stdout.listenerCount).toBe(0)
  })

  it('does not expose a run command or subscribe under non-Python runtimes', () => {
    const plugin = createKarelPlugin()
    const cpp = createFakeRuntime(['cpp'])
    const commands = vi.fn()
    const activation = activationContext(cpp.runtime, commands)

    plugin.activate?.(activation.context)
    expect(commands).not.toHaveBeenCalled()
    expect(cpp.events.stdout.listenerCount).toBe(0)
    activation.dispose()
  })

  it('supports host-defined contribution IDs and omitting the run command', () => {
    const plugin = createKarelPlugin({
      pluginId: 'course.karel',
      panelId: 'course.world',
      resourceId: 'course.resources',
      runCommandId: 'course.run',
      contributeRunCommand: false,
    })
    const python = createFakeRuntime()
    const commands = vi.fn()
    const activation = activationContext(python.runtime, commands)

    plugin.activate?.(activation.context)
    expect(plugin.id).toBe('course.karel')
    expect(plugin.contributes?.panels?.[0]?.id).toBe('course.world')
    expect(commands).not.toHaveBeenCalled()
    activation.dispose()
  })

  it('passes explicit activity-owned execution and history limits to its panel', () => {
    const playbackLimits = {
      ...DEFAULT_KAREL_PLAYBACK_LIMITS,
      maxPauses: 12,
      maxElapsedMs: 2_000,
      maxOutputBytes: 4_096,
    }
    const timelineLimits = {
      ...DEFAULT_KAREL_TIMELINE_LIMITS,
      maxFrames: 4,
      maxBytes: 32_768,
    }
    const plugin = createKarelPlugin({ playbackLimits, timelineLimits })
    const panel = plugin.contributes?.panels?.[0]
    expect(panel).toBeDefined()
    if (!panel) return

    const python = createFakeRuntime()
    const rendered = renderPluginPanel(panel, panelServices(python.runtime))
    expect(rendered.props.playbackLimits).toBe(playbackLimits)
    expect(rendered.props.timelineLimits).toBe(timelineLimits)
  })

  it('selects an explicit strict world document for each execution run', () => {
    const second = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    second.name = 'Second world'
    second.karel.avenue = 3
    const plugin = createKarelPlugin({
      worlds: [{
        id: 'second',
        label: 'Second world',
        document: {
          schema: KAREL_WORLD_SCHEMA_NAME,
          version: KAREL_WORLD_SCHEMA_VERSION,
          world: second,
        },
      }],
      initialWorldId: 'second',
    })
    const python = createFakeRuntime()
    const resources: IDEWorkspaceResourceContribution[] = []
    const activation = activationContext(python.runtime, vi.fn(), {
      onResource: (resource) => resources.push(resource),
    })
    plugin.activate?.(activation.context)
    const execution = resources.find(({ scope }) => scope === 'execution-only')
    expect(typeof execution?.files).toBe('function')
    if (typeof execution?.files !== 'function') return
    expect(JSON.parse(execution.files()[KAREL_WORLD_EXECUTION_PATH] ?? '')).toMatchObject({
      name: 'Second world',
      karel: { avenue: 3 },
    })
    activation.dispose()
  })

  it('isolates selected worlds and dynamic execution resources across runtimes', () => {
    const second = cloneKarelWorld(DEFAULT_KAREL_WORLD)
    second.name = 'Second world'
    second.karel.avenue = 3
    const document = {
      schema: KAREL_WORLD_SCHEMA_NAME,
      version: KAREL_WORLD_SCHEMA_VERSION,
      world: DEFAULT_KAREL_WORLD,
    }
    const plugin = createKarelPlugin({
      worlds: [
        { id: 'first', document },
        {
          id: 'second',
          document: {
            schema: KAREL_WORLD_SCHEMA_NAME,
            version: KAREL_WORLD_SCHEMA_VERSION,
            world: second,
          },
        },
      ],
    })
    const panel = plugin.contributes?.panels?.[0]
    expect(panel).toBeDefined()
    if (!panel) return

    const firstRuntime = createFakeRuntime()
    const secondRuntime = createFakeRuntime()
    const firstResources: IDEWorkspaceResourceContribution[] = []
    const secondResources: IDEWorkspaceResourceContribution[] = []
    const firstActivation = activationContext(firstRuntime.runtime, vi.fn(), {
      onResource: (resource) => firstResources.push(resource),
    })
    const secondActivation = activationContext(secondRuntime.runtime, vi.fn(), {
      onResource: (resource) => secondResources.push(resource),
    })
    plugin.activate?.(firstActivation.context)
    plugin.activate?.(secondActivation.context)

    const firstPanel = renderPluginPanel(panel, panelServices(firstRuntime.runtime))
    const secondPanel = renderPluginPanel(panel, panelServices(secondRuntime.runtime))
    expect(firstPanel.props.selectedWorldId).toBe('first')
    expect(secondPanel.props.selectedWorldId).toBe('first')
    expect(firstPanel.props.store).not.toBe(secondPanel.props.store)

    firstPanel.props.onSelectWorld?.('second')
    expect(
      renderPluginPanel(panel, panelServices(firstRuntime.runtime)).props
        .selectedWorldId,
    ).toBe('second')
    expect(
      renderPluginPanel(panel, panelServices(secondRuntime.runtime)).props
        .selectedWorldId,
    ).toBe('first')

    const firstExecution = firstResources.find(
      ({ scope }) => scope === 'execution-only',
    )
    const secondExecution = secondResources.find(
      ({ scope }) => scope === 'execution-only',
    )
    expect(typeof firstExecution?.files).toBe('function')
    expect(typeof secondExecution?.files).toBe('function')
    if (
      typeof firstExecution?.files !== 'function'
      || typeof secondExecution?.files !== 'function'
    ) return

    expect(
      JSON.parse(firstExecution.files()[KAREL_WORLD_EXECUTION_PATH] ?? ''),
    ).toMatchObject({ name: 'Second world', karel: { avenue: 3 } })
    expect(
      JSON.parse(secondExecution.files()[KAREL_WORLD_EXECUTION_PATH] ?? ''),
    ).toMatchObject({ name: 'First Steps', karel: { avenue: 1 } })

    firstActivation.dispose()
    secondActivation.dispose()
  })

  it('rejects ambiguous, duplicate, and unknown world selections', () => {
    const document = {
      schema: KAREL_WORLD_SCHEMA_NAME,
      version: KAREL_WORLD_SCHEMA_VERSION,
      world: DEFAULT_KAREL_WORLD,
    }
    expect(() => createKarelPlugin({
      world: DEFAULT_KAREL_WORLD,
      worlds: [{ id: 'one', document }],
    })).toThrow('either world or worlds')
    expect(() => createKarelPlugin({
      worlds: [
        { id: 'same', document },
        { id: 'same', document },
      ],
    })).toThrow('Duplicate Karel world ID')
    expect(() => createKarelPlugin({
      worlds: [{ id: 'one', document }],
      initialWorldId: 'missing',
    })).toThrow('Unknown initial Karel world ID')
  })
})
