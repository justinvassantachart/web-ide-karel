import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { canonicalJSONString } from '../../scripts/release/canonical-json.mjs'
import {
  validateProductionConsumerLock,
  validateProductionConsumerManifest,
} from '../../scripts/release/consumer-lock.mjs'
import {
  moveDirectoryNoReplace,
  repositoryRoot,
} from '../../scripts/release/release-utils.mjs'
import {
  captureValidationGate,
  runCapturedGateProcess,
  scrubbedValidationEnvironment,
} from '../../scripts/release/validation-gate-runner.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

describe('exact packed consumer contract', () => {
  it('rejects manifest/root drift and behavior-affecting artifact lock fields', async () => {
    const manifest = JSON.parse(await readFile(path.join(
      repositoryRoot,
      'tests/production/consumer/package.json',
    ), 'utf8'))
    const lock = JSON.parse(await readFile(path.join(
      repositoryRoot,
      'tests/production/consumer/package-lock.json',
    ), 'utf8'))
    expect(validateProductionConsumerManifest(manifest)).toBe(manifest)
    expect(validateProductionConsumerLock(lock).webIDE.binding).toBe('pending')

    const manifestDrift = structuredClone(manifest)
    manifestDrift.dependencies.react = '19.2.7'
    expect(() => validateProductionConsumerManifest(manifestDrift))
      .toThrow(/exact release contract/u)

    const extraRoot = structuredClone(lock)
    extraRoot.packages[''].link = true
    expect(() => validateProductionConsumerLock(extraRoot))
      .toThrow(/unknown field link/u)

    const installHook = structuredClone(lock)
    installHook.packages['node_modules/web-ide'].hasInstallScript = true
    expect(() => validateProductionConsumerLock(installHook))
      .toThrow(/unknown field hasInstallScript/u)

    const peerDrift = structuredClone(lock)
    peerDrift.packages['node_modules/@web-ide/karel']
      .peerDependencies['web-ide'] = '*'
    expect(() => validateProductionConsumerLock(peerDrift))
      .toThrow(/identity differs/u)

    const transitiveRegistryDrift = structuredClone(lock)
    transitiveRegistryDrift.packages['node_modules/vite'].resolved
      = 'https://unreviewed.example.invalid/vite-7.3.6.tgz'
    expect(() => validateProductionConsumerLock(transitiveRegistryDrift))
      .toThrow(/complete transitive lock graph/u)

    const transitiveLifecycleHook = structuredClone(lock)
    transitiveLifecycleHook.packages['node_modules/vite'].hasInstallScript = true
    expect(() => validateProductionConsumerLock(transitiveLifecycleHook))
      .toThrow(/complete transitive lock graph/u)

    const extraGitNode = structuredClone(lock)
    extraGitNode.packages['node_modules/unreviewed-git-package'] = {
      version: '1.0.0',
      resolved: 'git+https://github.com/example/unreviewed.git#deadbeef',
    }
    expect(() => validateProductionConsumerLock(extraGitNode))
      .toThrow(/complete transitive lock graph/u)

    expect(() => validateProductionConsumerLock(lock, {
      webIDEIntegrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
      requireWebIDEIntegrity: true,
    })).toThrow(/integrity is not exact/u)
  })
})

