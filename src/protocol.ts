import {
  KAREL_OSC_CODE,
  KAREL_PROTOCOL_LIMITS,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  type KarelLimitReason,
  type KarelProtocolEvent,
  type KarelSourceLocation,
} from './types'
import { parseKarelWorldBodyV1 } from './world-contract'

export const KAREL_OSC_PREFIX = `\u001b]${KAREL_OSC_CODE};${KAREL_PROTOCOL_NAME};`
export const KAREL_OSC_TERMINATOR = '\u0007'

const COMMON_KEYS = ['protocol', 'version', 'runId', 'sequence', 'type'] as const
const LIMIT_REASONS = new Set<KarelLimitReason>([
  'event-limit',
  'protocol-byte-limit',
  'pause-limit',
  'elapsed-time-limit',
  'output-byte-limit',
  'queue-limit',
])

export interface KarelDecodeResult {
  /** Valid Karel events found in this chunk. */
  events: KarelProtocolEvent[]
  /** Bytes not belonging to a Karel frame, in original order. */
  text: string
  /** Malformed or unsupported frames; decoding continues after each one. */
  errors: Error[]
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  const unexpected = actual.find((key) => !allowed.has(key))
  if (unexpected !== undefined) {
    throw new TypeError(`Karel protocol field is not supported: ${unexpected}`)
  }
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing !== undefined) {
    throw new TypeError(`Karel protocol field is required: ${missing}`)
  }
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  if (value.length > maximum) {
    throw new RangeError(`${field} exceeds the ${maximum}-character limit`)
  }
  return value
}

function parseRunId(value: unknown): string {
  const runId = boundedString(
    value,
    'Karel protocol runId',
    KAREL_PROTOCOL_LIMITS.maxRunIdCharacters,
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)) {
    throw new TypeError('Karel protocol runId contains unsupported characters')
  }
  return runId
}

function parseSource(value: unknown): KarelSourceLocation {
  const raw = plainObject(value, 'Karel protocol source')
  assertExactKeys(raw, ['path', 'line'], ['column'])
  const path = boundedString(
    raw.path,
    'Karel protocol source path',
    KAREL_PROTOCOL_LIMITS.maxSourcePathCharacters,
  )
  const segments = path.split('/')
  if (
    path.startsWith('/')
    || path.includes('\\')
    || Array.from(path).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(
      'Karel protocol source path must be a canonical relative POSIX path',
    )
  }
  if (!Number.isSafeInteger(raw.line) || (raw.line as number) <= 0) {
    throw new TypeError('Karel protocol source line must be a positive integer')
  }
  if (
    raw.column !== undefined
    && (!Number.isSafeInteger(raw.column) || (raw.column as number) <= 0)
  ) {
    throw new TypeError('Karel protocol source column must be a positive integer')
  }
  return {
    path,
    line: raw.line as number,
    ...(raw.column === undefined ? {} : { column: raw.column as number }),
  }
}

function parseBase64Url(payload: string): unknown {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) {
    throw new TypeError('Karel OSC payload is not valid base64url')
  }
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(`${normalized.replace(/=+$/, '')}${padding}`)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

