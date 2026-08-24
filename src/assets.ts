import pythonLibrarySource from '../python/karel.py?raw'
import starterPythonSource from '../python/starter.py?raw'
import defaultWorldSource from '../worlds/default.json?raw'
import {
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  type KarelWorld,
} from './types'
import { parseKarelWorld, serializeKarelWorld } from './world'

export const KAREL_STARTER_WORKSPACE_PATH = '/workspace/main.py'
export const KAREL_LIBRARY_EXECUTION_PATH = '/sysroot/karel.py'
export const KAREL_WORLD_EXECUTION_PATH = '/sysroot/karel_world.json'
export const KAREL_RUN_EXECUTION_PATH = '/sysroot/karel_run.json'

/** @deprecated Use KAREL_LIBRARY_EXECUTION_PATH. */
export const KAREL_LIBRARY_WORKSPACE_PATH = KAREL_LIBRARY_EXECUTION_PATH
/** @deprecated Use KAREL_WORLD_EXECUTION_PATH. */
export const KAREL_WORLD_WORKSPACE_PATH = KAREL_WORLD_EXECUTION_PATH

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
  createRunId?: () => string
}

/** Returns only student-editable workspace seeds. */
export function createKarelWorkspaceFiles(
  options: KarelWorkspaceResourcesOptions = {},
): Record<string, string> {
  return {
    [KAREL_STARTER_WORKSPACE_PATH]:
      options.starterCode ?? KAREL_STARTER_PYTHON_SOURCE,
  }
}

export interface KarelRunResource {
  protocol: typeof KAREL_PROTOCOL_NAME
  version: typeof KAREL_PROTOCOL_VERSION
  runId: string
}

function createDefaultRunId(): string {
  return crypto.randomUUID()
}

function assertRunId(runId: string): string {
  if (
    runId.length === 0
    || runId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)
  ) {
    throw new TypeError('Karel run IDs must be 1-128 portable ASCII characters')
  }
  return runId
}

/**
 * Materializes a fresh runtime-owned library, world, and opaque run identity.
 * Hosts contribute this map through a dynamic `execution-only` resource.
 */
export function createKarelExecutionFiles(
  options: KarelWorkspaceResourcesOptions = {},
): Record<string, string> {
  const run: KarelRunResource = {
    protocol: KAREL_PROTOCOL_NAME,
    version: KAREL_PROTOCOL_VERSION,
    runId: assertRunId((options.createRunId ?? createDefaultRunId)()),
  }
  return {
    [KAREL_LIBRARY_EXECUTION_PATH]: KAREL_PYTHON_LIBRARY_SOURCE,
    [KAREL_WORLD_EXECUTION_PATH]: serializeKarelWorld(
      options.world ?? DEFAULT_KAREL_WORLD,
    ),
    [KAREL_RUN_EXECUTION_PATH]: `${JSON.stringify(run, null, 2)}\n`,
  }
}