describe('captured validation gate evidence', () => {
  it('scrubs injected Node/npm/test state and records the actual process exit/log', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-gate-capture-test-'))
    temporaryDirectories.push(directory)
    const outputDirectory = path.join(directory, 'capture')
    const execute = vi.fn(async ({ env, timeoutMs, terminationGraceMs }) => {
      expect(env).not.toHaveProperty('NODE_OPTIONS')
      expect(env).not.toHaveProperty('NPM_CONFIG_REGISTRY')
      expect(env).not.toHaveProperty('KAREL_PRODUCTION_DIAGNOSTIC_GREP')
      expect(env.npm_config_ignore_scripts).toBe('true')
      expect(timeoutMs).toBe(10 * 60 * 1000)
      expect(terminationGraceMs).toBe(10 * 1000)
      return { exitCode: 0, logBytes: Buffer.from('actual captured output\n') }
    })
    const capture = await captureValidationGate({
      gateId: 'audit-full',
      outputDirectory,
      sourceCommit: 'a'.repeat(40),
      candidateSha256: 'b'.repeat(64),
      webIDECandidateSha256: 'c'.repeat(64),
      webIDESourceCommit: 'd'.repeat(40),
      cwd: repositoryRoot,
      environmentFactory: async () => scrubbedValidationEnvironment({
        PATH: process.env.PATH,
        NODE_OPTIONS: '--require /tmp/untrusted.cjs',
        NPM_CONFIG_REGISTRY: 'https://untrusted.example.test',
        KAREL_PRODUCTION_DIAGNOSTIC_GREP: 'skip',
      }),
      execute,
    })
    expect(capture.exitCode).toBe(0)
    expect(execute).toHaveBeenCalledOnce()
    expect(await readFile(path.join(
      outputDirectory,
      'validation-audit-full.log',
    ), 'utf8')).toBe('actual captured output\n')
    const receiptBytes = await readFile(path.join(
      outputDirectory,
      'validation-audit-full.receipt.json',
    ))
    const receipt = JSON.parse(receiptBytes.toString('utf8'))
    expect(receiptBytes.equals(Buffer.from(canonicalJSONString(receipt)))).toBe(true)
    expect(receipt).toMatchObject({
      receiptKind: 'karel-release-validation-gate-capture',
      gate: {
        id: 'audit-full',
        exitCode: 0,
        timeoutMs: 10 * 60 * 1000,
        terminationGraceMs: 10 * 1000,
      },
      environment: {
        policy: 'scrubbed-release-gate-v1',
        inheritedKeys: ['PATH'],
      },
    })
  })

  it('settles a timed-out hung process tree before rejecting', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-hung-gate-test-'))
    temporaryDirectories.push(directory)
    const descendantPidPath = path.join(directory, 'descendant.pid')
    const descendantSource = [
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const parentSource = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' })`,
      'writeFileSync(process.argv[1], String(descendant.pid))',
      'setInterval(() => {}, 1000)',
    ].join(';')

    await expect(runCapturedGateProcess({
      executable: process.execPath,
      argv: ['-e', parentSource, descendantPidPath],
      cwd: repositoryRoot,
      env: { LANG: 'C', LC_ALL: 'C' },
      timeoutMs: 1000,
      terminationGraceMs: 100,
    })).rejects.toThrow(/1000ms wall-clock timeout/u)

    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'))
    expect(Number.isSafeInteger(descendantPid)).toBe(true)
    expect(processIsAlive(descendantPid)).toBe(false)
  })

  it('escalates a noisy SIGTERM-ignoring child to SIGKILL before rejecting', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-noisy-gate-test-'))
    temporaryDirectories.push(directory)
    const childPidPath = path.join(directory, 'child.pid')
    const termMarkerPath = path.join(directory, 'sigterm.marker')
    const childSource = [
      "const { writeFileSync } = require('node:fs')",
      'writeFileSync(process.argv[1], String(process.pid))',
      "process.on('SIGTERM', () => writeFileSync(process.argv[2], 'received\\n'))",
      "const chunk = 'x'.repeat(4096)",
      'setInterval(() => { process.stdout.write(chunk) }, 5)',
    ].join(';')

    await expect(runCapturedGateProcess({
      executable: process.execPath,
      argv: ['-e', childSource, childPidPath, termMarkerPath],
      cwd: repositoryRoot,
      env: { LANG: 'C', LC_ALL: 'C' },
      timeoutMs: 1000,
      terminationGraceMs: 100,
    })).rejects.toThrow(/1000ms wall-clock timeout/u)

    const childPid = Number(await readFile(childPidPath, 'utf8'))
    expect(await readFile(termMarkerPath, 'utf8')).toBe('received\n')
    expect(processIsAlive(childPid)).toBe(false)
  })
})

describe('exclusive evidence publication', () => {
  it('does not replace an empty destination created at publication time', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-no-replace-test-'))
    temporaryDirectories.push(directory)
    const stage = path.join(directory, 'stage')
    const target = path.join(directory, 'target')
    await mkdir(stage)
    await writeFile(path.join(stage, 'evidence.txt'), 'retained stage\n')
    await mkdir(target)
    await expect(moveDirectoryNoReplace(stage, target))
      .rejects.toThrow(/appeared while evidence was staged/u)
    await expect(readFile(path.join(stage, 'evidence.txt'), 'utf8'))
      .rejects.toThrow()
    await expect(readFile(path.join(target, 'evidence.txt'), 'utf8'))
      .rejects.toThrow()
  })

  it('does not follow a destination symlink created at publication time', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-no-follow-test-'))
    temporaryDirectories.push(directory)
    const stage = path.join(directory, 'stage')
    const target = path.join(directory, 'target')
    const outside = path.join(directory, 'outside')
    await mkdir(stage)
    await writeFile(path.join(stage, 'evidence.txt'), 'retained stage\n')
    await mkdir(outside)
    await symlink(outside, target)
    await expect(moveDirectoryNoReplace(stage, target))
      .rejects.toThrow(/appeared while evidence was staged/u)
    expect(await readFile(path.join(stage, 'evidence.txt'), 'utf8'))
      .toBe('retained stage\n')
    await expect(readFile(path.join(outside, 'evidence.txt'), 'utf8'))
      .rejects.toThrow()
  })
})
