import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { validateArtifactManifest } from '../../scripts/release/artifact-manifest.mjs'
import {
  exactActivePairCompatibilityEvidence,
} from '../../scripts/release/active-pair-compatibility-receipt.mjs'
import { settleAllBuilds } from '../../scripts/release/candidate-builds.mjs'
import {
  CANDIDATE_ARTIFACT_FILES,
  HISTORICAL_0_3_1_ARTIFACT_FILES,
  validateCandidateState,
  validateDeterminismReport,
} from '../../scripts/release/candidate-evidence.mjs'
import { canonicalJSONString } from '../../scripts/release/canonical-json.mjs'
import { generateLicenseEvidence } from '../../scripts/release/license-evidence.mjs'
import {
  EXPECTED_KAREL_PACKAGE_FILES,
  inspectExistingPackedPackage,
  readPackageTarball,
} from '../../scripts/release/package-inspection.mjs'
import {
  git,
  hermeticGitEnvironment,
  run,
  verifyHermeticGitRepository,
} from '../../scripts/release/process-utils.mjs'
import {
  isolatedNpmEnvironment,
  readBoundedFile,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sha512IntegrityBytes,
  withAtomicOutputDirectory,
} from '../../scripts/release/release-utils.mjs'
import { generateCycloneDx, validateCycloneDx } from '../../scripts/release/sbom.mjs'
import {
  assertReleaseSourceStateUnchanged,
  sourceArchiveBytes,
  verifyReleaseSourceState,
} from '../../scripts/release/source-state.mjs'
import { verifyWebIDECandidateEvidence } from '../../scripts/release/web-ide-candidate-evidence.mjs'
import {
  validateWebIDERuntimeReport,
  verifyWebIDEEvidence,
} from '../../scripts/release/web-ide-evidence.mjs'
import {
  exactPairCompatibilityEvidence,
  formatWebIDECompatibilityReceipt,
  WEB_IDE_GATE_RECEIPT_PREFIX,
  webIDECompatibilityReceipt,
} from '../../scripts/release/web-compatibility-receipt.mjs'
import {
  EXPECTED_VALIDATION_GATES,
  materializeValidationEvidence,
  validateMaterializedValidationEvidence,
  validateValidationLogBytes,
  validateValidationInput,
} from '../../scripts/release/validation-evidence.mjs'
import { VALIDATION_GATE_SPECS } from '../../scripts/release/validation-contract.mjs'

const temporaryDirectories = []
const currentKarelPackageManifest = JSON.parse(await readFile(path.join(
  repositoryRoot,
  'package.json',
), 'utf8'))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function tarEntry(name, content, type = '0', mode = 0o644) {
  const bytes = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(octal(mode, 8), 100, 8, 'ascii')
  header.write(octal(0, 8), 108, 8, 'ascii')
  header.write(octal(0, 8), 116, 8, 'ascii')
  header.write(octal(bytes.length, 12), 124, 12, 'ascii')
  header.write(octal(0, 12), 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ])
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (true) {
    const record = `${String(length)}${body}`
    const actualLength = Buffer.byteLength(record)
    if (actualLength === length) return record
    length = actualLength
  }
}

function mutateTarHeader(entry, mutate) {
  const mutated = Buffer.from(entry)
  const header = mutated.subarray(0, 512)
  mutate(header)
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return mutated
}

function karelTarball(overrides = {}, additionalEntries = []) {
  const manifest = structuredClone(currentKarelPackageManifest)
  const entries = EXPECTED_KAREL_PACKAGE_FILES.map((fileName) => {
    const defaultContent = fileName === 'package.json'
      ? `${JSON.stringify(manifest)}\n`
      : fileName.endsWith('.json') ? '{}\n' : 'reviewed fixture\n'
    return tarEntry(`package/${fileName}`, overrides[fileName] ?? defaultContent)
  })
  return tarball([...entries, ...additionalEntries])
}

async function validationInputFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'karel-validation-test-'))
  temporaryDirectories.push(directory)
  const sourceCommit = 'a'.repeat(40)
  const candidateSha256 = 'b'.repeat(64)
  const webIDECandidateSha256 = 'c'.repeat(64)
  const webIDESourceCommit = 'd'.repeat(40)
  const gates = []
  for (const [id, command] of EXPECTED_VALIDATION_GATES) {
    const logPath = path.join(directory, `${id}.source.log`)
    const webReceipt = {
      schemaVersion: 2,
      receiptKind: 'web-ide-release-validation-gate',
      mode: 'release-gate',
      package: 'web-ide@0.4.0',
      gateId: 'karel-compatibility',
      sourceCommit: webIDESourceCommit,
      candidateSha256: webIDECandidateSha256,
      command: 'Karel exact-candidate compatibility gate',
      exitCode: 0,
      emitter: 'karel:release-compatibility-gate@2',
    }
    const logText = id === 'packed-exact-pair'
      ? `${id} captured command output\n@@WEB_IDE_RELEASE_GATE_RECEIPT@@${canonicalJSONString(webReceipt)}`
      : `${id} captured command output\n`
    const bytes = Buffer.from(logText)
    await writeFile(logPath, bytes)
    const log = {
      fileName: `validation-${id}.log`,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
    }
    const spec = VALIDATION_GATE_SPECS.get(id)
    const receipt = {
      schemaVersion: 2,
      receiptKind: 'karel-release-validation-gate-capture',
      package: '@web-ide/karel@0.3.3',
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
      gate: {
        id,
        command,
        executable: spec.receiptExecutable,
        argv: spec.receiptArgv,
        exitCode: 0,
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: 10 * 1000,
      },
      environment: {
        policy: 'normalized-release-gate-v2',
        inheritedKeys: [],
      },
      log,
    }
    const receiptPath = path.join(directory, `${id}.source.receipt.json`)
    const receiptBytes = Buffer.from(canonicalJSONString(receipt))
    await writeFile(receiptPath, receiptBytes)
    gates.push({
      id,
      command,
      log: {
        path: logPath,
        ...log,
      },
      receipt: {
        path: receiptPath,
        fileName: `validation-${id}.receipt.json`,
        size: receiptBytes.length,
        sha256: sha256Bytes(receiptBytes),
      },
    })
  }
  return {
    candidateSha256,
    directory,
    input: {
      schemaVersion: 1,
      package: '@web-ide/karel@0.3.3',
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
      gates,
    },
    sourceCommit,
    webIDECandidateSha256,
    webIDESourceCommit,
  }
}

function tarball(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), {
    mtime: 0,
  })
}

function releaseConfiguration() {
  return {
    sourceRepository: 'https://github.com/justinvassantachart/web-ide-karel.git',
    sourceTag: 'web-ide-karel-v0.3.1-source',
    capabilityReleaseId: 'hamilton.python-karel/3',
    webIDE: {
      package: 'web-ide@0.3.0',
      peerRange: '>=0.3.0 <0.4.0',
      packageRole: 'web-ide',
      sourceTag: 'web-ide-v0.3.0-source',
      releaseRepository: 'justinvassantachart/ths-ide',
      releaseTag: 'web-ide-v0.3.0',
      releaseAssetFilename: 'web-ide-0.3.0.tgz',
      artifactManifestFilename: 'artifact-manifest.json',
      runtimeEvidenceFilename: 'runtime-assets-verification.json',
    },
  }
}

