import { useSyncExternalStore } from 'react'
import type { IDEPanelServices } from 'web-ide'
import { KarelWorldView } from './KarelWorldView'
import type { KarelSessionStore } from './session-store'

export interface KarelPanelProps extends IDEPanelServices {
  store: KarelSessionStore
}

function statusLabel(status: ReturnType<KarelSessionStore['getSnapshot']>['status']) {
  return {
    waiting: 'Ready',
    running: 'Running',
    complete: 'Complete',
    error: 'Error',
    exited: 'Stopped',
  }[status]
}

export function KarelPanel({ runtime, store }: KarelPanelProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const supportsPython = runtime.languageIds.some(
    (languageId) => languageId.toLowerCase() === 'python',
  )

  return (
    <section className="karel-panel" aria-label="Karel world">
      <header className="karel-panel-header">
        <div>
          <h2>{snapshot.world.name}</h2>
          <p>
            Avenue {snapshot.world.karel.avenue}, street {snapshot.world.karel.street}
            {' · '}
            facing {snapshot.world.karel.direction}
          </p>
        </div>
        <span className={`karel-status karel-status-${snapshot.status}`} role="status">
          {statusLabel(snapshot.status)}
        </span>
      </header>

      {!supportsPython && (
        <p className="karel-panel-notice" role="note">
          Select a Python runtime session to run this Karel workspace.
        </p>
      )}

      {snapshot.error && (
        <p className="karel-panel-error" role="alert">
          {snapshot.error}
        </p>
      )}

      <div className="karel-world-viewport">
        <KarelWorldView world={snapshot.world} className="karel-world" />
      </div>

      <footer className="karel-panel-footer">
        <span>Last action: {snapshot.lastAction ?? 'waiting for run'}</span>
        <span>
          Beepers: {String(snapshot.world.karel.beepersInBag)}
        </span>
      </footer>
    </section>
  )
}
