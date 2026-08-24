import { describe, expect, it } from 'vitest'
import { DEFAULT_KAREL_WORLD } from '../../src/assets'
import {
  KarelTimeline,
  measureKarelTraceFrameBytes,
  type KarelActionTraceFrame,
  type KarelLineTraceFrame,
} from '../../src/timeline'
import { cloneKarelWorld } from '../../src/world'

function lineFrame(
  runId: string,
  sequence: number,
  avenue = sequence + 1,
): KarelLineTraceFrame {
  const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
  world.karel.avenue = avenue
  return {
    kind: 'line',
    runId,
    sequence,
    source: { path: 'main.py', line: sequence + 1, column: 1 },
    world,
  }
}

function actionFrame(runId: string, sequence: number): KarelActionTraceFrame {
  const world = cloneKarelWorld(DEFAULT_KAREL_WORLD)
  world.karel.avenue = 2
  return {
    kind: 'action',
    runId,
    sequence,
    source: { path: 'helpers/steps.py', line: 5 },
    action: 'move',
    world,
  }
}

describe('KarelTimeline', () => {
  it('models live advance, play, pause, and reset without owning a timer', () => {
    const timeline = new KarelTimeline()

    expect(timeline.getSnapshot()).toMatchObject({ phase: 'idle', frames: [] })
    expect(timeline.play()).toEqual({ accepted: false, reason: 'not-active' })

    timeline.beginRun('run-a')
    expect(timeline.getSnapshot()).toMatchObject({
      phase: 'paused',
      activeRunId: 'run-a',
    })
    expect(timeline.advance()).toEqual({ accepted: true })
    expect(timeline.getSnapshot().phase).toBe('advancing')
    expect(timeline.append(lineFrame('run-a', 0))).toMatchObject({ accepted: true })
    expect(timeline.getSnapshot().phase).toBe('paused')

    expect(timeline.play()).toEqual({ accepted: true })
    expect(timeline.getSnapshot().phase).toBe('playing')
    expect(timeline.append(actionFrame('run-a', 1))).toMatchObject({ accepted: true })
    expect(timeline.getSnapshot().phase).toBe('playing')
    expect(timeline.pause()).toEqual({ accepted: true })
    expect(timeline.getSnapshot().phase).toBe('paused')

    timeline.reset()
    expect(timeline.getSnapshot()).toMatchObject({
      phase: 'idle',
      frames: [],
      cursor: { mode: 'live' },
    })
    expect(timeline.append(lineFrame('run-a', 2))).toEqual({
      accepted: false,
      reason: 'no-active-run',
    })
  })

  it('rejects stale runs, duplicate/decreasing sequences, and post-terminal frames', () => {
    const timeline = new KarelTimeline()
    timeline.beginRun('old-run')
    expect(timeline.append(lineFrame('old-run', 0))).toMatchObject({ accepted: true })

    timeline.beginRun('current-run')
    expect(timeline.append(lineFrame('old-run', 1))).toEqual({
      accepted: false,
      reason: 'stale-run',
    })
    expect(timeline.append(lineFrame('current-run', 4, 5))).toMatchObject({
      accepted: true,
    })
    expect(timeline.append(lineFrame('current-run', 4, 5))).toEqual({
      accepted: false,
      reason: 'non-monotonic-sequence',
    })
    expect(timeline.append(lineFrame('current-run', 2, 3))).toEqual({
      accepted: false,
      reason: 'non-monotonic-sequence',
    })
    expect(
      timeline.settle({
        runId: 'current-run',
        sequence: 5,
        detail: {
          outcome: 'completed',
          world: cloneKarelWorld(DEFAULT_KAREL_WORLD),
        },
      }),
    ).toMatchObject({ accepted: true })
    expect(timeline.append(lineFrame('current-run', 6, 7))).toEqual({
      accepted: false,
      reason: 'post-terminal',
    })
  })

  it('retains immutable source/action/world correlation', () => {
    const timeline = new KarelTimeline()
    timeline.beginRun('correlated')
    const frame = actionFrame('correlated', 0)

    expect(timeline.append(frame)).toMatchObject({ accepted: true })
    frame.source!.path = 'changed.py'
    frame.world.karel.avenue = 8

    const retained = timeline.getSnapshot().frames[0]
    expect(retained).toMatchObject({
      kind: 'action',
      runId: 'correlated',
      sequence: 0,
      source: { path: 'helpers/steps.py', line: 5 },
      action: 'move',
      world: { karel: { avenue: 2 } },
    })
    expect(Object.isFrozen(retained)).toBe(true)
    expect(Object.isFrozen(retained?.world)).toBe(true)
    expect(Object.isFrozen(retained?.world.karel)).toBe(true)
  })

  it('evicts oldest frames deterministically at the frame-count cap', () => {
    const timeline = new KarelTimeline({ maxFrames: 2, maxBytes: 1_000_000 })
    timeline.beginRun('bounded-count')

    timeline.append(lineFrame('bounded-count', 0))
    timeline.append(lineFrame('bounded-count', 1))
    const acceptance = timeline.append(lineFrame('bounded-count', 2))

    expect(acceptance).toMatchObject({ accepted: true, evictedFrames: 1 })
    const snapshot = timeline.getSnapshot()
    expect(snapshot.frames.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(snapshot.retention).toMatchObject({
      maxFrames: 2,
      retainedFrames: 2,
      truncated: true,
      evictedFrames: 1,
    })
    expect(snapshot.retention.retainedBytes).toBeLessThanOrEqual(
      snapshot.retention.maxBytes,
    )
  })

  it('accounts exact UTF-8 bytes, evicts at the byte cap, and rejects one oversized frame', () => {
    const first = actionFrame('bounded-bytes', 0)
    first.action = 'paint_corner_🟦'
    const second = actionFrame('bounded-bytes', 1)
    second.action = 'move'
    const firstBytes = measureKarelTraceFrameBytes(first)
    const secondBytes = measureKarelTraceFrameBytes(second)
    const timeline = new KarelTimeline({
      maxFrames: 10,
      maxBytes: Math.max(firstBytes, secondBytes),
    })
    timeline.beginRun('bounded-bytes')

    expect(timeline.append(first)).toMatchObject({ accepted: true })
    expect(timeline.append(second)).toMatchObject({
      accepted: true,
      evictedFrames: 1,
      evictedBytes: firstBytes,
    })
    expect(timeline.getSnapshot().retention).toMatchObject({
      retainedFrames: 1,
      retainedBytes: secondBytes,
      evictedBytes: firstBytes,
    })

    const oversized = new KarelTimeline({
      maxFrames: 10,
      maxBytes: secondBytes - 1,
    })
    oversized.beginRun('bounded-bytes')
    expect(oversized.append(second)).toEqual({
      accepted: false,
      reason: 'frame-too-large',
    })
    expect(oversized.getSnapshot().retention.retainedBytes).toBe(0)
  })

  it('keeps live execution separate from recorded-history navigation', () => {
    const timeline = new KarelTimeline({ maxFrames: 3, maxBytes: 1_000_000 })
    timeline.beginRun('cursor-run')
    for (let sequence = 0; sequence < 3; sequence += 1) {
      timeline.append(lineFrame('cursor-run', sequence))
    }

    expect(timeline.stepBack()).toBe(true)
    expect(timeline.stepBack()).toBe(true)
    expect(timeline.getSnapshot()).toMatchObject({
      cursor: { mode: 'history', sequence: 0, retainedIndex: 0 },
      displayedFrame: { sequence: 0 },
      liveFrame: { sequence: 2 },
    })
    expect(timeline.advance()).toEqual({
      accepted: false,
      reason: 'history-view',
    })

    expect(timeline.stepRecordedForward()).toBe(true)
    expect(timeline.getSnapshot().cursor).toMatchObject({
      mode: 'history',
      sequence: 1,
    })
    expect(timeline.stepRecordedForward()).toBe(true)
    expect(timeline.getSnapshot()).toMatchObject({
      cursor: { mode: 'live' },
      displayedFrame: { sequence: 2 },
      liveFrame: { sequence: 2 },
    })
  })

  it('clamps an evicted history cursor without moving the live frame backward', () => {
    const timeline = new KarelTimeline({ maxFrames: 2, maxBytes: 1_000_000 })
    timeline.beginRun('evicted-cursor')
    timeline.append(lineFrame('evicted-cursor', 0))
    timeline.append(lineFrame('evicted-cursor', 1))
    timeline.stepBack()

    timeline.append(lineFrame('evicted-cursor', 2))

    expect(timeline.getSnapshot()).toMatchObject({
      cursor: { mode: 'history', sequence: 1, retainedIndex: 0 },
      displayedFrame: { sequence: 1 },
      liveFrame: { sequence: 2 },
      retention: { truncated: true, evictedFrames: 1 },
    })
  })

  it.each([
    {
      detail: {
        outcome: 'runtime-error' as const,
        message: 'Front is blocked',
        errorType: 'KarelError',
        source: { path: 'helpers/steps.py', line: 7 },
        world: cloneKarelWorld(DEFAULT_KAREL_WORLD),
      },
    },
    {
      detail: {
        outcome: 'limit-exceeded' as const,
        reason: 'output-byte-limit' as const,
        message: 'Output limit reached',
        world: cloneKarelWorld(DEFAULT_KAREL_WORLD),
      },
    },
  ])('preserves $detail.outcome terminal evidence outside bounded history', ({ detail }) => {
    const timeline = new KarelTimeline({ maxFrames: 2, maxBytes: 1_000_000 })
    timeline.beginRun('terminal-run')
    timeline.append(lineFrame('terminal-run', 0))
    timeline.append(lineFrame('terminal-run', 1))

    expect(
      timeline.settle({ runId: 'terminal-run', sequence: 2, detail }),
    ).toMatchObject({ accepted: true })
    timeline.stepBack()

    const snapshot = timeline.getSnapshot()
    expect(snapshot.phase).toBe('terminal')
    expect(snapshot.terminal).toEqual({
      runId: 'terminal-run',
      sequence: 2,
      detail,
    })
    expect(snapshot.displayedFrame?.sequence).toBe(0)
    expect(snapshot.liveFrame?.sequence).toBe(1)
    expect(Object.isFrozen(snapshot.terminal)).toBe(true)
    expect(Object.isFrozen(snapshot.terminal?.detail)).toBe(true)
  })
})