async function webEvidenceFixture({
  finalCandidate = false,
  finalManifest = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'karel-web-evidence-test-'))
  temporaryDirectories.push(directory)
  const packedManifest = {
    name: 'web-ide',
    version: '0.3.0',
    private: true,
    license: 'MIT',
  }
  const tarballBytes = tarball([
    tarEntry('package/package.json', `${JSON.stringify(packedManifest)}\n`),
    tarEntry('package/LICENSE.md', 'MIT fixture license\n'),
  ])
  const tarballPath = path.join(directory, 'web-ide-0.3.0.tgz')
  await writeFile(tarballPath, tarballBytes)
  const runtime = {
    schemaVersion: 1,
    package: 'web-ide',
    observedDate: '2026-08-24',
    digestRepresentation: 'identity-encoded-response-body',
    expectedRedirectCount: 0,
    requestTimeoutMs: 1000,
    scope: 'Synthetic release-evidence fixture.',
    limitations: ['Synthetic bytes only.'],
    result: 'pass',
    assets: Array.from({ length: finalManifest ? 27 : 1 }, (_, index) => {
      const suffix = String(index).padStart(2, '0')
      return {
        id: `fixture.${suffix}`,
        requestedUrl: `https://assets.example.test/runtime-${suffix}.wasm`,
        finalUrl: `https://assets.example.test/runtime-${suffix}.wasm`,
        redirectCount: 0,
        status: 200,
        contentType: 'application/wasm',
        headers: {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': null,
        },
        size: 1,
        sha256: index.toString(16).padStart(64, '0'),
      }
    }),
  }
  const runtimeBytes = Buffer.from(canonicalJSONString(runtime))
  await writeFile(path.join(directory, 'runtime-assets-verification.json'), runtimeBytes)
  const webArtifactFiles = [
    {
      path: 'LICENSE.md',
      size: Buffer.byteLength('MIT fixture license\n'),
      mode: 0o644,
      sha256: sha256Bytes(Buffer.from('MIT fixture license\n')),
    },
    {
      path: 'package.json',
      size: Buffer.byteLength(`${JSON.stringify(packedManifest)}\n`),
      mode: 0o644,
      sha256: sha256Bytes(Buffer.from(`${JSON.stringify(packedManifest)}\n`)),
    },
  ]
  const packageInspection = {
    schemaVersion: 1,
    package: 'web-ide@0.3.0',
    result: 'pass',
    tarball: {
      filename: 'web-ide-0.3.0.tgz',
      size: tarballBytes.length,
      sha256: sha256Bytes(tarballBytes),
      sha512Integrity: sha512IntegrityBytes(tarballBytes),
    },
    checks: {
      npmPackJsonMatched: true,
      regularFilesOnly: true,
      pathsSafeAndCaseUnique: true,
      privatePackage: true,
      exportsResolved: true,
      licenseFilesPresent: true,
      internalPathAndSecretScanPassed: true,
      bundledDependenciesAbsent: true,
    },
    files: webArtifactFiles,
  }
  const packageInspectionBytes = Buffer.from(canonicalJSONString(packageInspection))
  await writeFile(
    path.join(directory, 'package-inspection.json'),
    packageInspectionBytes,
  )
  const runtimeManifestAssets = runtime.assets.map((asset) => ({
    id: asset.id,
    version: 'fixture',
    requestedUrl: asset.requestedUrl,
    finalUrl: asset.finalUrl,
    size: asset.size,
    sha256: asset.sha256,
    contentType: asset.contentType,
    headers: asset.headers,
    license: 'MIT',
  }))
  const evidenceKinds = [
    'bundle-provenance',
    'candidate-state',
    'cyclonedx-sbom',
    'deterministic-builds',
    'license-inventory',
    'package-inspection',
    'runtime-assets',
    'runtime-source-provenance',
    'third-party-license-text',
    'validation-log:audit-full:0',
    'validation-log:audit-production:0',
    'validation-log:consumer-exact-candidate:0',
    'validation-log:karel-compatibility:0',
    'validation-log:validate-production:0',
    'validation-summary',
  ]
  const manifestDraft = {
    schemaVersion: 2,
    manifestKind: 'hamilton-capability-package-artifact',
    capabilityReleaseIds: [
      'hamilton.python-karel/2',
      'hamilton.python/1',
    ],
    packageRole: 'web-ide',
    ...(!finalManifest && { nonFinalTestFixture: true }),
    package: {
      name: 'web-ide',
      version: '0.3.0',
      private: true,
      license: 'MIT',
      engines: { node: '^20.19.0 || >=22.12.0' },
      dependencies: { 'debugger-sh': '0.3.15' },
      peerDependencies: {
        react: '^18.3.0 || ^19.0.0',
        'react-dom': '^18.3.0 || ^19.0.0',
      },
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './plugins': { types: './dist/plugins.d.ts', import: './dist/plugins.js' },
        './host': { types: './dist/host.d.ts', import: './dist/host.js' },
        './runtimes': { types: './dist/runtimes.d.ts', import: './dist/runtimes.js' },
        './testing': { types: './dist/testing.d.ts', import: './dist/testing.js' },
        './language-tools': {
          types: './dist/language-tools.d.ts',
          import: './dist/language-tools.js',
        },
        './styles.css': './dist/styles.css',
        './package.json': './package.json',
      },
    },
    source: {
      repository: 'https://github.com/justinvassantachart/web-ide.git',
      branch: 'main',
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      commitTimestamp: 1_787_529_600,
      sourceDateEpoch: '1787529600',
      tag: {
        name: 'web-ide-v0.3.0-source',
        objectId: 'd'.repeat(40),
        objectType: 'tag',
        peeledCommit: 'b'.repeat(40),
      },
      inputs: {
        packageJson: {
          kind: 'source-input',
          fileName: 'package.json',
          size: 1,
          sha256: 'e'.repeat(64),
        },
        packageLock: {
          kind: 'source-input',
          fileName: 'package-lock.json',
          size: 1,
          sha256: 'e'.repeat(64),
        },
      },
      archive: {
        kind: 'source-archive',
        fileName: 'web-ide-0.3.0-source.tar.gz',
        size: 1,
        sha256: 'e'.repeat(64),
      },
    },
    toolchain: {
      node: '24.11.1',
      npm: '11.6.2',
      osType: 'Darwin',
      osRelease: 'fixture',
      platform: 'darwin',
      arch: 'arm64',
    },
    buildInputs: {
      argv: {
        install: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        build: ['npm', 'run', 'build:library'],
        licenseEvidence: [
          'node',
          'scripts/release/generate-isolated-license-evidence.mjs',
        ],
        pack: [
          'npm',
          'pack',
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          '../pack',
        ],
      },
      environment: {
        inherited: [],
        PATH: '<isolated-bin>',
        HOME: '<isolated-home>',
        TMPDIR: '<isolated-tmp>',
        TZ: 'UTC',
        LANG: 'C',
        LC_ALL: 'C',
        CI: 'true',
        NO_UPDATE_NOTIFIER: '1',
        SOURCE_DATE_EPOCH: '1787529600',
        npm_config_cache: '<isolated-cache>',
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_globalconfig: '<isolated-build>/global.npmrc',
        npm_config_strict_ssl: 'true',
        npm_config_package_lock: 'true',
        npm_config_offline: 'false',
        npm_config_prefer_offline: 'false',
        npm_config_prefer_online: 'false',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_userconfig: '<isolated-build>/user.npmrc',
        WEB_IDE_RELEASE_PROVENANCE_PATH: '<isolated-provenance>',
        WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR: '<isolated-license-output>',
      },
      pathNormalization: 'All paths use reviewed placeholders.',
    },
    distribution: {
      mechanism: 'private-github-release-asset',
      npmPublished: false,
      repository: 'justinvassantachart/ths-ide',
      intendedTag: 'web-ide-v0.3.0',
      intendedAssetFilename: 'web-ide-0.3.0.tgz',
      artifact: {
        kind: 'package-tarball',
        fileName: 'web-ide-0.3.0.tgz',
        size: tarballBytes.length,
        sha256: sha256Bytes(tarballBytes),
        sha512Integrity: sha512IntegrityBytes(tarballBytes),
        files: webArtifactFiles,
      },
    },
    runtime: {
      observedDate: runtime.observedDate,
      digestRepresentation: runtime.digestRepresentation,
      expectedRedirectCount: 0,
      requestTimeoutMs: runtime.requestTimeoutMs,
      scope: runtime.scope,
      limitations: runtime.limitations,
      assets: runtimeManifestAssets,
      debuggerSh: {
        registry: {
          name: 'debugger-sh',
          version: '0.3.15',
          resolved: 'https://registry.npmjs.org/debugger-sh/-/debugger-sh-0.3.15.tgz',
          integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
        },
        source: {
          repository: 'https://github.com/akheron/debugger.sh',
          tag: 'v0.3.15',
          commit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
        },
        distribution: {
          path: 'dist/engine_bg.wasm',
          size: 1,
          sha256: 'f'.repeat(64),
        },
      },
    },
    validation: {
      candidateSha256: sha256Bytes(tarballBytes),
      gateCount: 5,
      logCount: 5,
    },
    evidence: evidenceKinds.map((kind) => (
      kind === 'runtime-assets'
        ? {
            kind,
            fileName: 'runtime-assets-verification.json',
            size: runtimeBytes.length,
            sha256: sha256Bytes(runtimeBytes),
          }
        : {
            kind,
            fileName: `${kind.replaceAll(':', '-')}.json`,
            size: 1,
            sha256: 'e'.repeat(64),
          }
    )),
  }
  const manifest = {
    ...manifestDraft,
    manifestId: `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(manifestDraft),
    ))}`,
  }
  const manifestBytes = Buffer.from(canonicalJSONString(manifest))
  const manifestPath = path.join(directory, 'artifact-manifest.json')
  await writeFile(manifestPath, manifestBytes)
  await writeFile(
    path.join(directory, 'artifact-manifest.json.sha256'),
    `${sha256Bytes(manifestBytes)}  artifact-manifest.json\n`,
  )
  const artifactNames = [
    'THIRD_PARTY_LICENSES.txt',
    'bundle-provenance.json',
    'deterministic-builds.json',
    'package-inspection.json',
    'runtime-assets-verification.json',
    'runtime-source-provenance.json',
    'third-party-licenses.json',
    'web-ide-0.3.0-source.tar.gz',
    'web-ide-0.3.0.cdx.json',
    'web-ide-0.3.0.tgz',
  ]
  const candidateState = {
    schemaVersion: 1,
    package: 'web-ide@0.3.0',
    result: finalCandidate ? 'candidate-generated' : 'nonrelease-preflight',
    ...(finalCandidate ? {} : {
      preflightFixture: {
        mode: 'disposable-local-remote',
        remote: '/tmp/synthetic-web-ide-release-preflight.git',
        finalizable: false,
      },
    }),
    source: {
      branch: 'main',
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      tag: {
        name: 'web-ide-v0.3.0-source',
        objectId: 'd'.repeat(40),
        objectType: 'tag',
        peeledCommit: 'b'.repeat(40),
      },
      remote: finalCandidate
        ? 'https://github.com/justinvassantachart/web-ide.git'
        : '/tmp/synthetic-web-ide-release-preflight.git',
      commitTimestamp: 1_787_529_600,
      sourceDateEpoch: '1787529600',
      nodeVersion: '24.11.1',
      npmVersion: '11.6.2',
    },
    capabilityReleaseId: 'hamilton.python-karel/2',
    packageRole: 'web-ide',
    artifacts: artifactNames.map((fileName) => {
      if (fileName === 'web-ide-0.3.0.tgz') {
        return {
          fileName,
          size: tarballBytes.length,
          sha256: sha256Bytes(tarballBytes),
        }
      }
      if (fileName === 'runtime-assets-verification.json') {
        return {
          fileName,
          size: runtimeBytes.length,
          sha256: sha256Bytes(runtimeBytes),
        }
      }
      if (fileName === 'package-inspection.json') {
        return {
          fileName,
          size: packageInspectionBytes.length,
          sha256: sha256Bytes(packageInspectionBytes),
        }
      }
      return { fileName, size: 1, sha256: 'e'.repeat(64) }
    }),
  }
  const candidateStatePath = path.join(directory, 'candidate-state.json')
  await writeFile(candidateStatePath, canonicalJSONString(candidateState))
  const consumerLock = JSON.parse(await readFile(path.join(
    repositoryRoot,
    'release/web-ide-0.3.1-compatibility.package-lock.json',
  ), 'utf8'))
  consumerLock.packages['node_modules/@web-ide/karel'].version = '0.3.1'
  consumerLock.packages['node_modules/web-ide'].version = '0.3.0'
  consumerLock.packages['node_modules/web-ide'].integrity
    = sha512IntegrityBytes(tarballBytes)
  return {
    directory,
    manifestPath,
    candidateStatePath,
    tarballPath,
    tarballBytes,
    consumerLock,
  }
}

