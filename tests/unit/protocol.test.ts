import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_OSC_PREFIX,
  KAREL_OSC_TERMINATOR,
  KAREL_PROTOCOL_NAME,
  KAREL_PROTOCOL_VERSION,
  KarelProtocolDecoder,
  encodeKarelProtocolEvent,
  type KarelProtocolEvent,
} from '../../src'

function state(sequence: number): KarelProtocolEvent {
  return {
    protocol: KAREL_PROTOCOL_NAME,
    version: KAREL_PROTOCOL_VERSION,
    type: 'state',
    sequence,
    action: 'move',
    world: DEFAULT_KAREL_WORLD,
  }
}

describe('Karel OSC protocol', () => {
  it('decodes frames across every possible chunk boundary', () => {
    const frame = encodeKarelProtocolEvent(state(7))

    for (let split = 0; split <= frame.length; split += 1) {
      const decoder = new KarelProtocolDecoder()
      const first = decoder.push(`student output\n${frame.slice(0, split)}`)
      const second = decoder.push(`${frame.slice(split)}after\n`)
      expect([...first.events, ...second.events]).toEqual([state(7)])
      expect(first.text + second.text).toBe('student output\nafter\n')
      expect([...first.errors, ...second.errors]).toEqual([])
    }
  })

  it('decodes multiple frames and preserves interleaved user stdout', () => {
    const decoder = new KarelProtocolDecoder()
    const result = decoder.push(
      `before${encodeKarelProtocolEvent(state(1))}middle${encodeKarelProtocolEvent(
        state(2),
      )}after`,
    )

    expect(result.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(result.text).toBe('beforemiddleafter')
  })

  it('reports malformed frames and continues with the next valid frame', () => {
    const decoder = new KarelProtocolDecoder()
    const malformed = `${KAREL_OSC_PREFIX}not-base64!${KAREL_OSC_TERMINATOR}`
    const result = decoder.push(`${malformed}${encodeKarelProtocolEvent(state(4))}`)

    expect(result.errors).toHaveLength(1)
    expect(result.events).toEqual([state(4)])
  })

  it('rejects an oversized complete frame before decoding and safely resumes', () => {
    const decoder = new KarelProtocolDecoder()
    const oversized = `${KAREL_OSC_PREFIX}${'A'.repeat(2_000_000)}${KAREL_OSC_TERMINATOR}`
    const result = decoder.push(
      `${oversized}student output${encodeKarelProtocolEvent(state(5))}`,
    )

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBeInstanceOf(RangeError)
    expect(result.errors[0]?.message).toContain('size limit')
    expect(result.text).toBe('student output')
    expect(result.events).toEqual([state(5)])
  })

  it('reports a truncated frame when the runtime exits', () => {
    const decoder = new KarelProtocolDecoder()
    decoder.push(`${KAREL_OSC_PREFIX}abc`)
    expect(decoder.flush().errors[0]?.message).toContain('truncated')
    expect(decoder.flush()).toEqual({ events: [], text: '', errors: [] })
  })
})
