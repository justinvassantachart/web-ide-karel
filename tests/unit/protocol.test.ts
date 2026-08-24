import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_OSC_PREFIX,
  KAREL_OSC_TERMINATOR,
  KAREL_PROTOCOL_LIMITS,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  KarelProtocolDecoder,
  encodeKarelProtocolEvent,
  type KarelProtocolEvent,
} from '../../src'

function state(sequence: number, runId = 'run-test'): KarelProtocolEvent {
  return {
    protocol: KAREL_PROTOCOL_NAME,
    version: KAREL_PROTOCOL_VERSION,
    runId,
    type: 'state',
    sequence,
    action: 'move',
    world: DEFAULT_KAREL_WORLD,
    source: { path: 'helpers/steps.py', line: 4, column: 2 },
  }
}

function unsafeFrame(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${KAREL_OSC_PREFIX}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')}${KAREL_OSC_TERMINATOR}`
}

describe('Karel OSC protocol v2', () => {
  it('decodes frames across every possible chunk boundary', () => {
    const event = state(0)
    const frame = encodeKarelProtocolEvent(event)

    for (let split = 0; split <= frame.length; split += 1) {
      const decoder = new KarelProtocolDecoder()
      const first = decoder.push(`student output\n${frame.slice(0, split)}`)
      const second = decoder.push(`${frame.slice(split)}after\n`)
      expect([...first.events, ...second.events]).toEqual([event])
      expect(first.text + second.text).toBe('student output\nafter\n')
      expect([...first.errors, ...second.errors]).toEqual([])
    }
  })

  it('decodes contiguous frames and preserves interleaved user stdout', () => {
    const decoder = new KarelProtocolDecoder()
    const result = decoder.push(
      `before${encodeKarelProtocolEvent(state(0))}middle${encodeKarelProtocolEvent(
        state(1),
      )}after`,
    )

    expect(result.events.map((event) => event.sequence)).toEqual([0, 1])
    expect(result.text).toBe('beforemiddleafter')
  })

  it('requires one run, contiguous monotonic sequence, and one terminal event', () => {
    const decoder = new KarelProtocolDecoder()
    const terminal: KarelProtocolEvent = {
      protocol: KAREL_PROTOCOL_NAME,
      version: KAREL_PROTOCOL_VERSION,
      runId: 'run-test',
      sequence: 1,
      type: 'terminal',
      outcome: 'completed',
      world: DEFAULT_KAREL_WORLD,
    }
    const decoded = decoder.push(
      [
        encodeKarelProtocolEvent(state(0)),
        encodeKarelProtocolEvent(terminal),
        encodeKarelProtocolEvent(state(2)),
        encodeKarelProtocolEvent(state(0, 'forged-run')),
      ].join(''),
    )

    expect(decoded.events).toEqual([state(0), terminal])
    expect(decoded.errors.map(({ message }) => message)).toEqual([
      'Karel protocol event arrived after terminal settlement',
      'Karel protocol event belongs to a different run',
    ])

    decoder.reset()
    const gap = decoder.push(encodeKarelProtocolEvent(state(2)))
    expect(gap.events).toEqual([])
    expect(gap.errors[0]?.message).toContain('begin at sequence 0')
  })

  it('strictly rejects v1, extra fields, bad source paths, and invalid outcomes', () => {
    const base = state(0) as unknown as Record<string, unknown>
    const values = [
      { ...base, version: 1 },
      { ...base, forged: true },
      { ...base, source: { path: '../main.py', line: 1 } },
      {
        protocol: KAREL_PROTOCOL_NAME,
        version: KAREL_PROTOCOL_VERSION,
        runId: 'run-test',
        sequence: 0,
        type: 'terminal',
        outcome: 'success',
      },
    ]

    for (const value of values) {
      const result = new KarelProtocolDecoder().push(unsafeFrame(value))
      expect(result.events).toEqual([])
      expect(result.errors).toHaveLength(1)
    }
  })

  it('strictly rejects forged world fields and ambiguous semantic duplicates', () => {
    const base = state(0) as unknown as Record<string, unknown>
    const duplicateBeeper = { avenue: 1, street: 1, count: 1 }
    const duplicateColor = { avenue: 1, street: 1, color: 'blue' }
    const invalidWorlds = [
      { ...DEFAULT_KAREL_WORLD, forged: true },
      {
        ...DEFAULT_KAREL_WORLD,
        beepers: [duplicateBeeper, { ...duplicateBeeper, count: 2 }],
      },
      {
        ...DEFAULT_KAREL_WORLD,
        walls: [
          { avenue: 2, street: 2, direction: 'east' },
          { avenue: 3, street: 2, direction: 'west' },
        ],
      },
      {
        ...DEFAULT_KAREL_WORLD,
        colors: [duplicateColor, { ...duplicateColor, color: '#fff' }],
      },
    ]

    for (const world of invalidWorlds) {
      const result = new KarelProtocolDecoder().push(
        unsafeFrame({ ...base, world }),
      )
      expect(result.events).toEqual([])
      expect(result.errors).toHaveLength(1)
    }
  })

  it('rejects implicit boundary walls while accepting a canonical runtime world', () => {
    const base = state(0) as unknown as Record<string, unknown>
    const invalid = new KarelProtocolDecoder().push(
      unsafeFrame({
        ...base,
        world: {
          ...DEFAULT_KAREL_WORLD,
          walls: [{ avenue: 1, street: 1, direction: 'west' }],
        },
      }),
    )
    expect(invalid.events).toEqual([])
    expect(invalid.errors).toHaveLength(1)
    expect(invalid.errors[0]?.message).toContain('implicit boundary wall')

    const valid = new KarelProtocolDecoder().push(
      unsafeFrame({ ...base, world: DEFAULT_KAREL_WORLD }),
    )
    expect(valid.errors).toEqual([])
    expect(valid.events).toEqual([state(0)])
  })

  it('reports malformed frames and continues with the next valid frame', () => {
    const decoder = new KarelProtocolDecoder()
    const malformed = `${KAREL_OSC_PREFIX}not-base64!${KAREL_OSC_TERMINATOR}`
    const result = decoder.push(`${malformed}${encodeKarelProtocolEvent(state(0))}`)

    expect(result.errors).toHaveLength(1)
    expect(result.events).toEqual([state(0)])
  })

  it('rejects an oversized complete frame before decoding and safely resumes', () => {
    const decoder = new KarelProtocolDecoder()
    const oversized = `${KAREL_OSC_PREFIX}${'A'.repeat(
      KAREL_PROTOCOL_LIMITS.maxFrameCharacters,
    )}${KAREL_OSC_TERMINATOR}`
    const result = decoder.push(
      `${oversized}student output${encodeKarelProtocolEvent(state(0))}`,
    )

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBeInstanceOf(RangeError)
    expect(result.errors[0]?.message).toContain('size limit')
    expect(result.text).toBe('student output')
    expect(result.events).toEqual([state(0)])
  })

  it('bounds reported decoder errors for forged frame floods', () => {
    const decoder = new KarelProtocolDecoder()
    const malformed = `${KAREL_OSC_PREFIX}not-valid!${KAREL_OSC_TERMINATOR}`
    const result = decoder.push(malformed.repeat(200))

    expect(result.errors).toHaveLength(KAREL_PROTOCOL_LIMITS.maxErrorsPerChunk)
    expect(result.errors.at(-1)?.message).toContain('error limit')
  })

  it('reports a truncated frame when the runtime exits', () => {
    const decoder = new KarelProtocolDecoder()
    decoder.push(`${KAREL_OSC_PREFIX}abc`)
    expect(decoder.flush().errors[0]?.message).toContain('truncated')
    expect(decoder.flush()).toEqual({ events: [], text: '', errors: [] })
  })
})