describe('canonical JSON', () => {
  it('sorts every object and rejects non-JSON values', () => {
    expect(canonicalJSONString({ z: 1, a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":1}\n')
    expect(() => canonicalJSONString({ value: undefined })).toThrow(/undefined/u)
    expect(() => canonicalJSONString({ value: Number.NaN })).toThrow(/finite/u)
    const sparse = []
    sparse[1] = true
    expect(() => canonicalJSONString(sparse)).toThrow(/sparse/u)
  })

  it('isolates npm config, credentials, home, temp, and cache', () => {
    const environment = isolatedNpmEnvironment({
      PATH: '/fixture/bin',
      KEEP_ME: 'yes',
      NPM_CONFIG_REGISTRY: 'https://untrusted.example.test',
      npm_token: 'not-a-real-token',
      NODE_AUTH_TOKEN: 'not-a-real-token',
      NODE_OPTIONS: '--require untrusted.js',
    }, '/tmp/cache', 123, {
      homeRoot: '/tmp/home',
      temporaryRoot: '/tmp/temp',
      userConfigPath: '/tmp/user-npmrc',
      globalConfigPath: '/tmp/global-npmrc',
    })
    expect(environment).toMatchObject({
      PATH: '/fixture/bin',
      HOME: '/tmp/home',
      TMPDIR: '/tmp/temp',
      SOURCE_DATE_EPOCH: '123',
      npm_config_cache: '/tmp/cache',
      npm_config_userconfig: '/tmp/user-npmrc',
      npm_config_globalconfig: '/tmp/global-npmrc',
    })
    expect(environment).not.toHaveProperty('NPM_CONFIG_REGISTRY')
    expect(environment).not.toHaveProperty('KEEP_ME')
    expect(environment).not.toHaveProperty('npm_token')
    expect(environment).not.toHaveProperty('NODE_AUTH_TOKEN')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })

  it('isolates Git config, object replacement, home, and executable path', () => {
    const environment = hermeticGitEnvironment({
      GIT_DIR: '/untrusted/repository',
      GIT_CONFIG_GLOBAL: '/untrusted/config',
      GIT_OBJECT_DIRECTORY: '/untrusted/objects',
      HOME: '/untrusted/home',
      HTTPS_PROXY: 'https://proxy.example.test',
      PATH: '/untrusted/bin',
    })
    expect(environment).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HTTPS_PROXY: 'https://proxy.example.test',
    })
    expect(environment).not.toHaveProperty('GIT_DIR')
    expect(environment).not.toHaveProperty('GIT_OBJECT_DIRECTORY')
    expect(environment.HOME).not.toBe('/untrusted/home')
  })

  it('publishes output atomically and removes staging after a late failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-atomic-output-test-'))
    temporaryDirectories.push(directory)
    const target = path.join(directory, 'final-output')
    await expect(withAtomicOutputDirectory(target, async (stage) => {
      await writeFile(path.join(stage, 'partial.txt'), 'partial\n')
      throw new Error('late fixture failure')
    })).rejects.toThrow(/late fixture failure/u)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(directory)).filter((name) => name.includes('.staging-')))
      .toEqual([])
    const published = await withAtomicOutputDirectory(target, async (stage) => {
      await writeFile(path.join(stage, 'complete.txt'), 'complete\n')
      return 'complete'
    })
    expect(published.result).toBe('complete')
    expect(await readFile(path.join(target, 'complete.txt'), 'utf8'))
      .toBe('complete\n')
    await expect(withAtomicOutputDirectory(target, async () => {}))
      .rejects.toThrow(/must not already exist/u)

    const racedTarget = path.join(directory, 'raced-output')
    await expect(withAtomicOutputDirectory(racedTarget, async (stage) => {
      await writeFile(path.join(stage, 'staged.txt'), 'staged\n')
      await mkdir(racedTarget)
      await writeFile(path.join(racedTarget, 'owner.txt'), 'external owner\n')
    })).rejects.toThrow(/appeared while evidence was staged/u)
    expect(await readFile(path.join(racedTarget, 'owner.txt'), 'utf8'))
      .toBe('external owner\n')
  })

  it('waits for every isolated build to settle before reporting a sibling failure', async () => {
    let slowerBuildSettled = false
    const slowerBuild = new Promise((resolve) => {
      setImmediate(() => {
        slowerBuildSettled = true
        resolve('complete')
      })
    })
    await expect(settleAllBuilds([
      Promise.reject(new Error('first build failed')),
      slowerBuild,
    ])).rejects.toBeInstanceOf(AggregateError)
    expect(slowerBuildSettled).toBe(true)
  })

  it('rejects oversized external bytes before accepting them into memory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-bounded-file-test-'))
    temporaryDirectories.push(directory)
    const input = path.join(directory, 'oversized.bin')
    await writeFile(input, Buffer.alloc(10))
    await expect(readBoundedFile(input, 9, 'Synthetic input'))
      .rejects.toThrow(/file size limit/u)
  })
})

describe('safe package tar reading', () => {
  it('extracts regular files in memory without writing them', () => {
    const entries = readPackageTarball(tarball([
      tarEntry('package/package.json', '{}'),
    ]))
    expect(entries).toMatchObject([{
      path: 'package.json',
      type: 'file',
      size: 2,
    }])
  })

  it('rejects traversal, links, duplicates, and case collisions', () => {
    expect(() => readPackageTarball(tarball([
      tarEntry('package/../escape', 'x'),
    ]))).toThrow(/outside package/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/link', '', '2'),
    ]))).toThrow(/Forbidden tar entry/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/same.js', 'a'),
      tarEntry('package/same.js', 'b'),
    ]))).toThrow(/Duplicate/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/A.js', 'a'),
      tarEntry('package/a.js', 'b'),
    ]))).toThrow(/Case-colliding/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/\u0085hidden-control.js', 'a'),
    ]))).toThrow(/Unsafe tar path/u)
  })

  it('fails closed on compressed, expanded, entry, path, PAX, and mode limits', () => {
    const one = tarball([tarEntry('package/file.js', '1234567890')])
    expect(() => readPackageTarball(one, {
      compressedBytes: one.length - 1,
    })).toThrow(/Compressed package/u)
    expect(() => readPackageTarball(one, { entryBytes: 5 }))
      .toThrow(/per-entry/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/a.js', 'a'),
      tarEntry('package/b.js', 'b'),
    ]), { entries: 1 })).toThrow(/too many entries/u)
    expect(() => readPackageTarball(tarball([
      tarEntry(`package/${'a'.repeat(90)}.js`, 'a'),
    ]), { pathBytes: 20 })).toThrow(/length limit/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/pax', 'unparsed pax metadata', 'x'),
    ]), { paxBytes: 1 })).toThrow(/PAX metadata exceeds/u)
    expect(() => readPackageTarball(tarball([
      tarEntry('package/setuid.js', 'a', '0', 0o4644),
    ]))).toThrow(/special mode bits/u)
  })

  it('rejects global, unused, and sensitive PAX metadata', () => {
    expect(() => readPackageTarball(tarball([
      tarEntry(
        'package/global-pax',
        paxRecord('path', 'package/file.js'),
        'g',
      ),
    ]))).toThrow(/Global PAX metadata is forbidden/u)

    expect(() => readPackageTarball(tarball([
      tarEntry('package/empty-pax', '', 'x'),
      tarEntry('package/file.js', 'fixture'),
    ]))).toThrow(/PAX metadata is empty/u)

    expect(() => readPackageTarball(tarball([
      tarEntry(
        'package/first-pax',
        paxRecord('path', 'package/first.js'),
        'x',
      ),
      tarEntry(
        'package/second-pax',
        paxRecord('path', 'package/second.js'),
        'x',
      ),
      tarEntry('package/file.js', 'fixture'),
    ]))).toThrow(/unused PAX metadata/u)

    expect(() => readPackageTarball(tarball([
      tarEntry(
        'package/path-pax',
        paxRecord(
          'path',
          'package/github_pat_abcdefghijklmnopqrstuvwxyz123456/file.js',
        ),
        'x',
      ),
      tarEntry('package/file.js', 'fixture'),
    ]))).toThrow(/Tar metadata .*GitHub fine-grained token/u)

    expect(() => readPackageTarball(tarball([
      tarEntry(
        'package/\u0080hidden-pax-header',
        paxRecord('path', 'package/file.js'),
        'x',
      ),
      tarEntry('package/file.js', 'fixture'),
    ]))).toThrow(/Unsafe tar path/u)

    expect(() => readPackageTarball(tarball([
      tarEntry(
        'package/path-pax',
        paxRecord('path', 'package/safe.js'),
        'x',
      ),
      tarEntry('package/\u009fhidden-regular-header.js', 'fixture'),
    ]))).toThrow(/Unsafe tar path/u)
  })

  it('rejects hidden header metadata and nonzero entry padding', () => {
    const hiddenAfterName = mutateTarHeader(
      tarEntry('package/file.js', 'fixture'),
      (header) => {
        header['package/file.js'.length + 1] = 0x78
      },
    )
    expect(() => readPackageTarball(tarball([hiddenAfterName])))
      .toThrow(/name .*nonzero bytes after its terminator/u)

    const sensitiveUserName = mutateTarHeader(
      tarEntry('package/file.js', 'fixture'),
      (header) => {
        header.write(
          'github_pat_abcdefghijklmnopqrstuvwxyz123456',
          265,
          32,
          'ascii',
        )
      },
    )
    expect(() => readPackageTarball(tarball([sensitiveUserName])))
      .toThrow(/Tar metadata .*GitHub fine-grained token/u)

    const nonzeroReservedHeader = mutateTarHeader(
      tarEntry('package/file.js', 'fixture'),
      (header) => {
        header[500] = 1
      },
    )
    expect(() => readPackageTarball(tarball([nonzeroReservedHeader])))
      .toThrow(/reserved header bytes/u)

    const nonzeroPadding = Buffer.from(tarEntry('package/file.js', 'x'))
    nonzeroPadding[513] = 1
    expect(() => readPackageTarball(tarball([nonzeroPadding])))
      .toThrow(/nonzero padding/u)
  })

  it('enforces one exact textual inventory and scans every permitted file', () => {
    expect(inspectExistingPackedPackage(karelTarball()).report.files)
      .toHaveLength(EXPECTED_KAREL_PACKAGE_FILES.length)
    expect(() => inspectExistingPackedPackage(karelTarball({}, [
      tarEntry('package/dist/index.js.map', '{}\n'),
    ]))).toThrow(/exact Karel allowlist/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': `${'github'}_${'pat'}_abcdefghijklmnopqrstuvwxyz123456\n`,
    }))).toThrow(/GitHub fine-grained token/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': 'Authorization: Basic Zml4dHVyZWNyZWRlbnRpYWw=\n',
    }))).toThrow(/Basic authorization credential/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': 'Authorization: Basic YTpi\n',
    }))).toThrow(/Basic authorization credential/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': '{"Authorization":"Basic Zm9vOmJhcg=="}\n',
    }))).toThrow(/Basic authorization credential/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': 'github_token=syntheticcredential123\n',
    }))).toThrow(/credential assignment/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': 'DATABASE_PASSWORD=syntheticcredential123\n',
    }))).toThrow(/credential assignment/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': 'VITE_API_KEY=syntheticcredential123\n',
    }))).toThrow(/credential assignment/u)
    expect(() => inspectExistingPackedPackage(karelTarball({
      'README.md': Buffer.from([0xff, 0xfe]),
    }))).toThrow()

    const engineDrift = structuredClone(currentKarelPackageManifest)
    engineDrift.engines.node = '*'
    expect(() => inspectExistingPackedPackage(karelTarball({
      'package.json': `${JSON.stringify(engineDrift)}\n`,
    }))).toThrow(/engine policy/u)

    const lifecycleHook = structuredClone(currentKarelPackageManifest)
    lifecycleHook.scripts.install = 'node unreviewed-install.js'
    expect(() => inspectExistingPackedPackage(karelTarball({
      'package.json': `${JSON.stringify(lifecycleHook)}\n`,
    }))).toThrow(/forbidden lifecycle script/u)
  })
})

