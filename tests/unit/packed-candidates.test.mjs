import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isolatedNpmEnvironment,
  reportAndCleanupPackedConsumer,
  withVerifiedPackedCandidates,
} from '../../scripts/packed-candidates.mjs'

const temporaryRoots = []
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })))
})

function integrity(content) {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`
}

async function createFixture(mutate = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'karel-packed-candidates-test-'))
  temporaryRoots.push(root)
  const consumerRoot = path.join(root, 'consumer')
  const candidateRoot = path.join(root, 'candidates')
  await mkdir(path.join(consumerRoot, 'artifacts'), { recursive: true })
  await mkdir(candidateRoot, { recursive: true })

  const webIDEContent = Buffer.from('exact web ide candidate\n')
  const karelContent = Buffer.from('exact karel candidate\n')
  const manifest = JSON.parse(await readFile(path.join(
    repositoryRoot,
    'tests/production/consumer/package.json',
  ), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(
    repositoryRoot,
    'tests/production/consumer/package-lock.json',
  ), 'utf8'))
  lock.packages['node_modules/web-ide'].integrity = integrity(webIDEContent)
  lock.packages['node_modules/@web-ide/karel'].integrity = integrity(karelContent)
  mutate({ manifest, lock })
  await writeFile(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await writeFile(
    path.join(consumerRoot, 'package-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  )

  const webIDEPath = path.join(candidateRoot, 'web-ide.tgz')
  const karelPath = path.join(candidateRoot, 'web-ide-karel.tgz')
  await writeFile(webIDEPath, webIDEContent)
  await writeFile(karelPath, karelContent)
  return {
    root,
    consumerRoot,
    webIDEContent,
    karelContent,
    candidates: {
      '@web-ide/karel': karelPath,
      'web-ide': webIDEPath,
    },
  }
}

describe('withVerifiedPackedCandidates', () => {
  it('copies and verifies the exact locked pair before invoking the consumer', async () => {
    const fixture = await createFixture()
    const consume = vi.fn((verified) => verified)

    const verified = await withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume,
    })

    expect(consume).toHaveBeenCalledOnce()
    expect(verified.map(({ packageName }) => packageName)).toEqual([
      'web-ide',
      '@web-ide/karel',
    ])
    await expect(readFile(path.join(
      fixture.consumerRoot,
      'artifacts/web-ide.tgz',
    ))).resolves.toEqual(fixture.webIDEContent)
    await expect(readFile(path.join(
      fixture.consumerRoot,
      'artifacts/web-ide-karel.tgz',
    ))).resolves.toEqual(fixture.karelContent)
  })

  it.each([
    [
      'manifest reference',
      ({ manifest }) => {
        manifest.dependencies['web-ide'] = 'file:artifacts/wrong.tgz'
      },
      /package\.json dependency web-ide/u,
    ],
    [
      'root lock reference',
      ({ lock }) => {
        lock.packages[''].dependencies['web-ide'] =
          'file:artifacts/wrong.tgz'
      },
      /package-lock\.json root dependency web-ide/u,
    ],
    [
      'package lock resolution',
      ({ lock }) => {
        lock.packages['node_modules/web-ide'].resolved =
          'file:artifacts/wrong.tgz'
      },
      /package-lock\.json resolution web-ide/u,
    ],
  ])('rejects a wrong %s before invoking npm', async (_label, mutate, message) => {
    const fixture = await createFixture(mutate)
    const consume = vi.fn()

    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume,
    })).rejects.toThrow(message)
    expect(consume).not.toHaveBeenCalled()
  })

  it.each([
    [
      'package version',
      ({ lock }) => {
        lock.packages['node_modules/@web-ide/karel'].version = '0.2.1'
      },
      /package-lock\.json version @web-ide\/karel/u,
    ],
    [
      'Web IDE peer',
      ({ lock }) => {
        lock.packages['node_modules/@web-ide/karel']
          .peerDependencies['web-ide'] = '>=0.3.0'
      },
      /package-lock\.json Web IDE peer @web-ide\/karel/u,
    ],
  ])('rejects a wrong locked %s', async (_label, mutate, message) => {
    const fixture = await createFixture(mutate)
    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume: vi.fn(),
    })).rejects.toThrow(message)
  })

  it('rejects malformed lock integrity before invoking npm', async () => {
    const fixture = await createFixture(({ lock }) => {
      lock.packages['node_modules/web-ide'].integrity = 'sha512-not-base64'
    })
    const consume = vi.fn()

    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume,
    })).rejects.toThrow(/canonical SHA-512 integrity/u)
    expect(consume).not.toHaveBeenCalled()
  })

  it.each([
    ['a relative path', () => 'web-ide.tgz', /absolute path/u],
    [
      'a missing file',
      (fixture) => path.join(fixture.root, 'missing.tgz'),
      /readable regular file/u,
    ],
    ['a directory', (fixture) => fixture.root, /readable regular file/u],
  ])('rejects %s for a candidate', async (_label, candidate, message) => {
    const fixture = await createFixture()
    const consume = vi.fn()

    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: {
        ...fixture.candidates,
        'web-ide': candidate(fixture),
      },
      consume,
    })).rejects.toThrow(message)
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects a corrupted candidate and removes all copied destinations', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.candidates['@web-ide/karel'], 'corrupt bytes\n')
    const consume = vi.fn()

    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume,
    })).rejects.toThrow(/copied candidate integrity mismatch/u)
    expect(consume).not.toHaveBeenCalled()
    await expect(stat(path.join(
      fixture.consumerRoot,
      'artifacts/web-ide.tgz',
    ))).rejects.toThrow()
    await expect(stat(path.join(
      fixture.consumerRoot,
      'artifacts/web-ide-karel.tgz',
    ))).rejects.toThrow()
  })

  it('cannot bypass a corrupt input with pre-existing cached destination bytes', async () => {
    const fixture = await createFixture()
    await writeFile(
      path.join(fixture.consumerRoot, 'artifacts/web-ide-karel.tgz'),
      fixture.karelContent,
    )
    await writeFile(fixture.candidates['@web-ide/karel'], 'changed input\n')
    const consume = vi.fn()

    await expect(withVerifiedPackedCandidates({
      consumerRoot: fixture.consumerRoot,
      candidates: fixture.candidates,
      consume,
    })).rejects.toThrow(/copied candidate integrity mismatch/u)
    expect(consume).not.toHaveBeenCalled()
    await expect(stat(path.join(
      fixture.consumerRoot,
      'artifacts/web-ide-karel.tgz',
    ))).rejects.toThrow()
  })
})

describe('isolatedNpmEnvironment', () => {
  it('replaces every inherited cache spelling and enforces strict installs', () => {
    const cache = path.join(tmpdir(), 'fresh-packed-cache')
    const environment = isolatedNpmEnvironment({
      PATH: '/bin',
      npm_config_cache: '/old-lower',
      NPM_CONFIG_CACHE: '/old-upper',
      NpM_CoNfIg_CaChE: '/old-mixed',
      npm_config_ignore_scripts: 'false',
      npm_config_strict_peer_deps: 'false',
      NODE_OPTIONS: '--require /tmp/untrusted.cjs',
      KAREL_PRODUCTION_DIAGNOSTIC_GREP: 'skip',
      PLAYWRIGHT_TEST_BASE_URL: 'https://untrusted.example.test',
    }, cache)

    expect(environment).toMatchObject({
      PATH: '/bin',
      npm_config_cache: cache,
      npm_config_engine_strict: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_strict_peer_deps: 'true',
    })
    expect(Object.keys(environment).filter(
      (key) => key.toLowerCase() === 'npm_config_cache',
    )).toEqual(['npm_config_cache'])
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('KAREL_PRODUCTION_DIAGNOSTIC_GREP')
    expect(environment).not.toHaveProperty('PLAYWRIGHT_TEST_BASE_URL')
  })

  it('rejects a relative cache path', () => {
    expect(() => isolatedNpmEnvironment({}, 'relative-cache'))
      .toThrow(/cache path must be absolute/u)
  })
})

describe('packed consumer cleanup', () => {
  it('removes the temporary consumer even when evidence reporting fails', async () => {
    const report = vi.fn(async () => {
      throw new Error('evidence report failed')
    })
    const cleanup = vi.fn()

    await expect(reportAndCleanupPackedConsumer({
      keepTemporary: false,
      report,
      cleanup,
      onRetained: vi.fn(),
    })).rejects.toThrow('evidence report failed')
    expect(report).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('preserves evidence and cleanup errors when both finalization steps fail', async () => {
    const reportError = new Error('evidence report failed')
    const cleanupError = new Error('temporary cleanup failed')
    let received

    try {
      await reportAndCleanupPackedConsumer({
        keepTemporary: false,
        report: async () => {
          throw reportError
        },
        cleanup: async () => {
          throw cleanupError
        },
        onRetained: vi.fn(),
      })
    } catch (error) {
      received = error
    }

    expect(received).toBeInstanceOf(AggregateError)
    expect(received.errors).toEqual([reportError, cleanupError])
  })

  it('removes the temporary consumer after an early artifact setup failure', async () => {
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), 'karel-packed-cleanup-test-'),
    )
    temporaryRoots.push(fixtureRoot)
    const blockedArtifactParent = path.join(fixtureRoot, 'not-a-directory')
    await writeFile(blockedArtifactParent, 'synthetic blocker\n')
    const prefix = 'web-ide-karel-packed-production-'
    const before = new Set((await readdir(fixtureRoot)).filter(
      (name) => name.startsWith(prefix),
    ))

    const result = spawnSync(
      process.execPath,
      ['scripts/validate-packed-production-consumer.mjs'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KAREL_PRODUCTION_ARTIFACT_DIR: blockedArtifactParent,
          TEMP: fixtureRoot,
          TMP: fixtureRoot,
          TMPDIR: fixtureRoot,
        },
      },
    )

    const after = (await readdir(fixtureRoot)).filter(
      (name) => name.startsWith(prefix) && !before.has(name),
    )
    try {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('not-a-directory')
      expect(after).toEqual([])
    } finally {
      await Promise.all(after.map((name) => rm(
        path.join(fixtureRoot, name),
        { recursive: true, force: true },
      )))
    }
  })
})
