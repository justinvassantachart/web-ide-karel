import type {
  DebugPauseState,
  DrawCommand,
  IDEPanelServices,
  RuntimeDiagnostic,
  RuntimeEventChannels,
} from 'web-ide'

export class FakeEventSource<T> {
  private readonly listeners = new Set<(event: T) => void>()

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

export function createFakeRuntime(languageIds: readonly string[] = ['python']) {
  const events = {
    stdout: new FakeEventSource<string>(),
    stderr: new FakeEventSource<string>(),
    terminalClear: new FakeEventSource<void>(),
    graphicsDraw: new FakeEventSource<DrawCommand[]>(),
    debugPaused: new FakeEventSource<DebugPauseState>(),
    debugResumed: new FakeEventSource<void>(),
    exit: new FakeEventSource<number>(),
    diagnostic: new FakeEventSource<RuntimeDiagnostic>(),
    breakpointsValidated: new FakeEventSource<{ file: string; lines: number[] }>(),
  } satisfies RuntimeEventChannels

  const runtime = {
    id: 'host-selected-runtime',
    languageIds,
    capabilities: {
      debug: false,
      breakpoints: false,
      stdin: false,
      graphics: false,
    },
    events,
    prepare: async () => ({ success: true, errors: [] }),
    start: async () => undefined,
    stop: () => undefined,
    setBreakpoints: async () => undefined,
    replaceBreakpointOverlay: async () => undefined,
    clearBreakpointOverlay: async () => undefined,
    stepInto: async () => undefined,
    stepOver: async () => undefined,
    stepOut: async () => undefined,
    continueExecution: async () => undefined,
  } satisfies IDEPanelServices['runtime']

  return { runtime, events }
}