describe('exact Web IDE evidence', () => {
  it('requires the exact numeric zero-redirect runtime report contract', () => {
    const report = {
      schemaVersion: 1,
      package: 'web-ide',
      observedDate: '2026-08-24',
      digestRepresentation: 'identity-encoded-response-body',
      expectedRedirectCount: 0,
      requestTimeoutMs: 1000,
      scope: 'Synthetic contract fixture.',
      limitations: ['Synthetic bytes only.'],
      result: 'pass',
      assets: [{
        id: 'fixture.asset',
        requestedUrl: 'https://assets.example.test/runtime.wasm',
        finalUrl: 'https://assets.example.test/runtime.wasm',
        redirectCount: 0,
        status: 200,
        contentType: 'application/wasm',
        headers: {
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': null,
        },
        size: 1,
        sha256: 'a'.repeat(64),
      }],
    }
    expect(validateWebIDERuntimeReport(report)).toBe(report)

    const legacy = structuredClone(report)
    legacy.assets[0].redirected = false
    delete legacy.assets[0].redirectCount
    expect(() => validateWebIDERuntimeReport(legacy)).toThrow()

    const nonzero = structuredClone(report)
    nonzero.assets[0].redirectCount = 1
    expect(() => validateWebIDERuntimeReport(nonzero)).toThrow(/response identity/u)

    const missingPolicy = structuredClone(report)
    delete missingPolicy.expectedRedirectCount
    expect(() => validateWebIDERuntimeReport(missingPolicy)).toThrow()
  })

  it('emits the exact Web finalizer compatibility receipt from canonical candidate bytes', async () => {
    const fixture = await webEvidenceFixture({ finalCandidate: true })
    const receipt = await webIDECompatibilityReceipt({
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
    })
    expect(receipt).toEqual({
      schemaVersion: 2,
      receiptKind: 'web-ide-release-validation-gate',
      mode: 'release-gate',
      package: 'web-ide@0.3.0',
      gateId: 'karel-compatibility',
      sourceCommit: 'b'.repeat(40),
      candidateSha256: sha256Bytes(fixture.tarballBytes),
      command: 'Karel exact-candidate compatibility gate',
      exitCode: 0,
      emitter: 'karel:release-compatibility-gate@2',
    })
    const line = formatWebIDECompatibilityReceipt(receipt)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split(WEB_IDE_GATE_RECEIPT_PREFIX)).toHaveLength(2)
    expect(JSON.parse(line.slice(WEB_IDE_GATE_RECEIPT_PREFIX.length)))
      .toEqual(receipt)
    await writeFile(fixture.tarballPath, 'changed\n')
    await expect(webIDECompatibilityReceipt({
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
    })).rejects.toThrow(/does not match/u)
  })

  it('rejects a nonrelease Web preflight before emitting a production receipt', async () => {
    const fixture = await webEvidenceFixture()
    await expect(webIDECompatibilityReceipt({
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
    })).rejects.toThrow(/candidate-generated final state/u)
  })

  it('emits the Web receipt only after binding the exact final Karel candidate', async () => {
    const webFixture = await webEvidenceFixture({ finalCandidate: true })
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-pair-receipt-test-'))
    temporaryDirectories.push(directory)
    const karelBytes = karelTarball()
    const karelTarballPath = path.join(directory, 'web-ide-karel-0.3.1.tgz')
    await writeFile(karelTarballPath, karelBytes)
    const source = {
      branch: 'main',
      commit: 'e'.repeat(40),
      tree: 'f'.repeat(40),
      remote: 'https://github.com/justinvassantachart/web-ide-karel.git',
      nodeVersion: '24.11.1',
      npmVersion: '11.6.2',
      sourceEpoch: 1,
      finalEligible: true,
      sourceReference: 'web-ide-karel-v0.3.1-source',
      tag: {
        name: 'web-ide-karel-v0.3.1-source',
        objectId: '0'.repeat(40),
        objectType: 'tag',
        peeledCommit: 'e'.repeat(40),
      },
      worktreeClean: true,
    }
    const state = {
      schemaVersion: 1,
      package: '@web-ide/karel@0.3.1',
      result: 'candidate-generated',
      mode: 'final',
      source,
      capabilityReleaseId: 'hamilton.python-karel/3',
      packageRole: 'karel',
      sourceFiles: {
        packageManifest: {},
        packageLock: {},
        consumerManifest: {},
        consumerLock: {},
      },
      webIDECandidate: {},
      consumerLockBindings: { webIDE: 'exact', karel: 'exact' },
      artifacts: HISTORICAL_0_3_1_ARTIFACT_FILES.map((fileName) => ({
        fileName,
        size: fileName === 'web-ide-karel-0.3.1.tgz'
          ? karelBytes.length
          : 1,
        sha256: fileName === 'web-ide-karel-0.3.1.tgz'
          ? sha256Bytes(karelBytes)
          : 'a'.repeat(64),
      })),
    }
    const karelStatePath = path.join(directory, 'candidate-state.json')
    await writeFile(karelStatePath, canonicalJSONString(state))
    const evidence = await exactPairCompatibilityEvidence({
      webIDECandidateStatePath: webFixture.candidateStatePath,
      webIDETarballPath: webFixture.tarballPath,
      karelCandidateStatePath: karelStatePath,
      karelTarballPath,
    })
    expect(evidence.karel).toEqual({
      candidateSha256: sha256Bytes(karelBytes),
      sourceCommit: source.commit,
    })
    await writeFile(karelTarballPath, 'changed\n')
    await expect(exactPairCompatibilityEvidence({
      webIDECandidateStatePath: webFixture.candidateStatePath,
      webIDETarballPath: webFixture.tarballPath,
      karelCandidateStatePath: karelStatePath,
      karelTarballPath,
    })).rejects.toThrow(/does not match candidate state/u)

    await writeFile(karelTarballPath, karelBytes)
    const preflightState = JSON.parse(await readFile(
      webFixture.candidateStatePath,
      'utf8',
    ))
    preflightState.result = 'nonrelease-preflight'
    preflightState.preflightFixture = {
      mode: 'disposable-local-remote',
      remote: '/tmp/synthetic-web-ide-release-preflight.git',
      finalizable: false,
    }
    preflightState.source.remote
      = '/tmp/synthetic-web-ide-release-preflight.git'
    await writeFile(
      webFixture.candidateStatePath,
      canonicalJSONString(preflightState),
    )
    await expect(exactPairCompatibilityEvidence({
      webIDECandidateStatePath: webFixture.candidateStatePath,
      webIDETarballPath: webFixture.tarballPath,
      karelCandidateStatePath: karelStatePath,
      karelTarballPath,
    })).rejects.toThrow(/candidate-generated final state/u)
  })

  it('binds canonical pre-manifest candidate state, tarball SRI, runtime report, and consumer lock', async () => {
    const fixture = await webEvidenceFixture()
    const evidence = await verifyWebIDECandidateEvidence({
      configuration: releaseConfiguration(),
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })
    expect(evidence.report).toMatchObject({
      result: 'pass',
      packageRole: 'web-ide-peer-candidate',
      candidateState: { result: 'nonrelease-preflight' },
      runtimeEvidence: { ownerPackageRole: 'web-ide', verifiedAssetCount: 1 },
      consumerLock: { binding: 'exact' },
      nonFinalTestFixture: true,
    })
    await writeFile(path.join(fixture.directory, 'package-inspection.json'), '{}\n')
    await expect(verifyWebIDECandidateEvidence({
      configuration: releaseConfiguration(),
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })).rejects.toThrow(/does not match candidate state/u)
  })

  it('binds the active Web IDE 0.4.0 and Karel 0.3.3 candidate pair', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-active-pair-test-'))
    temporaryDirectories.push(directory)
    const webDirectory = path.join(directory, 'web')
    const karelDirectory = path.join(directory, 'karel')
    await Promise.all([mkdir(webDirectory), mkdir(karelDirectory)])
    const webBytes = Buffer.from('synthetic Web IDE 0.4.0 candidate bytes\n')
    const webTarballPath = path.join(webDirectory, 'web-ide-0.4.0.tgz')
    await writeFile(webTarballPath, webBytes)
    const webSource = {
      branch: 'main',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      tag: {
        name: 'web-ide-v0.4.0-source-r3',
        objectId: '3'.repeat(40),
        objectType: 'tag',
        peeledCommit: '1'.repeat(40),
      },
      remote: 'https://github.com/justinvassantachart/web-ide.git',
      commitTimestamp: 1,
      sourceDateEpoch: '1',
      nodeVersion: '24.11.1',
      npmVersion: '11.6.2',
    }
    const webArtifacts = [
      'THIRD_PARTY_LICENSES.txt',
      'bundle-provenance.json',
      'deterministic-builds.json',
      'package-inspection.json',
      'runtime-assets-verification.json',
      'runtime-source-provenance.json',
      'third-party-licenses.json',
      'web-ide-0.4.0-source.tar.gz',
      'web-ide-0.4.0.cdx.json',
      'web-ide-0.4.0.tgz',
    ]
    const canonicalWebStatePath = path.join(webDirectory, 'candidate-state.json')
    await writeFile(canonicalWebStatePath, canonicalJSONString({
      schemaVersion: 1,
      package: 'web-ide@0.4.0',
      result: 'candidate-generated',
      source: webSource,
      capabilityReleaseId: 'hamilton.python/4',
      packageRole: 'web-ide',
      artifacts: webArtifacts.map((fileName) => ({
        fileName,
        size: fileName === 'web-ide-0.4.0.tgz' ? webBytes.length : 1,
        sha256: fileName === 'web-ide-0.4.0.tgz'
          ? sha256Bytes(webBytes)
          : '4'.repeat(64),
      })),
    }))
    const karelBytes = karelTarball()
    const karelTarballPath = path.join(karelDirectory, 'web-ide-karel-0.3.3.tgz')
    await writeFile(karelTarballPath, karelBytes)
    const karelSource = {
      branch: 'main',
      commit: '5'.repeat(40),
      tree: '6'.repeat(40),
      remote: 'https://github.com/justinvassantachart/web-ide-karel.git',
      nodeVersion: '24.11.1',
      npmVersion: '11.6.2',
      sourceEpoch: 1,
      finalEligible: true,
      sourceReference: 'web-ide-karel-v0.3.3-source-r3',
      tag: {
        name: 'web-ide-karel-v0.3.3-source-r3',
        objectId: '7'.repeat(40),
        objectType: 'tag',
        peeledCommit: '5'.repeat(40),
      },
      worktreeClean: true,
    }
    const canonicalKarelStatePath = path.join(karelDirectory, 'candidate-state.json')
    await writeFile(canonicalKarelStatePath, canonicalJSONString({
      schemaVersion: 1,
      package: '@web-ide/karel@0.3.3',
      result: 'candidate-generated',
      mode: 'final',
      source: karelSource,
      capabilityReleaseId: 'hamilton.python-karel/8',
      packageRole: 'karel',
      sourceFiles: {
        packageManifest: {},
        packageLock: {},
        consumerManifest: {},
        consumerLock: {},
      },
      webIDECandidate: {},
      consumerLockBindings: { webIDE: 'exact', karel: 'exact' },
      artifacts: CANDIDATE_ARTIFACT_FILES.map((fileName) => ({
        fileName,
        size: fileName === 'web-ide-karel-0.3.3.tgz'
          ? karelBytes.length
          : 1,
        sha256: fileName === 'web-ide-karel-0.3.3.tgz'
          ? sha256Bytes(karelBytes)
          : '8'.repeat(64),
      })),
    }))
    const evidence = await exactActivePairCompatibilityEvidence({
      webIDECandidateStatePath: canonicalWebStatePath,
      webIDETarballPath: webTarballPath,
      karelCandidateStatePath: canonicalKarelStatePath,
      karelTarballPath,
    })
    expect(evidence).toMatchObject({
      receipt: { package: 'web-ide@0.4.0' },
      webIDE: {
        receipt: { candidateSha256: sha256Bytes(webBytes) },
      },
      karel: {
        candidateSha256: sha256Bytes(karelBytes),
        sourceCommit: karelSource.commit,
      },
    })
  })

  it('binds one canonical manifest, tarball, runtime report, and consumer lock', async () => {
    const fixture = await webEvidenceFixture()
    const evidence = await verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })
    expect(evidence.report).toMatchObject({
      result: 'pass',
      packageRole: 'web-ide-peer',
      runtimeEvidence: {
        ownerPackageRole: 'web-ide',
        verifiedAssetCount: 1,
      },
      consumerLock: { binding: 'exact' },
      nonFinalTestFixture: true,
    })
  })

  it('rejects the abandoned Web source tag in candidate and final evidence', async () => {
    const candidateFixture = await webEvidenceFixture()
    const candidateState = JSON.parse(await readFile(
      candidateFixture.candidateStatePath,
      'utf8',
    ))
    candidateState.source.tag.name = 'web-ide-karel-v0.3.1-source'
    await writeFile(
      candidateFixture.candidateStatePath,
      canonicalJSONString(candidateState),
    )
    await expect(verifyWebIDECandidateEvidence({
      configuration: releaseConfiguration(),
      candidateStatePath: candidateFixture.candidateStatePath,
      tarballPath: candidateFixture.tarballPath,
      consumerLock: candidateFixture.consumerLock,
      mode: 'test',
    })).rejects.toThrow(/exact annotated tag/u)

    const finalFixture = await webEvidenceFixture({ finalManifest: true })
    const manifest = JSON.parse(await readFile(finalFixture.manifestPath, 'utf8'))
    manifest.source.tag.name = 'web-ide-karel-v0.3.1-source'
    const manifestInput = structuredClone(manifest)
    delete manifestInput.manifestId
    manifest.manifestId = `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(manifestInput),
    ))}`
    const manifestBytes = Buffer.from(canonicalJSONString(manifest))
    await writeFile(finalFixture.manifestPath, manifestBytes)
    await writeFile(
      path.join(finalFixture.directory, 'artifact-manifest.json.sha256'),
      `${sha256Bytes(manifestBytes)}  artifact-manifest.json\n`,
    )
    await expect(verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: finalFixture.manifestPath,
      tarballPath: finalFixture.tarballPath,
      consumerLock: finalFixture.consumerLock,
      mode: 'final',
    })).rejects.toThrow(/annotated tag/u)
  })

  it('rejects runtime report assets not present in the exact Web manifest set', async () => {
    const fixture = await webEvidenceFixture()
    const runtimePath = path.join(
      fixture.directory,
      'runtime-assets-verification.json',
    )
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'))
    runtime.assets.push({
      ...runtime.assets[0],
      id: 'fixture.zz',
      requestedUrl: 'https://assets.example.test/runtime-zz.wasm',
      finalUrl: 'https://assets.example.test/runtime-zz.wasm',
      sha256: 'f'.repeat(64),
    })
    const runtimeBytes = Buffer.from(canonicalJSONString(runtime))
    await writeFile(runtimePath, runtimeBytes)
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'))
    const runtimeEvidence = manifest.evidence.find(
      (evidence) => evidence.kind === 'runtime-assets',
    )
    runtimeEvidence.size = runtimeBytes.length
    runtimeEvidence.sha256 = sha256Bytes(runtimeBytes)
    const identity = structuredClone(manifest)
    delete identity.manifestId
    manifest.manifestId = `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(identity),
    ))}`
    const manifestBytes = Buffer.from(canonicalJSONString(manifest))
    await writeFile(fixture.manifestPath, manifestBytes)
    await writeFile(
      path.join(fixture.directory, 'artifact-manifest.json.sha256'),
      `${sha256Bytes(manifestBytes)}  artifact-manifest.json\n`,
    )
    await expect(verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })).rejects.toThrow(/asset set differs/u)
  })

  it('accepts the exact final Web schema and rejects an unknown field', async () => {
    const fixture = await webEvidenceFixture({ finalManifest: true })
    const evidence = await verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'final',
    })
    expect(evidence.report.nonFinalTestFixture).toBe(false)
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'))
    manifest.unexpected = true
    await writeFile(fixture.manifestPath, canonicalJSONString(manifest))
    await expect(verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'final',
    })).rejects.toThrow(/unknown field/u)
  })

  it('rejects a non-final Web fixture in final mode and changed runtime bytes', async () => {
    const fixture = await webEvidenceFixture()
    await expect(verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'final',
    })).rejects.toThrow(/non-final/u)
    await writeFile(
      path.join(fixture.directory, 'runtime-assets-verification.json'),
      '{}\n',
    )
    await expect(verifyWebIDEEvidence({
      configuration: releaseConfiguration(),
      manifestPath: fixture.manifestPath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })).rejects.toThrow(/does not match/u)
  })

  it('rejects legacy or nonrelease Web compatibility receipt identities', () => {
    const webIDESourceCommit = 'a'.repeat(40)
    const webIDECandidateSha256 = 'b'.repeat(64)
    const receipt = {
      schemaVersion: 2,
      receiptKind: 'web-ide-release-validation-gate',
      mode: 'release-gate',
      package: 'web-ide@0.4.0',
      gateId: 'karel-compatibility',
      sourceCommit: webIDESourceCommit,
      candidateSha256: webIDECandidateSha256,
      command: 'Karel exact-candidate compatibility gate',
      exitCode: 0,
      emitter: 'karel:release-compatibility-gate@2',
    }
    const logBytes = (value) => Buffer.from(
      `captured output\n${WEB_IDE_GATE_RECEIPT_PREFIX}${canonicalJSONString(value)}`,
    )
    expect(() => validateValidationLogBytes(
      logBytes(receipt),
      'packed-exact-pair',
      { webIDECandidateSha256, webIDESourceCommit },
    )).not.toThrow()
    expect(() => validateValidationLogBytes(
      Buffer.from('resolved=file:/Users/synthetic/private/package.tgz\n'),
      'audit-full',
      { webIDECandidateSha256, webIDESourceCommit },
    )).toThrow(/unsafe local absolute path/u)
    expect(() => validateValidationLogBytes(
      Buffer.from(`token=ghp_\u001b[31m${'a'.repeat(24)}\n`),
      'audit-full',
      { webIDECandidateSha256, webIDESourceCommit },
    )).toThrow(/unsafe text/u)

    for (const invalid of [
      { ...receipt, schemaVersion: 1 },
      { ...receipt, mode: 'nonrelease-preflight-synthetic' },
      { ...receipt, emitter: 'karel:release-compatibility-gate@1' },
    ]) {
      expect(() => validateValidationLogBytes(
        logBytes(invalid),
        'packed-exact-pair',
        { webIDECandidateSha256, webIDESourceCommit },
      )).toThrow(/receipt identity/u)
    }
    const missingMode = { ...receipt }
    delete missingMode.mode
    expect(() => validateValidationLogBytes(
      logBytes(missingMode),
      'packed-exact-pair',
      { webIDECandidateSha256, webIDESourceCommit },
    )).toThrow(/missing required field mode/u)
  })
})

