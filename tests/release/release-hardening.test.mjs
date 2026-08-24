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
import { VALIDATION_GATE_SPECS } from '../../scripts/release/validation-contract.mjs'
import {
  moveDirectoryNoReplace,
  repositoryRoot,
} from '../../scripts/release/release-utils.mjs'
import {
  captureValidationGate,
  runCapturedGateProcess,
  scrubbedValidationEnvironment,
} from '../../scripts/release/validation-gate-runner.mjs'
import {
  normalizeValidationLogBytes,
} from '../../scripts/release/validation-log-normalization.mjs'

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
      return {
        exitCode: 0,
        logBytes: Buffer.from(
          `actual captured output from ${repositoryRoot}\ntemp=${env.TMPDIR}\n`,
        ),
      }
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
    ), 'utf8')).toBe(
      'actual captured output from <repository-root>\n'
      + 'temp=<execution-root>/tmp\n',
    )
    const receiptBytes = await readFile(path.join(
      outputDirectory,
      'validation-audit-full.receipt.json',
    ))
    const receipt = JSON.parse(receiptBytes.toString('utf8'))
    expect(receiptBytes.equals(Buffer.from(canonicalJSONString(receipt)))).toBe(true)
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      receiptKind: 'karel-release-validation-gate-capture',
      gate: {
        id: 'audit-full',
        executable: 'npm',
        argv: ['audit', '--audit-level=low'],
        exitCode: 0,
        timeoutMs: 10 * 60 * 1000,
        terminationGraceMs: 10 * 1000,
      },
      environment: {
        policy: 'normalized-release-gate-v2',
        inheritedKeys: ['PATH'],
      },
    })
  })

  it('normalizes known local roots after complete capture and rejects residual paths', () => {
    const repository = '/Users/synthetic/Projects/web-ide-karel'
    const candidate = '/Users/synthetic/Artifacts/web-ide-karel-0.2.0.tgz'
    const footer = '@@WEB_IDE_RELEASE_GATE_RECEIPT@@{"synthetic":true}'
    const captured = Buffer.concat([
      Buffer.from(`repository=${repository.slice(0, 18)}`),
      Buffer.from(`${repository.slice(18)}\ncandidate=${candidate}\n`),
      Buffer.from(`file-url=file://${repository}/src/index.ts\n`),
      Buffer.from(`token=synthetic-not-a-secret\n${footer}`),
    ])
    const normalized = normalizeValidationLogBytes(captured, [
      { value: repository, placeholder: '<repository-root>' },
      { value: candidate, placeholder: '<karel-candidate>' },
    ]).toString('utf8')
    expect(normalized).toContain('repository=<repository-root>')
    expect(normalized).toContain('candidate=<karel-candidate>')
    expect(normalized).toContain(
      'file-url=file:<repository-root>/src/index.ts',
    )
    expect(normalized).toContain('token=synthetic-not-a-secret')
    expect(normalized.endsWith(footer)).toBe(true)
    expect(normalized).not.toContain('/Users/')

    const ansiPrefixed = normalizeValidationLogBytes(
      Buffer.from(`\u001b[90m${repository}\u001b[39m\n`),
      [{ value: repository, placeholder: '<repository-root>' }],
    ).toString('utf8')
    expect(ansiPrefixed).toContain('\u001b[90m<repository-root>\u001b[39m')

    expect(() => normalizeValidationLogBytes(
      Buffer.from('unmapped=file:/Users/other/private/output.log\n'),
      [],
    )).toThrow(/unsafe local absolute path/u)
    expect(() => normalizeValidationLogBytes(
      Buffer.from('/Users/synthetic-other/private/output.log\n'),
      [{ value: '/Users/synthetic', placeholder: '<home>' }],
    )).toThrow(/unsafe local absolute path/u)
    for (const encodedOrNetworkPath of [
      'file:%2FUsers%2Fsynthetic%2Fprivate%2Foutput.log',
      String.raw`\\server\private-share\output.log`,
      '~/private/output.log',
      '/private/tmp/private/output.log',
      '/root/private/output.log',
      `/Users/unrec\u001b[31mognized/private/output.log`,
      String.raw`json: \/Users\/synthetic\/private\/output.log`,
      String.raw`C:\\Users\\synthetic\\private\\output.log`,
      String.raw`C:\Work\private\output.log`,
      'file:%2Fopt%2Fdeclared%2Fprivate%2Foutput.log',
      '%2Fopt%2Fdeclared%2Fprivate%2Foutput.log',
      'prefix<repository-root>/private/output.log',
      'file://<unknown-root>/private/output.log',
    ]) {
      expect(() => normalizeValidationLogBytes(
        Buffer.from(`${encodedOrNetworkPath}\n`),
        [],
      )).toThrow(/unsafe local absolute path|path placeholder|unknown file-path/u)
    }

    const peerSpec = VALIDATION_GATE_SPECS.get('web-ide-peer-evidence')
    expect(peerSpec.receiptExecutable).toBe('node')
    expect(peerSpec.receiptArgv).toEqual([
      '<repository-root>/scripts/release/verify-web-ide-final.mjs',
    ])
    expect(peerSpec.receiptArgv.join(' ')).not.toMatch(/\/Users\//u)
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
