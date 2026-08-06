import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KarelProtocolDecoder } from '../../src'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

describe('bundled Python library to TypeScript protocol integration', () => {
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
      'complete',
    ])
    expect(
      decoded.events
        .filter((event) => event.type === 'state')
        .map((event) => event.action),
    ).toEqual(['load', 'move', 'turn_left'])
    const complete = decoded.events.at(-1)
    expect(complete?.type).toBe('complete')
    if (complete?.type === 'complete') {
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
      type: 'error',
      errorType: 'KarelBlockedError',
    })
  })
})