describe('license inventory and CycloneDX', () => {
  it('covers every package file and only the exact Web/React peers', async () => {
    const fixture = await webEvidenceFixture()
    const webIDEEvidence = await verifyWebIDECandidateEvidence({
      configuration: releaseConfiguration(),
      candidateStatePath: fixture.candidateStatePath,
      tarballPath: fixture.tarballPath,
      consumerLock: fixture.consumerLock,
      mode: 'test',
    })
    const packageManifest = await readJSON(path.join(repositoryRoot, 'package.json'))
    const packageLock = await readJSON(path.join(repositoryRoot, 'package-lock.json'))
    const consumerLock = await readJSON(path.join(
      repositoryRoot,
      'tests/production/consumer/package-lock.json',
    ))
    const policy = await readJSON(path.join(
      repositoryRoot,
      'release/license-policy.json',
    ))
    const ownLicenseBytes = await readFile(path.join(repositoryRoot, 'LICENSE.md'))
    const packageEntries = [{
      path: 'LICENSE.md',
      type: 'file',
      bytes: ownLicenseBytes,
    }]
    const inspection = {
      tarball: {
        filename: 'web-ide-karel-0.3.3.tgz',
        size: 123,
        sha256: 'd'.repeat(64),
        sha512Integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
      },
      files: [
        { path: 'LICENSE.md', size: ownLicenseBytes.length, mode: 0o644, sha256: sha256Bytes(ownLicenseBytes) },
        { path: 'python/karel.py', size: 10, mode: 0o644, sha256: 'e'.repeat(64) },
      ],
    }
    const licenses = await generateLicenseEvidence({
      policy,
      packageManifest,
      packageLock,
      consumerLock,
      packageEntries,
      inspection,
      webIDEEvidence,
    })
    expect(licenses.report.bundledDependencies).toEqual([])
    expect(licenses.report.packageFiles).toHaveLength(2)
    expect(licenses.report.externalPeers.map(({ name }) => name)).toEqual([
      'react',
      'react-dom',
      'web-ide',
    ])
    const sbom = generateCycloneDx({
      packageManifest,
      inspection,
      licenseReport: licenses.report,
      webIDEEvidence,
    })
    expect(sbom.bomFormat).toBe('CycloneDX')
    expect(sbom.components).toHaveLength(5)
    expect(JSON.stringify(sbom)).not.toContain('runtime-asset:')
    expect(validateCycloneDx(sbom, {
      packageManifest,
      inspection,
      licenseReport: licenses.report,
      webIDEEvidence,
    })).toBe(sbom)
    sbom.unexpected = true
    expect(() => validateCycloneDx(sbom, {
      packageManifest,
      inspection,
      licenseReport: licenses.report,
      webIDEEvidence,
    })).toThrow(/independently regenerated/u)
  })
})