function commonEvent(raw: Record<string, unknown>) {
  if (raw.protocol !== KAREL_PROTOCOL_NAME) {
    throw new TypeError('Karel protocol name does not match')
  }
  if (raw.version !== KAREL_PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported Karel protocol version: ${String(raw.version)}`)
  }
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0) {
    throw new TypeError('Karel protocol sequence must be a non-negative integer')
  }
  return {
    protocol: KAREL_PROTOCOL_NAME,
    version: KAREL_PROTOCOL_VERSION,
    runId: parseRunId(raw.runId),
    sequence: raw.sequence as number,
  } as const
}

function parseEvent(value: unknown): KarelProtocolEvent {
  const raw = plainObject(value, 'Karel protocol payload')
  const common = commonEvent(raw)
  switch (raw.type) {
    case 'state': {
      assertExactKeys(raw, [...COMMON_KEYS, 'action', 'world'], ['source'])
      const action = boundedString(
        raw.action,
        'Karel state action',
        KAREL_PROTOCOL_LIMITS.maxActionCharacters,
      )
      return {
        ...common,
        type: 'state',
        action,
        world: parseKarelWorldBodyV1(raw.world),
        ...(raw.source === undefined ? {} : { source: parseSource(raw.source) }),
      }
    }
    case 'terminal': {
      if (raw.outcome === 'completed') {
        assertExactKeys(raw, [...COMMON_KEYS, 'outcome', 'world'], ['source'])
        return {
          ...common,
          type: 'terminal',
          outcome: 'completed',
          world: parseKarelWorldBodyV1(raw.world),
          ...(raw.source === undefined ? {} : { source: parseSource(raw.source) }),
        }
      }
      if (raw.outcome === 'runtime-error') {
        assertExactKeys(
          raw,
          [...COMMON_KEYS, 'outcome', 'message'],
          ['errorType', 'world', 'source'],
        )
        const message = boundedString(
          raw.message,
          'Karel runtime error message',
          KAREL_PROTOCOL_LIMITS.maxMessageCharacters,
        )
        if (
          raw.errorType !== undefined
          && (typeof raw.errorType !== 'string'
            || raw.errorType.length === 0
            || raw.errorType.length > KAREL_PROTOCOL_LIMITS.maxErrorTypeCharacters
            || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(raw.errorType))
        ) {
          throw new TypeError('Karel runtime errorType is not valid')
        }
        return {
          ...common,
          type: 'terminal',
          outcome: 'runtime-error',
          message,
          ...(raw.errorType === undefined ? {} : { errorType: raw.errorType }),
          ...(raw.world === undefined
            ? {}
            : { world: parseKarelWorldBodyV1(raw.world) }),
          ...(raw.source === undefined ? {} : { source: parseSource(raw.source) }),
        }
      }
      if (raw.outcome === 'aborted') {
        assertExactKeys(raw, [...COMMON_KEYS, 'outcome'], ['world', 'source'])
        return {
          ...common,
          type: 'terminal',
          outcome: 'aborted',
          ...(raw.world === undefined
            ? {}
            : { world: parseKarelWorldBodyV1(raw.world) }),
          ...(raw.source === undefined ? {} : { source: parseSource(raw.source) }),
        }
      }
      if (raw.outcome === 'limit-exceeded') {
        assertExactKeys(
          raw,
          [...COMMON_KEYS, 'outcome', 'reason'],
          ['message', 'world', 'source'],
        )
        if (typeof raw.reason !== 'string' || !LIMIT_REASONS.has(raw.reason as KarelLimitReason)) {
          throw new TypeError('Karel limit reason is not supported')
        }
        if (
          raw.message !== undefined
          && (typeof raw.message !== 'string'
            || raw.message.length === 0
            || raw.message.length > KAREL_PROTOCOL_LIMITS.maxMessageCharacters)
        ) {
          throw new TypeError('Karel limit message is not valid')
        }
        return {
          ...common,
          type: 'terminal',
          outcome: 'limit-exceeded',
          reason: raw.reason as KarelLimitReason,
          ...(raw.message === undefined ? {} : { message: raw.message }),
          ...(raw.world === undefined
            ? {}
            : { world: parseKarelWorldBodyV1(raw.world) }),
          ...(raw.source === undefined ? {} : { source: parseSource(raw.source) }),
        }
      }
      throw new TypeError(`Unsupported Karel terminal outcome: ${String(raw.outcome)}`)
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
 * It also enforces one correlated, contiguous, terminal-bounded run per reset.
 */
export class KarelProtocolDecoder {
  private pending = ''
  private activeRunId: string | undefined
  private nextSequence = 0
  private eventCount = 0
  private protocolCharacters = 0
  private terminalReceived = false

  push(chunk: string): KarelDecodeResult {
    this.pending += chunk
    const result: KarelDecodeResult = { events: [], text: '', errors: [] }
    let errorOverflowReported = false

    const report = (error: Error) => {
      const limit = KAREL_PROTOCOL_LIMITS.maxErrorsPerChunk
      if (result.errors.length < limit - 1) {
        result.errors.push(error)
      } else if (!errorOverflowReported) {
        result.errors.push(new RangeError('Karel decoder error limit exceeded'))
        errorOverflowReported = true
      }
    }

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
        report(
          nestedStart > KAREL_PROTOCOL_LIMITS.maxFrameCharacters
            ? new RangeError('Karel OSC frame exceeds the size limit')
            : new Error('Karel OSC frame was interrupted by a new frame'),
        )
        this.pending = this.pending.slice(nestedStart)
        continue
      }
      if (end < 0) {
        if (this.pending.length > KAREL_PROTOCOL_LIMITS.maxFrameCharacters) {
          report(new RangeError('Karel OSC frame exceeds the size limit'))
          const retained = trailingPrefixLength(this.pending)
          this.pending = retained === 0 ? '' : this.pending.slice(-retained)
        }
        break
      }

      const frameLength = end + KAREL_OSC_TERMINATOR.length
      if (frameLength > KAREL_PROTOCOL_LIMITS.maxFrameCharacters) {
        report(new RangeError('Karel OSC frame exceeds the size limit'))
        this.pending = this.pending.slice(frameLength)
        continue
      }

      const payload = this.pending.slice(KAREL_OSC_PREFIX.length, end)
      this.pending = this.pending.slice(frameLength)
      this.protocolCharacters += frameLength
      if (
        this.protocolCharacters
        > KAREL_PROTOCOL_LIMITS.maxProtocolCharactersPerRun
      ) {
        report(new RangeError('Karel protocol run exceeds the character limit'))
        continue
      }
      if (result.events.length >= KAREL_PROTOCOL_LIMITS.maxEventsPerChunk) {
        report(new RangeError('Karel protocol chunk exceeds the event limit'))
        continue
      }

      try {
        const event = parseEvent(parseBase64Url(payload))
        this.acceptSequence(event)
        result.events.push(event)
      } catch (error) {
        report(error instanceof Error ? error : new Error('Could not decode Karel event'))
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
    this.activeRunId = undefined
    this.nextSequence = 0
    this.eventCount = 0
    this.protocolCharacters = 0
    this.terminalReceived = false
  }

  private acceptSequence(event: KarelProtocolEvent): void {
    if (this.activeRunId === undefined) {
      if (event.sequence !== 0) {
        throw new Error('Karel protocol run must begin at sequence 0')
      }
      this.activeRunId = event.runId
    } else if (event.runId !== this.activeRunId) {
      throw new Error('Karel protocol event belongs to a different run')
    }
    if (this.terminalReceived) {
      throw new Error('Karel protocol event arrived after terminal settlement')
    }
    if (event.sequence !== this.nextSequence) {
      throw new Error(
        `Karel protocol sequence must be ${this.nextSequence}, received ${event.sequence}`,
      )
    }
    if (this.eventCount >= KAREL_PROTOCOL_LIMITS.maxEventsPerRun) {
      throw new RangeError('Karel protocol run exceeds the event limit')
    }
    this.nextSequence += 1
    this.eventCount += 1
    if (event.type === 'terminal') this.terminalReceived = true
  }
}

/** Encode one validated frame for compatible runtimes and test harnesses. */
export function encodeKarelProtocolEvent(event: KarelProtocolEvent): string {
  const parsed = parseEvent(event)
  const bytes = new TextEncoder().encode(JSON.stringify(parsed))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
  const frame = `${KAREL_OSC_PREFIX}${payload}${KAREL_OSC_TERMINATOR}`
  if (frame.length > KAREL_PROTOCOL_LIMITS.maxFrameCharacters) {
    throw new RangeError('Karel OSC frame exceeds the size limit')
  }
  return frame
}
