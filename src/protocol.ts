import {
  KAREL_OSC_CODE,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  type KarelProtocolEvent,
} from './types'
import { parseKarelWorld } from './world'

export const KAREL_OSC_PREFIX = `\u001b]${KAREL_OSC_CODE};${KAREL_PROTOCOL_NAME};`
export const KAREL_OSC_TERMINATOR = '\u0007'
const MAX_FRAME_LENGTH = 2_000_000

export interface KarelDecodeResult {
  /** Valid Karel events found in this chunk. */
  events: KarelProtocolEvent[]
  /** Bytes not belonging to a Karel frame, in original order. */
  text: string
  /** Malformed or unsupported frames; decoding continues after each one. */
  errors: Error[]
}

function parseBase64Url(payload: string): unknown {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) {
    throw new TypeError('Karel OSC payload is not valid base64url')
  }
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(`${normalized.replace(/=+$/, '')}${padding}`)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function parseEvent(value: unknown): KarelProtocolEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Karel protocol payload must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.protocol !== KAREL_PROTOCOL_NAME) {
    throw new TypeError('Karel protocol name does not match')
  }
  if (raw.version !== KAREL_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported Karel protocol version: ${String(raw.version)}`)
  }
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0) {
    throw new TypeError('Karel protocol sequence must be a non-negative integer')
  }

  const common = {
    protocol: KAREL_PROTOCOL_NAME,
    version: KAREL_PROTOCOL_VERSION,
    sequence: raw.sequence as number,
  } as const
  switch (raw.type) {
    case 'state':
      if (typeof raw.action !== 'string' || raw.action === '') {
        throw new TypeError('Karel state action must be a non-empty string')
      }
      return {
        ...common,
        type: 'state',
        action: raw.action,
        world: parseKarelWorld(raw.world),
      }
    case 'complete':
      return {
        ...common,
        type: 'complete',
        world: parseKarelWorld(raw.world),
      }
    case 'error':
      if (typeof raw.message !== 'string' || raw.message === '') {
        throw new TypeError('Karel error message must be a non-empty string')
      }
      if (raw.errorType !== undefined && typeof raw.errorType !== 'string') {
        throw new TypeError('Karel errorType must be a string when present')
      }
      return {
        ...common,
        type: 'error',
        message: raw.message,
        ...(raw.errorType === undefined ? {} : { errorType: raw.errorType }),
      }
    default:
      throw new TypeError(`Unsupported Karel event type: ${String(raw.type)}`)
  }
}

function trailingPrefixLength(value: string): number {
  const maximum = Math.min(value.length, KAREL_OSC_PREFIX.length - 1)
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(KAREL_OSC_PREFIX.slice(0, length))) return length
  }
  return 0
}

/**
 * Incrementally extracts private Karel OSC frames from arbitrary stdout chunks.
 * The decoder never assumes event or Unicode boundaries align with chunks.
 */
export class KarelProtocolDecoder {
  private pending = ''

  push(chunk: string): KarelDecodeResult {
    this.pending += chunk
    const result: KarelDecodeResult = { events: [], text: '', errors: [] }

    while (this.pending !== '') {
      const start = this.pending.indexOf(KAREL_OSC_PREFIX)
      if (start < 0) {
        const retained = trailingPrefixLength(this.pending)
        result.text += this.pending.slice(0, this.pending.length - retained)
        this.pending = retained === 0 ? '' : this.pending.slice(-retained)
        break
      }
      if (start > 0) {
        result.text += this.pending.slice(0, start)
        this.pending = this.pending.slice(start)
      }

      const end = this.pending.indexOf(
        KAREL_OSC_TERMINATOR,
        KAREL_OSC_PREFIX.length,
      )
      const nestedStart = this.pending.indexOf(
        KAREL_OSC_PREFIX,
        KAREL_OSC_PREFIX.length,
      )
      if (nestedStart >= 0 && (end < 0 || nestedStart < end)) {
        result.errors.push(
          nestedStart > MAX_FRAME_LENGTH
            ? new RangeError('Karel OSC frame exceeds the size limit')
            : new Error('Karel OSC frame was interrupted by a new frame'),
        )
        this.pending = this.pending.slice(nestedStart)
        continue
      }
      if (end < 0) {
        if (this.pending.length > MAX_FRAME_LENGTH) {
          result.errors.push(new RangeError('Karel OSC frame exceeds the size limit'))
          const retained = trailingPrefixLength(this.pending)
          this.pending = retained === 0 ? '' : this.pending.slice(-retained)
        }
        break
      }

      const frameLength = end + KAREL_OSC_TERMINATOR.length
      if (frameLength > MAX_FRAME_LENGTH) {
        result.errors.push(new RangeError('Karel OSC frame exceeds the size limit'))
        this.pending = this.pending.slice(frameLength)
        continue
      }

      const payload = this.pending.slice(KAREL_OSC_PREFIX.length, end)
      this.pending = this.pending.slice(frameLength)
      try {
        result.events.push(parseEvent(parseBase64Url(payload)))
      } catch (error) {
        result.errors.push(
          error instanceof Error ? error : new Error('Could not decode Karel event'),
        )
      }
    }

    return result
  }

  flush(): KarelDecodeResult {
    const result: KarelDecodeResult = { events: [], text: '', errors: [] }
    if (this.pending.startsWith(KAREL_OSC_PREFIX)) {
      result.errors.push(new Error('Karel runtime ended with a truncated OSC frame'))
    } else {
      result.text = this.pending
    }
    this.pending = ''
    return result
  }

  reset(): void {
    this.pending = ''
  }
}

/** Encode a frame for compatible runtimes, test harnesses, and diagnostics. */
export function encodeKarelProtocolEvent(event: KarelProtocolEvent): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
  return `${KAREL_OSC_PREFIX}${payload}${KAREL_OSC_TERMINATOR}`
}