describe('candidate evidence schemas', () => {
  it('requires exact lock bindings, artifact inventory, and deterministic source archive', () => {
    const source = { commit: 'a'.repeat(40) }
    const configuration = {
      package: '@web-ide/karel@0.3.3',
      capabilityReleaseId: 'hamilton.python-karel/8',
      packageRole: 'karel',
    }
    const state = {
      schemaVersion: 1,
      package: configuration.package,
      result: 'candidate-generated',
      mode: 'final',
      source,
      capabilityReleaseId: configuration.capabilityReleaseId,
      packageRole: configuration.packageRole,
      sourceFiles: {
        packageManifest: {},
        packageLock: {},
        consumerManifest: {},
        consumerLock: {},
      },
      webIDECandidate: {},
      consumerLockBindings: { webIDE: 'exact', karel: 'exact' },
      artifacts: CANDIDATE_ARTIFACT_FILES.map((fileName) => ({
        fileName,
        size: 1,
        sha256: 'b'.repeat(64),
      })),
    }
    expect(validateCandidateState(state, { configuration, source })).toBe(state)
    state.consumerLockBindings.unexpected = true
    expect(() => validateCandidateState(state, { configuration, source }))
      .toThrow(/unknown field unexpected/u)
    delete state.consumerLockBindings.unexpected
    state.artifacts[0].size = 33 * 1024 * 1024
    expect(() => validateCandidateState(state, { configuration, source }))
      .toThrow(/exceeds its size limit/u)
    state.artifacts[0].size = 1

    const sourceArchive = { size: 10, sha256: 'c'.repeat(64) }
    const determinism = {
      schemaVersion: 1,
      package: '@web-ide/karel@0.3.3',
      result: 'pass',
      isolatedBuildCount: 2,
      exactWebIDEArtifactMaterializedForBothBuilds: true,
      packageTarballsByteIdentical: true,
      packageInventoriesCanonicalByteIdentical: true,
      sourceTrackedStateCleanBeforeAndAfter: true,
      sourceArchiveReference: 'exact-tag',
      exactTagSourceArchivesByteIdentical: true,
      exactPushedCommitSourceArchivesByteIdentical: true,
      sourceArchive: {
        filename: 'web-ide-karel-0.3.3-source.tar.gz',
        ...sourceArchive,
      },
    }
    expect(validateDeterminismReport(determinism, { sourceArchive }))
      .toBe(determinism)
    determinism.packageTarballsByteIdentical = false
    expect(() => validateDeterminismReport(determinism, { sourceArchive }))
      .toThrow(/does not match/u)
  })
})

