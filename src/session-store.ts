import type { IDEPanelServices } from 'web-ide'
import { KarelProtocolDecoder, type KarelDecodeResult } from './protocol'
import type {
  KarelProtocolEvent,
  KarelSessionSnapshot,
  KarelWorld,
} from './types'
import { cloneKarelWorld } from './world'

export type KarelRuntimeSession = IDEPanelServices['runtime']
export type KarelSessionListener = () => void

function waitingSnapshot(world: KarelWorld): KarelSessionSnapshot {
  return {
    world: cloneKarelWorld(world),
    status: 'waiting',
    sequence: -1,
  }
}

/** Instance-scoped bridge from a generic runtime's stdout to Karel UI state. */
export class KarelSessionStore {
  private readonly decoder = new KarelProtocolDecoder()
  private readonly listeners = new Set<KarelSessionListener>()
  private readonly initialWorld: KarelWorld
  private snapshotValue: KarelSessionSnapshot
  private attachmentCount = 0
  private detachRuntime: (() => void) | undefined

  constructor(initialWorld: KarelWorld) {
    this.initialWorld = cloneKarelWorld(initialWorld)
    this.snapshotValue = waitingSnapshot(this.initialWorld)
  }

  readonly getSnapshot = (): KarelSessionSnapshot => this.snapshotValue

  readonly subscribe = (listener: KarelSessionListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Attach to one selected runtime session. Attachments are reference-counted
   * so React Strict Mode and test harnesses cannot duplicate subscriptions.
   */
  attach(runtime: KarelRuntimeSession): () => void {
    this.attachmentCount += 1
    if (this.attachmentCount === 1) {
      const unsubscribe = [
        runtime.events.stdout.subscribe((chunk) => this.accept(chunk)),
        runtime.events.terminalClear.subscribe(() => this.reset()),
        runtime.events.exit.subscribe((code) => this.onExit(code)),
      ]
      this.detachRuntime = () => {
        for (const dispose of unsubscribe.reverse()) dispose()
      }
    }

    let detached = false
    return () => {
      if (detached) return
      detached = true
      this.attachmentCount -= 1
      if (this.attachmentCount === 0) {
        this.detachRuntime?.()
        this.detachRuntime = undefined
        this.decoder.reset()
      }
    }
  }

  reset(): void {
    this.decoder.reset()
    this.update(waitingSnapshot(this.initialWorld))
  }

  setUnavailable(message: string): void {
    this.update({
      ...waitingSnapshot(this.initialWorld),
      status: 'error',
      error: message,
    })
  }

  private accept(chunk: string): void {
    this.applyDecodeResult(this.decoder.push(chunk))
  }

  private applyDecodeResult(result: KarelDecodeResult): void {
    for (const event of result.events) this.applyEvent(event)
    const firstError = result.errors[0]
    if (firstError) {
      this.update({
        ...this.snapshotValue,
        status: 'error',
        error: firstError.message,
      })
    }
  }

  private applyEvent(event: KarelProtocolEvent): void {
    switch (event.type) {
      case 'state':
        this.update({
          world: event.world,
          status: 'running',
          lastAction: event.action,
          sequence: event.sequence,
        })
        break
      case 'complete':
        this.update({
          world: event.world,
          status: 'complete',
          lastAction: 'complete',
          sequence: event.sequence,
        })
        break
      case 'error':
        this.update({
          ...this.snapshotValue,
          status: 'error',
          error: event.message,
          lastAction: event.errorType ?? 'error',
          sequence: event.sequence,
        })
        break
    }
  }

  private onExit(code: number): void {
    this.applyDecodeResult(this.decoder.flush())
    if (
      this.snapshotValue.status !== 'complete' &&
      this.snapshotValue.status !== 'error'
    ) {
      this.update({
        ...this.snapshotValue,
        status: 'exited',
        error: code === 0 ? undefined : `Python exited with code ${code}`,
      })
    }
  }

  private update(snapshot: KarelSessionSnapshot): void {
    this.snapshotValue = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}
