import pythonLibrarySource from '../python/karel.py?raw'
import starterPythonSource from '../python/starter.py?raw'
import defaultWorldSource from '../worlds/default.json?raw'
import type { KarelWorld } from './types'
import { parseKarelWorld, serializeKarelWorld } from './world'

export const KAREL_LIBRARY_WORKSPACE_PATH = '/workspace/karel.py'
export const KAREL_STARTER_WORKSPACE_PATH = '/workspace/main.py'
export const KAREL_WORLD_WORKSPACE_PATH = '/workspace/karel_world.json'

/** Exact source seeded into a Web IDE workspace by the default plugin. */
export const KAREL_PYTHON_LIBRARY_SOURCE = pythonLibrarySource
export const KAREL_STARTER_PYTHON_SOURCE = starterPythonSource
export const DEFAULT_KAREL_WORLD_SOURCE = defaultWorldSource
export const DEFAULT_KAREL_WORLD: KarelWorld = parseKarelWorld(
  JSON.parse(defaultWorldSource),
)

export interface KarelWorkspaceResourcesOptions {
  world?: KarelWorld
  starterCode?: string
}

export function createKarelWorkspaceFiles(
  options: KarelWorkspaceResourcesOptions = {},
): Record<string, string> {
  return {
    [KAREL_LIBRARY_WORKSPACE_PATH]: KAREL_PYTHON_LIBRARY_SOURCE,
    [KAREL_WORLD_WORKSPACE_PATH]: serializeKarelWorld(
      options.world ?? DEFAULT_KAREL_WORLD,
    ),
    [KAREL_STARTER_WORKSPACE_PATH]:
      options.starterCode ?? KAREL_STARTER_PYTHON_SOURCE,
  }
}