describe('artifact and validation manifests', () => {
  it('requires a canonical slash-free manifest ID and Web-owned runtime report', () => {
    const tarSha = 'a'.repeat(64)
    const webManifestSha = 'b'.repeat(64)
    const runtimeSha = 'c'.repeat(64)
    const sri = `sha512-${Buffer.alloc(64, 2).toString('base64')}`
    const sourceRecord = (fileName) => ({
      fileName,
      size: 1,
      sha256: 'd'.repeat(64),
    })
    const runtimeFiles = [
      'python/karel.py',
      'python/karel_world_contract.py',
      'python/starter.py',
      'worlds/default.json',
    ].map((filePath) => ({
      path: filePath,
      size: 1,
      mode: 0o644,
      sha256: 'd'.repeat(64),
    }))
    const reportNames = {
      'candidate-state': 'candidate-state.json',
      'cyclonedx-sbom': 'web-ide-karel-0.3.3.cdx.json',
      'deterministic-builds': 'deterministic-builds.json',
      'license-inventory': 'license-inventory.json',
      'package-inspection': 'package-inspection.json',
      'third-party-license-text': 'THIRD_PARTY_LICENSES.txt',
      'validation-summary': 'validation-summary.json',
      'web-ide-candidate-verification': 'web-ide-candidate-verification.json',
      'web-ide-final-verification': 'web-ide-final-verification.json',
    }
    for (const gateId of EXPECTED_VALIDATION_GATES.keys()) {
      reportNames[`validation-log:${gateId}`] = `validation-${gateId}.log`
      reportNames[`validation-receipt:${gateId}`]
        = `validation-${gateId}.receipt.json`
    }
    const reports = Object.entries(reportNames).map(([kind, fileName]) => ({
      kind,
      fileName,
      size: 1,
      sha256: 'd'.repeat(64),
    })).sort((left, right) => left.kind.localeCompare(right.kind))
    const manifestInput = {
      schemaVersion: 2,
      manifestKind: 'hamilton-capability-package-artifact',
      capabilityReleaseIds: ['hamilton.python-karel/8'],
      packageRole: 'karel',
      package: {
        name: '@web-ide/karel',
        version: '0.3.3',
        private: true,
        license: 'MIT',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './styles.css': './dist/styles.css',
          './python/karel.py': './python/karel.py',
          './python/karel_world_contract.py': './python/karel_world_contract.py',
          './worlds/default.json': './worlds/default.json',
          './package.json': './package.json',
        },
        peerDependencies: {
          react: '^18.3.0 || ^19.0.0',
          'react-dom': '^18.3.0 || ^19.0.0',
          'web-ide': '>=0.3.0 <0.4.0 || 0.4.0',
        },
        manifest: sourceRecord('package.json'),
        lockfile: sourceRecord('package-lock.json'),
        consumerManifest: sourceRecord('tests/production/consumer/package.json'),
        consumerLockfile: sourceRecord('tests/production/consumer/package-lock.json'),
        packagedRuntimeFiles: runtimeFiles,
      },
      source: {
        repository: 'https://github.com/justinvassantachart/web-ide-karel.git',
        branch: 'main',
        commit: 'e'.repeat(40),
        tree: 'f'.repeat(40),
        tag: {
          name: 'web-ide-karel-v0.3.3-source-r3',
          objectId: '0'.repeat(40),
          objectType: 'tag',
          peeledCommit: 'e'.repeat(40),
        },
        archive: {
          kind: 'source-archive',
          fileName: 'web-ide-karel-0.3.3-source.tar.gz',
          size: 1,
          sha256: 'd'.repeat(64),
        },
      },
      build: {
        node: '24.11.1',
        npm: '11.6.2',
        platform: 'darwin',
        architecture: 'arm64',
        osRelease: 'fixture',
        sourceDateEpoch: 1,
        isolatedBuildCount: 2,
        reproducibilityResult: 'pass',
        installCommand: 'npm ci fixture',
        packCommand: 'npm pack fixture',
      },
      artifact: {
        kind: 'package-tarball',
        fileName: 'web-ide-karel-0.3.3.tgz',
        size: 1,
        sha256: tarSha,
        sha512Integrity: sri,
      },
      webIDEPeer: {
        schemaVersion: 1,
        result: 'pass',
        capabilityReleaseId: 'hamilton.python-karel/8',
        packageRole: 'web-ide-peer',
        package: {
          name: 'web-ide',
          version: '0.4.0',
          peerRange: '>=0.3.0 <0.4.0 || 0.4.0',
          license: 'MIT',
        },
        artifactManifest: {
          fileName: 'artifact-manifest.json',
          size: 1,
          sha256: webManifestSha,
          manifestId: `urn:sha256:${webManifestSha}`,
          source: {
            repository: 'https://github.com/justinvassantachart/web-ide.git',
            commit: '1'.repeat(40),
            tree: '2'.repeat(40),
            tag: 'web-ide-v0.4.0-source-r3',
          },
        },
        artifact: {
          fileName: 'web-ide-0.4.0.tgz',
          size: 1,
          sha256: '3'.repeat(64),
          sha512Integrity: sri,
        },
        runtimeEvidence: {
          ownerPackageRole: 'web-ide',
          fileName: 'runtime-assets-verification.json',
          size: 1,
          sha256: runtimeSha,
          verifiedAssetCount: 1,
        },
        consumerLock: {
          reference: 'file:artifacts/web-ide.tgz',
          integrity: sri,
          binding: 'exact',
        },
        nonFinalTestFixture: false,
      },
      runtimeEvidence: {
        ownerPackageRole: 'web-ide',
        ownership: 'referenced-not-duplicated',
        artifactManifestSha256: webManifestSha,
        reportFileName: 'runtime-assets-verification.json',
        reportSha256: runtimeSha,
      },
      distribution: {
        mechanism: 'private-github-release-assets',
        npmPublished: false,
        repository: 'justinvassantachart/ths-ide',
        intendedTag: 'web-ide-karel-v0.3.3',
        intendedAssets: [
          'artifact-manifest.json',
          'artifact-manifest.json.sha256',
          ...Object.values(reportNames),
          'web-ide-karel-0.3.3-source.tar.gz',
          'web-ide-karel-0.3.3.tgz',
        ].sort(),
      },
      reports,
    }
    const manifest = {
      ...manifestInput,
      manifestId: `urn:sha256:${sha256Bytes(Buffer.from(
        canonicalJSONString(manifestInput),
      ))}`,
    }
    expect(manifest.manifestId).toMatch(/^[a-z0-9][a-z0-9._:-]{0,127}$/u)
    expect(validateArtifactManifest(manifest)).toBe(manifest)
    const legacySchema = structuredClone(manifest)
    legacySchema.schemaVersion = 1
    expect(() => validateArtifactManifest(legacySchema))
      .toThrow(/composition identity/u)
    const extraCapability = structuredClone(manifest)
    extraCapability.capabilityReleaseIds.push('hamilton.python/4')
    expect(() => validateArtifactManifest(extraCapability))
      .toThrow(/composition identity/u)
    manifest.manifestId = `hamilton.python-karel/8:karel:sha256:${tarSha}`
    expect(() => validateArtifactManifest(manifest)).toThrow(/canonical content/u)
    manifest.manifestId = `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(manifestInput),
    ))}`
    manifest.runtimeEvidence.ownerPackageRole = 'karel'
    const mutatedManifestInput = structuredClone(manifest)
    delete mutatedManifestInput.manifestId
    manifest.manifestId = `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(mutatedManifestInput),
    ))}`
    expect(() => validateArtifactManifest(manifest)).toThrow(/runtime evidence/u)
  })

  it('copies exact normalized capture logs and produces command/source/candidate-bound receipts', async () => {
    const fixture = await validationInputFixture()
    const outputDirectory = path.join(fixture.directory, 'staged')
    await mkdir(outputDirectory)
    expect(validateValidationInput(fixture.input, fixture)).toBe(fixture.input)
    const materialized = await materializeValidationEvidence({
      input: fixture.input,
      outputDirectory,
      sourceCommit: fixture.sourceCommit,
      candidateSha256: fixture.candidateSha256,
      webIDECandidateSha256: fixture.webIDECandidateSha256,
      webIDESourceCommit: fixture.webIDESourceCommit,
    })
    expect(materialized.summary.gates).toHaveLength(EXPECTED_VALIDATION_GATES.size)
    expect(materialized.reports).toHaveLength(EXPECTED_VALIDATION_GATES.size * 2)
    await expect(validateMaterializedValidationEvidence({
      outputDirectory,
      sourceCommit: fixture.sourceCommit,
      candidateSha256: fixture.candidateSha256,
      webIDECandidateSha256: fixture.webIDECandidateSha256,
      webIDESourceCommit: fixture.webIDESourceCommit,
    })).resolves.toMatchObject({ summary: { result: 'pass' } })
    await writeFile(
      path.join(outputDirectory, 'validation-validate-production.log'),
      'rewritten\n',
    )
    await expect(validateMaterializedValidationEvidence({
      outputDirectory,
      sourceCommit: fixture.sourceCommit,
      candidateSha256: fixture.candidateSha256,
      webIDECandidateSha256: fixture.webIDECandidateSha256,
      webIDESourceCommit: fixture.webIDESourceCommit,
    })).rejects.toThrow(/log changed/u)
  })

  it('rejects missing, reused, symlinked, oversized, and hash-swapped capture logs', async () => {
    const fixture = await validationInputFixture()
    const first = fixture.input.gates[0]
    first.log.sha256 = fixture.input.gates[1].log.sha256
    const outputA = path.join(fixture.directory, 'output-a')
    await mkdir(outputA)
    await expect(materializeValidationEvidence({
      input: fixture.input,
      outputDirectory: outputA,
      sourceCommit: fixture.sourceCommit,
      candidateSha256: fixture.candidateSha256,
      webIDECandidateSha256: fixture.webIDECandidateSha256,
      webIDESourceCommit: fixture.webIDESourceCommit,
    })).rejects.toThrow(/do not match/u)

    const reused = await validationInputFixture()
    reused.input.gates[1].log = {
      ...reused.input.gates[1].log,
      path: reused.input.gates[0].log.path,
      size: reused.input.gates[0].log.size,
      sha256: reused.input.gates[0].log.sha256,
    }
    const outputB = path.join(reused.directory, 'output-b')
    await mkdir(outputB)
    await expect(materializeValidationEvidence({
      input: reused.input,
      outputDirectory: outputB,
      sourceCommit: reused.sourceCommit,
      candidateSha256: reused.candidateSha256,
      webIDECandidateSha256: reused.webIDECandidateSha256,
      webIDESourceCommit: reused.webIDESourceCommit,
    })).rejects.toThrow(/reuse/u)

    const linked = await validationInputFixture()
    const linkPath = path.join(linked.directory, 'linked.log')
    await symlink(linked.input.gates[0].log.path, linkPath)
    linked.input.gates[0].log.path = linkPath
    const outputC = path.join(linked.directory, 'output-c')
    await mkdir(outputC)
    await expect(materializeValidationEvidence({
      input: linked.input,
      outputDirectory: outputC,
      sourceCommit: linked.sourceCommit,
      candidateSha256: linked.candidateSha256,
      webIDECandidateSha256: linked.webIDECandidateSha256,
      webIDESourceCommit: linked.webIDESourceCommit,
    })).rejects.toThrow(/symbolic link/u)

    const oversized = await validationInputFixture()
    oversized.input.gates[0].log.size = 33 * 1024 * 1024
    expect(() => validateValidationInput(oversized.input, oversized))
      .toThrow(/size is invalid/u)
    const excessiveTotal = await validationInputFixture()
    for (const gate of excessiveTotal.input.gates) {
      gate.log.size = 30 * 1024 * 1024
    }
    expect(() => validateValidationInput(excessiveTotal.input, excessiveTotal))
      .toThrow(/total size limit/u)

    const missing = await validationInputFixture()
    missing.input.gates[0].log.path = path.join(missing.directory, 'missing.log')
    const outputD = path.join(missing.directory, 'output-d')
    await mkdir(outputD)
    await expect(materializeValidationEvidence({
      input: missing.input,
      outputDirectory: outputD,
      sourceCommit: missing.sourceCommit,
      candidateSha256: missing.candidateSha256,
      webIDECandidateSha256: missing.webIDECandidateSha256,
      webIDESourceCommit: missing.webIDESourceCommit,
    })).rejects.toThrow()
  })

  it('rejects rewritten capture semantics even when caller hashes are updated', async () => {
    const fixture = await validationInputFixture()
    const gate = fixture.input.gates[0]
    const receipt = JSON.parse(await readFile(gate.receipt.path, 'utf8'))
    receipt.gate.exitCode = 1
    const rewrittenReceipt = Buffer.from(canonicalJSONString(receipt))
    await writeFile(gate.receipt.path, rewrittenReceipt)
    gate.receipt.size = rewrittenReceipt.length
    gate.receipt.sha256 = sha256Bytes(rewrittenReceipt)
    const outputA = path.join(fixture.directory, 'semantic-output-a')
    await mkdir(outputA)
    await expect(materializeValidationEvidence({
      input: fixture.input,
      outputDirectory: outputA,
      sourceCommit: fixture.sourceCommit,
      candidateSha256: fixture.candidateSha256,
      webIDECandidateSha256: fixture.webIDECandidateSha256,
      webIDESourceCommit: fixture.webIDESourceCommit,
    })).rejects.toThrow(/exact successful capture/u)

    const footerFixture = await validationInputFixture()
    const packedGate = footerFixture.input.gates.find(
      (candidate) => candidate.id === 'packed-exact-pair',
    )
    const changedLog = Buffer.from((await readFile(packedGate.log.path, 'utf8'))
      .replace(footerFixture.webIDECandidateSha256, 'e'.repeat(64)))
    await writeFile(packedGate.log.path, changedLog)
    packedGate.log.size = changedLog.length
    packedGate.log.sha256 = sha256Bytes(changedLog)
    const packedReceipt = JSON.parse(await readFile(
      packedGate.receipt.path,
      'utf8',
    ))
    packedReceipt.log = {
      fileName: packedGate.log.fileName,
      size: changedLog.length,
      sha256: sha256Bytes(changedLog),
    }
    const changedReceipt = Buffer.from(canonicalJSONString(packedReceipt))
    await writeFile(packedGate.receipt.path, changedReceipt)
    packedGate.receipt.size = changedReceipt.length
    packedGate.receipt.sha256 = sha256Bytes(changedReceipt)
    const outputB = path.join(footerFixture.directory, 'semantic-output-b')
    await mkdir(outputB)
    await expect(materializeValidationEvidence({
      input: footerFixture.input,
      outputDirectory: outputB,
      sourceCommit: footerFixture.sourceCommit,
      candidateSha256: footerFixture.candidateSha256,
      webIDECandidateSha256: footerFixture.webIDECandidateSha256,
      webIDESourceCommit: footerFixture.webIDESourceCommit,
    })).rejects.toThrow(/Web IDE receipt identity/u)

    const pathFixture = await validationInputFixture()
    const pathGate = pathFixture.input.gates.find(
      (candidate) => candidate.id === 'audit-full',
    )
    const pathLog = Buffer.from(
      'captured output from file:/Users/synthetic/private/package.tgz\n',
    )
    await writeFile(pathGate.log.path, pathLog)
    pathGate.log.size = pathLog.length
    pathGate.log.sha256 = sha256Bytes(pathLog)
    const pathReceipt = JSON.parse(await readFile(pathGate.receipt.path, 'utf8'))
    pathReceipt.log = {
      fileName: pathGate.log.fileName,
      size: pathLog.length,
      sha256: sha256Bytes(pathLog),
    }
    const pathReceiptBytes = Buffer.from(canonicalJSONString(pathReceipt))
    await writeFile(pathGate.receipt.path, pathReceiptBytes)
    pathGate.receipt.size = pathReceiptBytes.length
    pathGate.receipt.sha256 = sha256Bytes(pathReceiptBytes)
    const outputC = path.join(pathFixture.directory, 'semantic-output-c')
    await mkdir(outputC)
    await expect(materializeValidationEvidence({
      input: pathFixture.input,
      outputDirectory: outputC,
      sourceCommit: pathFixture.sourceCommit,
      candidateSha256: pathFixture.candidateSha256,
      webIDECandidateSha256: pathFixture.webIDECandidateSha256,
      webIDESourceCommit: pathFixture.webIDESourceCommit,
    })).rejects.toThrow(/unsafe local absolute path/u)

    const schemaFixture = await validationInputFixture()
    const schemaGate = schemaFixture.input.gates[0]
    const schemaReceipt = JSON.parse(await readFile(
      schemaGate.receipt.path,
      'utf8',
    ))
    schemaReceipt.schemaVersion = 1
    const schemaReceiptBytes = Buffer.from(canonicalJSONString(schemaReceipt))
    await writeFile(schemaGate.receipt.path, schemaReceiptBytes)
    schemaGate.receipt.size = schemaReceiptBytes.length
    schemaGate.receipt.sha256 = sha256Bytes(schemaReceiptBytes)
    const outputD = path.join(schemaFixture.directory, 'semantic-output-d')
    await mkdir(outputD)
    await expect(materializeValidationEvidence({
      input: schemaFixture.input,
      outputDirectory: outputD,
      sourceCommit: schemaFixture.sourceCommit,
      candidateSha256: schemaFixture.candidateSha256,
      webIDECandidateSha256: schemaFixture.webIDECandidateSha256,
      webIDESourceCommit: schemaFixture.webIDESourceCommit,
    })).rejects.toThrow(/Unsupported Karel/u)
  })
})

