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
import {
  candidateIdentityForConfiguration,
} from '../../scripts/release/web-ide-candidate-evidence.mjs'
import {
  engineIdentity,
  WEB_IDE_040_ENGINE_ASSET_URL,
} from '../../scripts/release/web-ide-engine-identity.mjs'
import {
  validateWebRuntimeManifest,
} from '../../scripts/release/web-ide-evidence.mjs'

const temporaryDirectories = []

const CURRENT_PAIR = Object.freeze({
  webIDEVersion: '0.4.0',
  karelVersion: '0.3.3',
})

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
  it('routes release capture through the configured Web IDE candidate identity', async () => {
    expect(candidateIdentityForConfiguration({
      webIDE: { package: 'web-ide@0.3.1' },
    })).toMatchObject({
      package: 'web-ide@0.3.1',
      capabilityReleaseId: 'hamilton.python/2',
      sourceTag: 'web-ide-v0.3.1-source',
    })

    const captureSource = await readFile(path.join(
      repositoryRoot,
      'scripts/release/capture-validation-gate.mjs',
    ), 'utf8')
    expect(captureSource).toContain(
      'candidateIdentityForConfiguration(configuration)',
    )
    expect(captureSource).toContain('configuration.webIDE.sourceTag')
  })

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
    expect(validateProductionConsumerLock(lock, CURRENT_PAIR).webIDE.binding)
      .toBe('pending')

    const manifestDrift = structuredClone(manifest)
    manifestDrift.dependencies.react = '19.2.7'
    expect(() => validateProductionConsumerManifest(manifestDrift))
      .toThrow(/exact release contract/u)

    const extraRoot = structuredClone(lock)
    extraRoot.packages[''].link = true
    expect(() => validateProductionConsumerLock(extraRoot, CURRENT_PAIR))
      .toThrow(/unknown field link/u)

    const installHook = structuredClone(lock)
    installHook.packages['node_modules/web-ide'].hasInstallScript = true
    expect(() => validateProductionConsumerLock(installHook, CURRENT_PAIR))
      .toThrow(/unknown field hasInstallScript/u)

    const peerDrift = structuredClone(lock)
    peerDrift.packages['node_modules/@web-ide/karel']
      .peerDependencies['web-ide'] = '*'
    expect(() => validateProductionConsumerLock(peerDrift, CURRENT_PAIR))
      .toThrow(/identity differs/u)

    const transitiveRegistryDrift = structuredClone(lock)
    transitiveRegistryDrift.packages['node_modules/vite'].resolved
      = 'https://unreviewed.example.invalid/vite-7.3.6.tgz'
    expect(() => validateProductionConsumerLock(
      transitiveRegistryDrift,
      CURRENT_PAIR,
    )).toThrow(/complete transitive lock graph/u)

    const transitiveLifecycleHook = structuredClone(lock)
    transitiveLifecycleHook.packages['node_modules/vite'].hasInstallScript = true
    expect(() => validateProductionConsumerLock(
      transitiveLifecycleHook,
      CURRENT_PAIR,
    )).toThrow(/complete transitive lock graph/u)

    const extraGitNode = structuredClone(lock)
    extraGitNode.packages['node_modules/unreviewed-git-package'] = {
      version: '1.0.0',
      resolved: 'git+https://github.com/example/unreviewed.git#deadbeef',
    }
    expect(() => validateProductionConsumerLock(extraGitNode, CURRENT_PAIR))
      .toThrow(/complete transitive lock graph/u)

    expect(() => validateProductionConsumerLock(lock, {
      ...CURRENT_PAIR,
      webIDEIntegrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
      requireWebIDEIntegrity: true,
    })).toThrow(/integrity is not exact/u)
  })

  it('validates the active pair while preserving every historical graph', async () => {
    const active = JSON.parse(await readFile(path.join(
      repositoryRoot,
      'tests/production/consumer/package-lock.json',
    ), 'utf8'))
    const historical = JSON.parse(await readFile(path.join(
      repositoryRoot,
      'release/web-ide-0.3.1-compatibility.package-lock.json',
    ), 'utf8'))
    expect(validateProductionConsumerLock(active, CURRENT_PAIR).webIDE.binding)
      .toBe('pending')
    for (const [webIDEVersion, karelVersion] of [
      ['0.3.0', '0.3.1'], ['0.3.1', '0.3.1'], ['0.3.1', '0.3.2'],
    ]) {
      const lock = structuredClone(historical)
      lock.packages['node_modules/web-ide'].version = webIDEVersion
      lock.packages['node_modules/@web-ide/karel'].version = karelVersion
      expect(validateProductionConsumerLock(lock, {
        webIDEVersion, karelVersion,
      }).webIDE.binding).toBe('pending')
    }
    expect(() => validateProductionConsumerLock(historical))
      .toThrow(/locked release contract/u)
  })

  it('accepts the exact 0.4.0/0.3.3 graph and rejects peer or engine drift', async () => {
    const committed = JSON.parse(await readFile(path.join(
      repositoryRoot,
      'tests/production/consumer/package-lock.json',
    ), 'utf8'))

    expect(validateProductionConsumerLock(committed).webIDE.binding)
      .toBe('pending')

    const narrowPeer = structuredClone(committed)
    narrowPeer.packages['node_modules/@web-ide/karel']
      .peerDependencies['web-ide'] = '>=0.3.0 <0.4.0'
    expect(() => validateProductionConsumerLock(narrowPeer))
      .toThrow(/Karel lock entry identity differs/u)

    // The fork is distributed only as a public GitHub release asset, so a
    // registry specifier or registry resolution for the engine fails closed.
    const registryDebugger = structuredClone(committed)
    registryDebugger.packages['node_modules/web-ide']
      .dependencies['debugger-sh'] = '0.3.15-webide.0.4.0.1'
    expect(() => validateProductionConsumerLock(registryDebugger))
      .toThrow(/Web IDE lock entry identity differs/u)

    const staleDebugger = structuredClone(committed)
    staleDebugger.packages['node_modules/web-ide']
      .dependencies['debugger-sh'] = '0.3.15'
    expect(() => validateProductionConsumerLock(staleDebugger))
      .toThrow(/Web IDE lock entry identity differs/u)

    const registryResolvedEngine = structuredClone(committed)
    registryResolvedEngine.packages['node_modules/debugger-sh'].resolved
      = 'https://registry.npmjs.org/debugger-sh/-/debugger-sh-0.3.15-webide.0.4.0.1.tgz'
    expect(() => validateProductionConsumerLock(registryResolvedEngine))
      .toThrow(/debugger-sh lock entry is not the exact reviewed fork release asset/u)

    const substitutedEngine = structuredClone(committed)
    substitutedEngine.packages['node_modules/debugger-sh'].integrity
      = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
    expect(() => validateProductionConsumerLock(substitutedEngine))
      .toThrow(/debugger-sh lock entry is not the exact reviewed fork release asset/u)

    const absentEngine = structuredClone(committed)
    delete absentEngine.packages['node_modules/debugger-sh']
    expect(() => validateProductionConsumerLock(absentEngine))
      .toThrow(/debugger-sh lock entry is absent/u)

  })

  it('keeps the packed browser gate serial, retry-free, and process-isolated', async () => {
    const [config, spec] = await Promise.all([
      readFile(path.join(
        repositoryRoot,
        'tests/production/consumer/playwright.config.ts.template',
      ), 'utf8'),
      readFile(path.join(
        repositoryRoot,
        'tests/production/consumer/tests/packed-karel.spec.ts.template',
      ), 'utf8'),
    ])

    expect(config).toMatch(/fullyParallel:\s*false/u)
    expect(config).toMatch(/workers:\s*1/u)
    expect(config).toMatch(/retries:\s*0/u)
    expect(spec).toContain('const test = base.extend({')
    expect(spec).toContain('const browserType = playwright[browserName]')
    expect(spec).toContain('const browser = await browserType.launch()')
    expect(spec).toContain('await browser.newContext(browserContextOptions)')
    expect(spec).toContain('await browser.close()')
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
          `actual captured output from ${repositoryRoot}\ntemp=${env.TMPDIR}/consumer\n`,
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
      + 'temp=<execution-root>/consumer\n',
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
    const candidate = '/Users/synthetic/Artifacts/web-ide-karel-0.3.2.tgz'
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

// Web IDE 0.4.0 installs the debugger-sh fork from one public GitHub release
// asset and embeds its engine WebAssembly, so Karel's Web-runtime validator has
// to bind that exact asset and reject every runtime engine download.
describe('exact Web IDE 0.4.0 fork engine evidence', () => {
  function forkRuntime() {
    return {
      observedDate: '2026-08-24',
      digestRepresentation: 'identity-encoded-response-body',
      expectedRedirectCount: 0,
      requestTimeoutMs: 1000,
      scope: 'Synthetic fork-engine fixture.',
      limitations: ['Synthetic bytes only.'],
      assets: Array.from({ length: 26 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          id: `fixture.${suffix}`,
          version: 'fixture',
          requestedUrl: `https://assets.example.test/runtime-${suffix}.wasm`,
          finalUrl: `https://assets.example.test/runtime-${suffix}.wasm`,
          size: 1,
          sha256: index.toString(16).padStart(64, '0'),
          contentType: 'application/wasm',
          headers: {
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': null,
          },
          license: 'MIT',
        }
      }),
      engine: {
        name: 'debugger-sh',
        version: '0.3.15-webide.0.4.0.1',
        registryPublished: false,
        source: {
          repository: 'https://github.com/justinvassantachart/engine',
          commit: 'b7236bda9c8fef31cd771fe770c2145f11ac0682',
          acceptedBaseCommit: '58cbc9369e3f7738a6dc9b01082723d144bb9c97',
          upstreamRepository: 'https://github.com/debugger-sh/engine',
          upstreamVersion: '0.3.15',
          upstreamCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
        },
        build: {
          kind: 'embedded-wasm-library-build',
          toolchain: {
            node: 'v24.11.1',
            npm: '11.6.2',
            rustc: 'rustc 1.95.0 (59807616e 2026-04-14)',
            cargo: 'cargo 1.95.0 (f2d3ce0bd 2026-03-21)',
            wasmPack: 'wasm-pack 0.14.0',
          },
        },
        distribution: {
          mechanism: 'public-github-release-asset',
          repository: 'justinvassantachart/engine',
          tag: 'debugger-sh-v0.3.15-webide.0.4.0.1',
          assetFilename: 'debugger-sh-0.3.15-webide.0.4.0.1.tgz',
          url: WEB_IDE_040_ENGINE_ASSET_URL,
          size: 27818347,
          sha256:
            'feaaf9da592ee6be8ee68705bd2c2ad79db69528df4fcdf2d1c20b01b51f1bf7',
          sha512Integrity:
            'sha512-EMYupTFpj9buXYwQ9yt8vZNr7yEaKG7K4/9KHmPMhPN+RRk+/Zm0oyTsJlt5Xjcb7Z3XtWGRkz5dnAt2S4X7iA==',
        },
        lock: {
          version: '0.3.15-webide.0.4.0.1',
          resolved: WEB_IDE_040_ENGINE_ASSET_URL,
          integrity:
            'sha512-EMYupTFpj9buXYwQ9yt8vZNr7yEaKG7K4/9KHmPMhPN+RRk+/Zm0oyTsJlt5Xjcb7Z3XtWGRkz5dnAt2S4X7iA==',
        },
        embeddedWasm: {
          wasmPath: 'dist/engine_bg.wasm',
          wasmLoadedAtRuntime: false,
          modulePath: 'dist/debugger-sh.js',
          remotelyFetched: false,
          wasmSize: 8880594,
          wasmSha256:
            'df46b583db11d22ed49006746cdf630e3632f3a34499798d4dc19b7634928d24',
          moduleSize: 23760324,
          moduleSha256:
            'fc29a20e6318c41583fae83fddef24c7ee068001ad2f43e97acb6154b319f6b4',
        },
      },
    }
  }

  const fork = engineIdentity('0.4.0')

  function expectRejected(mutate, pattern) {
    const runtime = forkRuntime()
    mutate(runtime)
    expect(() => validateWebRuntimeManifest(runtime, false, fork)).toThrow(pattern)
  }

  it('binds the exact fork release asset and embedded engine WebAssembly', () => {
    expect(fork.dependencySpecifier).toBe(WEB_IDE_040_ENGINE_ASSET_URL)
    expect(fork.runtimeAssetCount).toBe(26)
    expect(validateWebRuntimeManifest(forkRuntime(), false, fork)).toBeUndefined()

    // The 0.3.x registry record shape is no longer accepted for 0.4.0.
    expectRejected((runtime) => {
      runtime.debuggerSh = runtime.engine
      delete runtime.engine
    }, /runtime has unknown field debuggerSh/u)
  })

  it('rejects wrong fork asset identities, npm publication, and remote engine fetches', () => {
    expectRejected((runtime) => {
      runtime.engine.distribution.url
        = 'https://github.com/justinvassantachart/engine/releases/download/debugger-sh-v0.3.15-webide.0.4.0.1/other.tgz'
    }, /exact reviewed fork release asset/u)
    expectRejected((runtime) => {
      runtime.engine.distribution.sha256 = 'a'.repeat(64)
    }, /exact reviewed fork release asset/u)
    expectRejected((runtime) => {
      runtime.engine.distribution.size = 27818346
    }, /exact reviewed fork release asset/u)
    expectRejected((runtime) => {
      runtime.engine.distribution.mechanism = 'npm-registry'
    }, /exact reviewed fork release asset/u)
    expectRejected((runtime) => {
      runtime.engine.registryPublished = true
    }, /registryPublished must be false/u)
    expectRejected((runtime) => {
      runtime.engine.lock.resolved
        = 'https://registry.npmjs.org/debugger-sh/-/debugger-sh-0.3.15-webide.0.4.0.1.tgz'
    }, /lock does not pin the exact reviewed fork release asset/u)
    expectRejected((runtime) => {
      runtime.engine.source.commit = '0'.repeat(40)
    }, /exact reviewed fork source identity/u)
    expectRejected((runtime) => {
      runtime.engine.source.acceptedBaseCommit = '0'.repeat(40)
    }, /exact reviewed fork source identity/u)
    expectRejected((runtime) => {
      delete runtime.engine.source.acceptedBaseCommit
    }, /source is missing required field acceptedBaseCommit/u)
    expectRejected((runtime) => {
      runtime.engine.source.upstreamCommit = '0'.repeat(40)
    }, /exact reviewed fork source identity/u)
    expectRejected((runtime) => {
      runtime.engine.build.kind = 'wasm-release-build'
    }, /reviewed fork build kind/u)
    expectRejected((runtime) => {
      delete runtime.engine.build.toolchain.rustc
    }, /build\.toolchain/u)
    expectRejected((runtime) => {
      runtime.engine.build.toolchain.rustc = 'rustc unreviewed'
    }, /reviewed fork toolchain/u)
    expectRejected((runtime) => {
      runtime.engine.embeddedWasm.wasmLoadedAtRuntime = true
    }, /wasmLoadedAtRuntime must be false/u)
    expectRejected((runtime) => {
      runtime.engine.embeddedWasm.remotelyFetched = true
    }, /remotelyFetched must be false/u)
    expectRejected((runtime) => {
      runtime.engine.embeddedWasm.wasmSha256 = 'b'.repeat(64)
    }, /exact reviewed embedded engine identity/u)
    expectRejected((runtime) => {
      runtime.engine.embeddedWasm.moduleSize = 23760323
    }, /exact reviewed embedded engine identity/u)
    expectRejected((runtime) => {
      runtime.engine.unreviewedField = 'accepted?'
    }, /runtime engine has unknown field unreviewedField/u)
  })

  it('rejects any locked remote engine WebAssembly or fork asset request', () => {
    expectRejected((runtime) => {
      for (const [index, asset] of runtime.assets.entries()) {
        asset.id = index === 0
          ? 'debugger-sh.engine-bg.wasm'
          : `fixture.${String(index).padStart(2, '0')}`
      }
    }, /locks the embedded fork engine WebAssembly as a remote runtime asset/u)
    expectRejected((runtime) => {
      runtime.assets[25].id = 'zdebugger-sh.engine-bg.wasm'
      runtime.assets[25].requestedUrl = WEB_IDE_040_ENGINE_ASSET_URL
      runtime.assets[25].finalUrl = WEB_IDE_040_ENGINE_ASSET_URL
    }, /fetches a fork release asset at run time/u)
    expectRejected((runtime) => {
      runtime.assets[25].finalUrl
        = 'https://github.com/justinvassantachart/engine/releases/download/debugger-sh-v0.3.15-webide.0.4.0.1/debugger-sh-0.3.15-webide.0.4.0.1.tgz'
    }, /fetches a fork release asset at run time/u)
    expectRejected((runtime) => {
      runtime.assets.push(structuredClone(runtime.assets[25]))
    }, /runtime identity is incomplete/u)
    expectRejected((runtime) => {
      runtime.assets.pop()
    }, /runtime identity is incomplete/u)
  })
})
