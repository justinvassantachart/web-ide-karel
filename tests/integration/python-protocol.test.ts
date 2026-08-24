import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KarelProtocolDecoder } from '../../src'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

describe('bundled Python library to TypeScript protocol integration', () => {
  it('uses the host execution-only run identity and world resource', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'web-ide-karel-run-'))
    try {
      writeFileSync(
        path.join(directory, 'karel_run.json'),
        JSON.stringify({
          protocol: 'web-ide-karel',
          version: 2,
          runId: 'host-prepared-run',
        }),
      )
      writeFileSync(
        path.join(directory, 'karel_world.json'),
        JSON.stringify({
          name: 'Prepared World',
          columns: 2,
          rows: 1,
          karel: {
            avenue: 1,
            street: 1,
            direction: 'east',
            beepersInBag: 'infinite',
          },
          beepers: [],
          walls: [],
          colors: [],
        }),
      )
      const result = spawnSync(
        'python3',
        ['-c', 'from karel import run_karel; run_karel(lambda: None)'],
        {
          cwd: directory,
          env: {
            ...process.env,
            PYTHONPATH: path.join(repositoryRoot, 'python'),
          },
          encoding: 'utf8',
        },
      )
      const decoded = new KarelProtocolDecoder().push(result.stdout)

      expect(result.status, result.stderr).toBe(0)
      expect(decoded.errors).toEqual([])
      expect(decoded.events).toHaveLength(2)
      expect(decoded.events.map(({ runId }) => runId)).toEqual([
        'host-prepared-run',
        'host-prepared-run',
      ])
      expect(decoded.events[0]).toMatchObject({
        type: 'state',
        action: 'load',
        world: { name: 'Prepared World' },
      })
      expect(decoded.events[1]).toMatchObject({
        type: 'terminal',
        outcome: 'completed',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves student stdout while publishing real Karel actions', () => {
    const program = `
from karel import move, run_karel, turn_left

world = {
    "name": "Integration World",
    "columns": 3,
    "rows": 2,
    "karel": {
        "avenue": 1,
        "street": 1,
        "direction": "east",
        "beepersInBag": 1,
    },
    "beepers": [],
    "walls": [],
    "colors": [],
}

def main():
    print("student output remains visible")
    move()
    turn_left()

run_karel(main, world)
`
    const result = spawnSync('python3', ['-c', program], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(repositoryRoot, 'python'),
      },
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const decoder = new KarelProtocolDecoder()
    const decoded = decoder.push(result.stdout)
    const final = decoder.flush()

    expect([...decoded.errors, ...final.errors]).toEqual([])
    expect(decoded.text + final.text).toBe('student output remains visible\n')
    expect(decoded.events.map((event) => event.type)).toEqual([
      'state',
      'state',
      'state',
      'terminal',
    ])
    expect(new Set(decoded.events.map((event) => event.runId)).size).toBe(1)
    expect(decoded.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3])
    expect(
      decoded.events
        .filter((event) => event.type === 'state')
        .map((event) => event.action),
    ).toEqual(['load', 'move', 'turn_left'])
    const complete = decoded.events.at(-1)
    expect(complete).toMatchObject({ type: 'terminal', outcome: 'completed' })
    if (complete?.type === 'terminal' && complete.outcome === 'completed') {
      expect(complete.world.karel).toMatchObject({
        avenue: 2,
        street: 1,
        direction: 'north',
      })
    }
  })

  it('publishes a typed error while retaining the Python traceback', () => {
    const program = `
from karel import move, run_karel

world = {
    "name": "Blocked",
    "columns": 1,
    "rows": 1,
    "karel": {
        "avenue": 1,
        "street": 1,
        "direction": "east",
        "beepersInBag": 0,
    },
    "beepers": [], "walls": [], "colors": [],
}

run_karel(move, world)
`
    const result = spawnSync('python3', ['-c', program], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(repositoryRoot, 'python'),
      },
      encoding: 'utf8',
    })
    const decoder = new KarelProtocolDecoder()
    const decoded = decoder.push(result.stdout)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('KarelBlockedError')
    expect(decoded.events.at(-1)).toMatchObject({
      type: 'terminal',
      outcome: 'runtime-error',
      errorType: 'KarelBlockedError',
    })
  })
})