describe('release source state', () => {
  it('requires clean pushed main and pushed tag and archives deterministically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'karel-source-state-test-'))
    temporaryDirectories.push(directory)
    const bare = path.join(directory, 'remote.git')
    const checkout = path.join(directory, 'checkout')
    await git(['init', '--bare', '--initial-branch=main', bare])
    await git(['clone', bare, checkout])
    await writeFile(path.join(checkout, 'fixture.txt'), 'release fixture\n')
    await git(['add', 'fixture.txt'], { cwd: checkout })
    await git([
      '-c',
      'user.name=Release Fixture',
      '-c',
      'user.email=release-fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ], { cwd: checkout })
    await git([
      '-c',
      'user.name=Release Fixture',
      '-c',
      'user.email=release-fixture@example.invalid',
      'tag',
      '-a',
      'web-ide-karel-v0.3.3-source-r3',
      '-m',
      'fixture release',
    ], { cwd: checkout })
    await git([
      'push',
      'origin',
      'main',
      'refs/tags/web-ide-karel-v0.3.3-source-r3',
    ], { cwd: checkout })
    const npmVersion = (await run('npm', ['--version'])).stdout.trim()
    const configuration = {
      sourceRepository: bare,
      sourceTag: 'web-ide-karel-v0.3.3-source-r3',
      nodeVersion: process.versions.node,
      npmVersion,
    }
    const source = await verifyReleaseSourceState(configuration, checkout)
    expect(source).toMatchObject({
      branch: 'main',
      tag: {
        name: 'web-ide-karel-v0.3.3-source-r3',
        objectType: 'tag',
      },
      finalEligible: true,
      worktreeClean: true,
    })
    const changedSource = structuredClone(source)
    changedSource.tree = '0'.repeat(40)
    expect(() => assertReleaseSourceStateUnchanged(source, changedSource))
      .toThrow(/source identity changed/u)
    const [first, second] = await Promise.all([
      sourceArchiveBytes(configuration, { root: checkout }),
      sourceArchiveBytes(configuration, { root: checkout }),
    ])
    expect(first.bytes.equals(second.bytes)).toBe(true)

    const lateMutationTarget = path.join(directory, 'late-source-output')
    await expect(withAtomicOutputDirectory(
      lateMutationTarget,
      async (stage) => {
        await writeFile(path.join(stage, 'evidence.txt'), 'complete evidence\n')
        await git([
          '-c',
          'user.name=Release Fixture',
          '-c',
          'user.email=release-fixture@example.invalid',
          'tag',
          '--force',
          '--annotate',
          'web-ide-karel-v0.3.3-source-r3',
          '--message=late tag rewrite',
          'HEAD',
        ], { cwd: checkout })
      },
      {
        beforePublish: async () => {
          const current = await verifyReleaseSourceState(configuration, checkout)
          assertReleaseSourceStateUnchanged(source, current)
        },
      },
    )).rejects.toThrow(/Remote source tag/u)
    await expect(lstat(lateMutationTarget)).rejects.toMatchObject({ code: 'ENOENT' })
    await git([
      'update-ref',
      'refs/tags/web-ide-karel-v0.3.3-source-r3',
      source.tag.objectId,
    ], { cwd: checkout })

    await git(['config', '--local', 'tar.umask', '0077'], { cwd: checkout })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/forbidden local Git config tar\.umask/u)
    await git(['config', '--local', '--unset-all', 'tar.umask'], { cwd: checkout })
    await git([
      'config',
      '--local',
      'tar.synthetic.command',
      '/tmp/untrusted-tar-format',
    ], { cwd: checkout })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/forbidden local Git config tar\.synthetic\.command/u)
    await git([
      'config',
      '--local',
      '--unset-all',
      'tar.synthetic.command',
    ], { cwd: checkout })

    await git([
      'config', '--local', 'url.file:///tmp/rewritten/.insteadOf', bare,
    ], { cwd: checkout })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/forbidden local Git config url\./u)
    await git([
      'config', '--local', '--unset-all', 'url.file:///tmp/rewritten/.insteadOf',
    ], { cwd: checkout })
    await git(['config', '--local', 'include.path', '/tmp/untrusted.gitconfig'], {
      cwd: checkout,
    })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/forbidden local Git config include\.path/u)
    await git(['config', '--local', '--unset-all', 'include.path'], { cwd: checkout })
    await git(['config', '--local', 'remote.origin.uploadpack', '/tmp/untrusted'], {
      cwd: checkout,
    })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/uploadpack/u)
    await git(['config', '--local', '--unset-all', 'remote.origin.uploadpack'], {
      cwd: checkout,
    })
    const head = (await git(['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
    await git(['update-ref', `refs/replace/${head}`, head], { cwd: checkout })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/replace refs/u)
    await git(['update-ref', '-d', `refs/replace/${head}`], { cwd: checkout })
    await writeFile(
      path.join(checkout, '.git/objects/info/alternates'),
      `${path.join(bare, 'objects')}\n`,
    )
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/object indirection/u)
    await rm(path.join(checkout, '.git/objects/info/alternates'))

    const attributesPath = path.join(checkout, '.git/info/attributes')
    await writeFile(attributesPath, 'fixture.txt export-ignore\n')
    await expect(sourceArchiveBytes(configuration, { root: checkout }))
      .rejects.toThrow(/Git archive attributes/u)
    await rm(attributesPath)
    const emptyAttributesTarget = path.join(directory, 'empty-attributes')
    await writeFile(emptyAttributesTarget, '')
    await symlink(emptyAttributesTarget, attributesPath)
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/Git archive attributes/u)
    await rm(attributesPath)

    await git(['config', '--local', 'extensions.worktreeConfig', 'true'], {
      cwd: checkout,
    })
    await git([
      'config', '--worktree', 'remote.origin.uploadpack', '/tmp/untrusted-worktree',
    ], { cwd: checkout })
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/extensions\.worktreeconfig/u)
    await git([
      'config', '--local', '--unset-all', 'extensions.worktreeConfig',
    ], { cwd: checkout })
    await rm(path.join(checkout, '.git/config.worktree'))
    await writeFile(
      path.join(checkout, '.git/config.worktree'),
      '[remote "origin"]\n\tuploadpack = /tmp/untrusted-worktree\n',
    )
    await expect(verifyHermeticGitRepository(checkout))
      .rejects.toThrow(/Git worktree configuration/u)
    await rm(path.join(checkout, '.git/config.worktree'))

    await writeFile(path.join(checkout, 'dirty.txt'), 'dirty\n')
    await expect(verifyReleaseSourceState(configuration, checkout))
      .rejects.toThrow(/dirty/u)
    await rm(path.join(checkout, 'dirty.txt'))
    await git(['tag', '--delete', 'web-ide-karel-v0.3.3-source-r3'], { cwd: checkout })
    await git(['push', '--delete', 'origin', 'web-ide-karel-v0.3.3-source-r3'], { cwd: checkout })
    await git(['tag', 'web-ide-karel-v0.3.3-source-r3'], { cwd: checkout })
    await git(['push', 'origin', 'refs/tags/web-ide-karel-v0.3.3-source-r3'], { cwd: checkout })
    await expect(verifyReleaseSourceState(configuration, checkout))
      .rejects.toThrow(/annotated/u)
  })
})
