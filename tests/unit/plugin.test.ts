import { describe, expect, it, vi } from 'vitest'
import type {
  Disposable,
  DisposableLike,
  IDECommandContext,
  IDEContributionRegistrar,
  IDEPluginContext,
} from 'web-ide'
import {
  DEFAULT_KAREL_PANEL_ID,
  DEFAULT_KAREL_RESOURCE_ID,
  DEFAULT_KAREL_RUN_COMMAND_ID,
  KAREL_LIBRARY_WORKSPACE_PATH,
  KAREL_STARTER_WORKSPACE_PATH,
  KAREL_WORLD_WORKSPACE_PATH,
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
) {
  const cleanups: Disposable[] = []
  const registrar = { register: () => disposable() } as IDEContributionRegistrar<never>
  const context = {
    activities: registrar,
    panels: registrar,
    resources: registrar,
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

describe('host-created Karel plugin', () => {
  it('owns its panel and bundled Python/world workspace resources', () => {
    const plugin = createKarelPlugin()
    const panel = plugin.contributes?.panels?.[0]
    const resources = plugin.contributes?.resources?.[0]

    expect(panel).toMatchObject({ id: DEFAULT_KAREL_PANEL_ID, title: 'Karel' })
    expect(resources?.id).toBe(DEFAULT_KAREL_RESOURCE_ID)
    expect(Object.keys(resources?.files ?? {}).sort()).toEqual(
      [
        KAREL_LIBRARY_WORKSPACE_PATH,
        KAREL_STARTER_WORKSPACE_PATH,
        KAREL_WORLD_WORKSPACE_PATH,
      ].sort(),
    )
    expect(resources?.files[KAREL_LIBRARY_WORKSPACE_PATH]).toContain(
      'def run_karel(',
    )
    expect(resources?.files[KAREL_WORLD_WORKSPACE_PATH]).toContain('First Steps')
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
})
