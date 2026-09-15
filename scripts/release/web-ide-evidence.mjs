import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import { validateProductionConsumerLock } from './consumer-lock.mjs'
import {
  PACKAGE_TAR_LIMITS,
  readPackageTarball,
  scanPackedTextEntry,
} from './package-inspection.mjs'
import {
  assertExactKeys,
  assertExternalInputFile,
  assertNonEmptyString,
  assertSha256,
  readBoundedFile,
  sha256Bytes,
  sha512IntegrityBytes,
  sortStrings,
} from './release-utils.mjs'

// Web IDE 0.4.0 replaces its debugger-sh runtime dependency with the
// published fork. Everything else in the packaged manifest contract is
// unchanged across 0.3.0, 0.3.1, and 0.4.0.
const WEB_DEBUGGER_SH_IDENTITIES = Object.freeze({
  '0.3.0': Object.freeze({
    version: '0.3.15',
    sourceTag: 'v0.3.15',
    sourceCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
  }),
  '0.3.1': Object.freeze({
    version: '0.3.15',
    sourceTag: 'v0.3.15',
    sourceCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
  }),
  // The fork's registry version is fixed by Karel's release input. Its
  // reviewed source tag and commit are Web IDE-owned final inputs and stay
  // unbound so no 0.4.0 runtime evidence can pass before they are reviewed.
  '0.4.0': Object.freeze({
    version: '0.3.15-webide.0.4.0.1',
    sourceTag: null,
    sourceCommit: null,
  }),
})

const WEB_PACKAGE_CONTRACT = {
  engines: { node: '^20.19.0 || >=22.12.0' },
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
}

const WEB_BASE_EVIDENCE_KINDS = [
  'bundle-provenance',
  'candidate-state',
  'cyclonedx-sbom',
  'deterministic-builds',
  'license-inventory',
  'package-inspection',
  'runtime-assets',
  'runtime-source-provenance',
  'third-party-license-text',
  'validation-summary',
]

const WEB_VALIDATION_LOG_KINDS = [
  'validation-log:audit-full:0',
  'validation-log:audit-production:0',
  'validation-log:consumer-exact-candidate:0',
  'validation-log:karel-compatibility:0',
  'validation-log:validate-production:0',
]

const WEB_IDE_FINAL_IDENTITIES = Object.freeze({
  '0.3.0': Object.freeze({
    version: '0.3.0',
    package: 'web-ide@0.3.0',
    capabilityReleaseId: 'hamilton.python-karel/2',
    capabilityReleaseIds: Object.freeze([
      'hamilton.python-karel/2',
      'hamilton.python/1',
    ]),
    peerRange: '>=0.3.0 <0.4.0',
    sourceTag: 'web-ide-v0.3.0-source',
    sourceAssetFilename: 'web-ide-0.3.0-source.tar.gz',
    releaseAssetFilename: 'web-ide-0.3.0.tgz',
  }),
  '0.3.1': Object.freeze({
    version: '0.3.1',
    package: 'web-ide@0.3.1',
    capabilityReleaseId: 'hamilton.python-karel/4',
    capabilityReleaseIds: Object.freeze([
      'hamilton.python-karel/4',
      'hamilton.python/2',
    ]),
    peerRange: '>=0.3.0 <0.4.0',
    sourceTag: 'web-ide-v0.3.1-source',
    sourceAssetFilename: 'web-ide-0.3.1-source.tar.gz',
    releaseAssetFilename: 'web-ide-0.3.1.tgz',
  }),
  '0.4.0': Object.freeze({
    version: '0.4.0',
    package: 'web-ide@0.4.0',
    capabilityReleaseId: 'hamilton.python-karel/6',
    capabilityReleaseIds: Object.freeze([
      'hamilton.python-karel/6',
      'hamilton.python/3',
    ]),
    peerRange: '>=0.3.0 <0.4.0 || 0.4.0',
    sourceTag: 'web-ide-v0.4.0-source',
    sourceAssetFilename: 'web-ide-0.4.0-source.tar.gz',
    releaseAssetFilename: 'web-ide-0.4.0.tgz',
  }),
})

function finalIdentity(configuration, observedVersion) {
  const configuredPackage = configuration?.webIDE?.package
  const identity = Object.values(WEB_IDE_FINAL_IDENTITIES).find((candidate) => (
    configuredPackage
      ? candidate.package === configuredPackage
      : candidate.version === observedVersion
  ))
  if (!identity || (observedVersion && identity.version !== observedVersion)) {
    throw new TypeError('Web IDE final evidence package is unsupported')
  }
  return identity
}

const PAIRED_KAREL_VERSIONS = Object.freeze({
  '0.3.0': '0.3.1',
  '0.3.1': '0.3.2',
  '0.4.0': '0.3.3',
})

function karelVersionForConfiguration(configuration, webIDEIdentity) {
  const prefix = '@web-ide/karel@'
  if (typeof configuration?.package === 'string'
    && configuration.package.startsWith(prefix)) {
    return configuration.package.slice(prefix.length)
  }
  return PAIRED_KAREL_VERSIONS[webIDEIdentity.version]
}

function assertFileRecord(record, location) {
  assertExactKeys(record, ['kind', 'fileName', 'size', 'sha256'], [], location)
  assertNonEmptyString(record.kind, `${location}.kind`)
  if (record.fileName !== path.basename(record.fileName)) {
    throw new TypeError(`${location}.fileName is unsafe`)
  }
  if (!Number.isSafeInteger(record.size) || record.size <= 0) {
    throw new TypeError(`${location}.size must be a positive safe integer`)
  }
  assertSha256(record.sha256, `${location}.sha256`)
}

function assertPositiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${location} must be a positive safe integer`)
  }
}

function assertCommit(value, location) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${location} must be a lowercase 40-character Git object ID`)
  }
}

function assertSha512Integrity(value, location) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new TypeError(`${location} must be SHA-512 SRI`)
  }
  const encoded = value.slice('sha512-'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new TypeError(`${location} is malformed`)
  }
}

export function validateWebIDEEvidenceReport(report, configuration) {
  assertExactKeys(report, [
    'schemaVersion',
    'result',
    'capabilityReleaseId',
    'packageRole',
    'package',
    'artifactManifest',
    'artifact',
    'runtimeEvidence',
    'consumerLock',
    'nonFinalTestFixture',
  ], [], 'Web IDE peer evidence report')
  const identity = finalIdentity(configuration, report.package?.version)
  if (
    report.schemaVersion !== 1
    || report.result !== 'pass'
    || report.capabilityReleaseId !== identity.capabilityReleaseId
    || report.packageRole !== 'web-ide-peer'
    || typeof report.nonFinalTestFixture !== 'boolean'
  ) throw new TypeError('Web IDE peer evidence report identity is wrong')
  assertExactKeys(report.package, [
    'name',
    'version',
    'peerRange',
    'license',
  ], [], 'Web IDE peer evidence package')
  const expectedRange = configuration?.webIDE.peerRange ?? identity.peerRange
  if (
    report.package.name !== 'web-ide'
    || report.package.version !== identity.version
    || report.package.peerRange !== expectedRange
    || report.package.license !== 'MIT'
  ) throw new TypeError('Web IDE peer evidence package identity is wrong')
  assertExactKeys(report.artifactManifest, [
    'fileName',
    'size',
    'sha256',
    'manifestId',
    'source',
  ], [], 'Web IDE peer artifact manifest')
  if (report.artifactManifest.fileName !== 'artifact-manifest.json') {
    throw new TypeError('Web IDE peer artifact manifest filename is wrong')
  }
  assertPositiveSafeInteger(
    report.artifactManifest.size,
    'Web IDE peer artifact manifest size',
  )
  assertSha256(
    report.artifactManifest.sha256,
    'Web IDE peer artifact manifest SHA-256',
  )
  assertNonEmptyString(
    report.artifactManifest.manifestId,
    'Web IDE peer artifact manifest ID',
  )
  assertExactKeys(report.artifactManifest.source, [
    'repository',
    'commit',
    'tree',
    'tag',
  ], [], 'Web IDE peer source')
  assertNonEmptyString(
    report.artifactManifest.source.repository,
    'Web IDE peer source repository',
  )
  assertCommit(report.artifactManifest.source.commit, 'Web IDE peer source commit')
  assertCommit(report.artifactManifest.source.tree, 'Web IDE peer source tree')
  if (
    report.artifactManifest.source.tag
      !== (configuration?.webIDE.sourceTag ?? identity.sourceTag)
  ) {
    throw new TypeError('Web IDE peer source tag is wrong')
  }
  assertExactKeys(report.artifact, [
    'fileName',
    'size',
    'sha256',
    'sha512Integrity',
  ], [], 'Web IDE peer artifact')
  if (
    report.artifact.fileName
      !== (configuration?.webIDE.releaseAssetFilename
        ?? identity.releaseAssetFilename)
  ) {
    throw new TypeError('Web IDE peer artifact filename is wrong')
  }
  assertPositiveSafeInteger(report.artifact.size, 'Web IDE peer artifact size')
  assertSha256(report.artifact.sha256, 'Web IDE peer artifact SHA-256')
  assertSha512Integrity(
    report.artifact.sha512Integrity,
    'Web IDE peer artifact integrity',
  )
  assertExactKeys(report.runtimeEvidence, [
    'ownerPackageRole',
    'fileName',
    'size',
    'sha256',
    'verifiedAssetCount',
  ], [], 'Web IDE peer runtime evidence')
  if (
    report.runtimeEvidence.ownerPackageRole !== 'web-ide'
    || report.runtimeEvidence.fileName !== 'runtime-assets-verification.json'
  ) throw new TypeError('Web IDE peer runtime evidence ownership is wrong')
  assertPositiveSafeInteger(
    report.runtimeEvidence.size,
    'Web IDE peer runtime evidence size',
  )
  assertSha256(
    report.runtimeEvidence.sha256,
    'Web IDE peer runtime evidence SHA-256',
  )
  assertPositiveSafeInteger(
    report.runtimeEvidence.verifiedAssetCount,
    'Web IDE peer verified runtime asset count',
  )
  assertExactKeys(report.consumerLock, [
    'reference',
    'integrity',
    'binding',
  ], [], 'Web IDE peer consumer lock')
  if (
    report.consumerLock.reference !== 'file:artifacts/web-ide.tgz'
    || !['exact', 'pending-final-web-regeneration'].includes(
      report.consumerLock.binding,
    )
  ) throw new TypeError('Web IDE peer consumer lock reference is wrong')
  assertSha512Integrity(
    report.consumerLock.integrity,
    'Web IDE peer consumer lock integrity',
  )
  return report
}

function assertCanonical(bytes, value, location) {
  if (!bytes.equals(Buffer.from(canonicalJSONString(value)))) {
    throw new TypeError(`${location} is not canonical JSON`)
  }
}

function requiredObject(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`)
  }
  return value
}

function validateWebSourceFile(record, expectedKind, expectedName, location) {
  assertFileRecord(record, location)
  if (record.kind !== expectedKind || record.fileName !== expectedName) {
    throw new TypeError(`${location} identity is wrong`)
  }
}

function validateWebRuntimeManifest(runtime, allowSyntheticFixture, debuggerSh) {
  assertExactKeys(runtime, [
    'observedDate',
    'digestRepresentation',
    'expectedRedirectCount',
    'requestTimeoutMs',
    'scope',
    'limitations',
    'assets',
    'debuggerSh',
  ], [], 'Web IDE artifact manifest runtime')
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(runtime.observedDate)
    || runtime.digestRepresentation !== 'identity-encoded-response-body'
    || runtime.expectedRedirectCount !== 0
    || !Number.isSafeInteger(runtime.requestTimeoutMs)
    || runtime.requestTimeoutMs < 1000
    || typeof runtime.scope !== 'string'
    || !runtime.scope
    || !Array.isArray(runtime.limitations)
    || runtime.limitations.length === 0
    || runtime.limitations.some((item) => typeof item !== 'string' || !item)
    || !Array.isArray(runtime.assets)
    || runtime.assets.length !== (allowSyntheticFixture ? 1 : 27)
  ) throw new TypeError('Web IDE artifact manifest runtime identity is incomplete')
  const ids = []
  for (const [index, asset] of runtime.assets.entries()) {
    const location = `Web IDE artifact manifest runtime assets[${index}]`
    assertExactKeys(asset, [
      'id',
      'version',
      'requestedUrl',
      'finalUrl',
      'size',
      'sha256',
      'contentType',
      'headers',
      'license',
    ], [], location)
    for (const field of [
      'id',
      'version',
      'requestedUrl',
      'finalUrl',
      'contentType',
      'license',
    ]) assertNonEmptyString(asset[field], `${location}.${field}`)
    assertPositiveSafeInteger(asset.size, `${location}.size`)
    assertSha256(asset.sha256, `${location}.sha256`)
    assertExactKeys(asset.headers, [
      'access-control-allow-origin',
      'cross-origin-resource-policy',
    ], [], `${location}.headers`)
    ids.push(asset.id)
  }
  if (
    JSON.stringify(ids) !== JSON.stringify(sortStrings(ids))
    || new Set(ids).size !== ids.length
  ) throw new TypeError('Web IDE artifact manifest runtime assets are not unique and sorted')
  assertExactKeys(runtime.debuggerSh, [
    'registry',
    'source',
    'distribution',
  ], [], 'Web IDE artifact manifest debuggerSh')
  assertExactKeys(runtime.debuggerSh.registry, [
    'name',
    'version',
    'resolved',
    'integrity',
  ], [], 'Web IDE artifact manifest debuggerSh registry')
  assertExactKeys(runtime.debuggerSh.source, [
    'repository',
    'tag',
    'commit',
  ], [], 'Web IDE artifact manifest debuggerSh source')
  assertExactKeys(runtime.debuggerSh.distribution, [
    'path',
    'size',
    'sha256',
  ], [], 'Web IDE artifact manifest debuggerSh distribution')
  if (debuggerSh.sourceTag === null || debuggerSh.sourceCommit === null) {
    throw new TypeError(
      `Web IDE artifact manifest debugger-sh ${debuggerSh.version} reviewed source tag and commit are not bound yet`,
    )
  }
  if (
    runtime.debuggerSh.registry.name !== 'debugger-sh'
    || runtime.debuggerSh.registry.version !== debuggerSh.version
    || runtime.debuggerSh.source.tag !== debuggerSh.sourceTag
    || runtime.debuggerSh.source.commit !== debuggerSh.sourceCommit
    || runtime.debuggerSh.distribution.path !== 'dist/engine_bg.wasm'
  ) throw new TypeError('Web IDE artifact manifest debugger-sh identity is wrong')
  assertNonEmptyString(
    runtime.debuggerSh.registry.resolved,
    'Web IDE artifact manifest debugger-sh resolution',
  )
  assertNonEmptyString(
    runtime.debuggerSh.source.repository,
    'Web IDE artifact manifest debugger-sh source repository',
  )
  assertSha512Integrity(
    runtime.debuggerSh.registry.integrity,
    'Web IDE artifact manifest debugger-sh integrity',
  )
  assertPositiveSafeInteger(
    runtime.debuggerSh.distribution.size,
    'Web IDE artifact manifest debugger-sh distribution size',
  )
  assertSha256(
    runtime.debuggerSh.distribution.sha256,
    'Web IDE artifact manifest debugger-sh distribution SHA-256',
  )
}

function validateWebIDEArtifactManifest(manifest, configuration, mode, identity) {
  const synthetic = mode === 'test' && manifest.nonFinalTestFixture === true
  assertExactKeys(manifest, [
    'schemaVersion',
    'manifestKind',
    'manifestId',
    'capabilityReleaseIds',
    'packageRole',
    'package',
    'source',
    'toolchain',
    'buildInputs',
    'distribution',
    'runtime',
    'validation',
    'evidence',
  ], synthetic ? ['nonFinalTestFixture'] : [], 'Web IDE artifact manifest')
  if (
    manifest.schemaVersion !== 2
    || manifest.manifestKind !== 'hamilton-capability-package-artifact'
    || canonicalJSONString(manifest.capabilityReleaseIds)
      !== canonicalJSONString(identity.capabilityReleaseIds)
    || manifest.packageRole !== configuration.webIDE.packageRole
  ) throw new TypeError('Web IDE artifact manifest composition identity is wrong')
  const { manifestId, ...identityInput } = manifest
  const expectedId = `urn:sha256:${sha256Bytes(Buffer.from(
    canonicalJSONString(identityInput),
  ))}`
  if (manifestId !== expectedId) {
    throw new TypeError('Web IDE artifact manifest ID is not its canonical content identity')
  }
  assertExactKeys(manifest.package, [
    'name',
    'version',
    'private',
    'license',
    'engines',
    'dependencies',
    'peerDependencies',
    'exports',
  ], [], 'Web IDE artifact manifest package')
  if (
    manifest.package.name !== 'web-ide'
    || manifest.package.version !== identity.version
    || manifest.package.private !== true
    || manifest.package.license !== 'MIT'
  ) throw new TypeError('Web IDE artifact manifest package identity is wrong')
  const packageContract = {
    ...WEB_PACKAGE_CONTRACT,
    dependencies: {
      'debugger-sh': WEB_DEBUGGER_SH_IDENTITIES[identity.version].version,
    },
  }
  for (const field of Object.keys(packageContract)) {
    if (
      canonicalJSONString(manifest.package[field])
      !== canonicalJSONString(packageContract[field])
    ) throw new TypeError(`Web IDE artifact manifest package ${field} is wrong`)
  }
  assertExactKeys(manifest.source, [
    'repository',
    'branch',
    'commit',
    'tree',
    'commitTimestamp',
    'sourceDateEpoch',
    'tag',
    'inputs',
    'archive',
  ], [], 'Web IDE artifact manifest source')
  if (
    manifest.source.repository
      !== 'https://github.com/justinvassantachart/web-ide.git'
    || manifest.source.branch !== 'main'
    || !Number.isSafeInteger(manifest.source.commitTimestamp)
    || manifest.source.commitTimestamp <= 0
    || manifest.source.sourceDateEpoch !== String(manifest.source.commitTimestamp)
  ) throw new TypeError('Web IDE artifact manifest source identity is wrong')
  assertCommit(manifest.source.commit, 'Web IDE artifact manifest source commit')
  assertCommit(manifest.source.tree, 'Web IDE artifact manifest source tree')
  assertExactKeys(manifest.source.tag, [
    'name',
    'objectId',
    'objectType',
    'peeledCommit',
  ], [], 'Web IDE artifact manifest source tag')
  assertCommit(
    manifest.source.tag.objectId,
    'Web IDE artifact manifest source tag object',
  )
  if (
    manifest.source.tag.name !== configuration.webIDE.sourceTag
    || manifest.source.tag.objectType !== 'tag'
    || manifest.source.tag.peeledCommit !== manifest.source.commit
  ) throw new TypeError('Web IDE artifact manifest annotated tag is wrong')
  assertExactKeys(manifest.source.inputs, [
    'packageJson',
    'packageLock',
  ], [], 'Web IDE artifact manifest source inputs')
  validateWebSourceFile(
    manifest.source.inputs.packageJson,
    'source-input',
    'package.json',
    'Web IDE artifact manifest package input',
  )
  validateWebSourceFile(
    manifest.source.inputs.packageLock,
    'source-input',
    'package-lock.json',
    'Web IDE artifact manifest lock input',
  )
  validateWebSourceFile(
    manifest.source.archive,
    'source-archive',
    identity.sourceAssetFilename,
    'Web IDE artifact manifest source archive',
  )
  assertExactKeys(manifest.toolchain, [
    'node',
    'npm',
    'osType',
    'osRelease',
    'platform',
    'arch',
  ], [], 'Web IDE artifact manifest toolchain')
  if (
    manifest.toolchain.node !== '24.11.1'
    || manifest.toolchain.npm !== '11.6.2'
  ) throw new TypeError('Web IDE artifact manifest toolchain is wrong')
  for (const field of ['osType', 'osRelease', 'platform', 'arch']) {
    assertNonEmptyString(manifest.toolchain[field], `Web IDE toolchain.${field}`)
  }
  assertExactKeys(manifest.buildInputs, [
    'argv',
    'environment',
    'pathNormalization',
  ], [], 'Web IDE artifact manifest build inputs')
  assertExactKeys(manifest.buildInputs.argv, [
    'install',
    'build',
    'licenseEvidence',
    'pack',
  ], [], 'Web IDE artifact manifest build argv')
  const expectedArgv = {
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
  }
  if (
    canonicalJSONString(manifest.buildInputs.argv)
    !== canonicalJSONString(expectedArgv)
  ) throw new TypeError('Web IDE artifact manifest build argv is wrong')
  assertExactKeys(manifest.buildInputs.environment, [
    'inherited',
    'PATH',
    'HOME',
    'TMPDIR',
    'TZ',
    'LANG',
    'LC_ALL',
    'CI',
    'NO_UPDATE_NOTIFIER',
    'SOURCE_DATE_EPOCH',
    'npm_config_cache',
    'npm_config_registry',
    'npm_config_globalconfig',
    'npm_config_strict_ssl',
    'npm_config_package_lock',
    'npm_config_offline',
    'npm_config_prefer_offline',
    'npm_config_prefer_online',
    'npm_config_ignore_scripts',
    'npm_config_audit',
    'npm_config_fund',
    'npm_config_userconfig',
    'WEB_IDE_RELEASE_PROVENANCE_PATH',
    'WEB_IDE_RELEASE_LICENSE_OUTPUT_DIR',
  ], [], 'Web IDE artifact manifest build environment')
  if (
    !Array.isArray(manifest.buildInputs.environment.inherited)
    || manifest.buildInputs.environment.inherited.length !== 0
    || manifest.buildInputs.environment.SOURCE_DATE_EPOCH
      !== manifest.source.sourceDateEpoch
    || manifest.buildInputs.environment.TZ !== 'UTC'
    || manifest.buildInputs.environment.LC_ALL !== 'C'
    || manifest.buildInputs.environment.npm_config_registry
      !== 'https://registry.npmjs.org/'
    || manifest.buildInputs.environment.npm_config_globalconfig
      !== '<isolated-build>/global.npmrc'
    || manifest.buildInputs.environment.npm_config_strict_ssl !== 'true'
    || manifest.buildInputs.environment.npm_config_package_lock !== 'true'
    || manifest.buildInputs.environment.npm_config_offline !== 'false'
    || manifest.buildInputs.environment.npm_config_prefer_offline !== 'false'
    || manifest.buildInputs.environment.npm_config_prefer_online !== 'false'
    || manifest.buildInputs.environment.npm_config_ignore_scripts !== 'true'
    || manifest.buildInputs.environment.npm_config_audit !== 'false'
    || manifest.buildInputs.environment.npm_config_fund !== 'false'
    || manifest.buildInputs.environment.npm_config_userconfig
      !== '<isolated-build>/user.npmrc'
  ) throw new TypeError('Web IDE artifact manifest build environment is wrong')
  assertNonEmptyString(
    manifest.buildInputs.pathNormalization,
    'Web IDE artifact manifest path normalization',
  )
  assertExactKeys(manifest.distribution, [
    'mechanism',
    'npmPublished',
    'repository',
    'intendedTag',
    'intendedAssetFilename',
    'artifact',
  ], [], 'Web IDE artifact manifest distribution')
  assertExactKeys(manifest.validation, [
    'candidateSha256',
    'gateCount',
    'logCount',
  ], [], 'Web IDE artifact manifest validation')
  if (
    manifest.validation.candidateSha256 !== manifest.distribution.artifact.sha256
    || manifest.validation.gateCount !== 5
    || !Number.isSafeInteger(manifest.validation.logCount)
    || manifest.validation.logCount < 5
  ) throw new TypeError('Web IDE artifact manifest validation identity is wrong')
  validateWebRuntimeManifest(
    manifest.runtime,
    synthetic,
    WEB_DEBUGGER_SH_IDENTITIES[identity.version],
  )
  if (
    !Array.isArray(manifest.evidence)
    || manifest.evidence.length
      !== WEB_BASE_EVIDENCE_KINDS.length + manifest.validation.logCount
  ) throw new TypeError('Web IDE artifact manifest evidence set is incomplete')
  const kinds = []
  for (const [index, evidence] of manifest.evidence.entries()) {
    assertFileRecord(evidence, `Web IDE artifact manifest evidence[${index}]`)
    kinds.push(evidence.kind)
  }
  if (
    JSON.stringify(kinds) !== JSON.stringify(sortStrings(kinds))
    || new Set(kinds).size !== kinds.length
  ) throw new TypeError('Web IDE artifact manifest evidence is not unique and sorted')
  const baseKinds = kinds.filter((kind) => !kind.startsWith('validation-log:'))
  const logKinds = kinds.filter((kind) => kind.startsWith('validation-log:'))
  if (
    JSON.stringify(baseKinds) !== JSON.stringify(WEB_BASE_EVIDENCE_KINDS)
    || logKinds.length !== manifest.validation.logCount
    || JSON.stringify(logKinds) !== JSON.stringify(WEB_VALIDATION_LOG_KINDS)
  ) throw new TypeError('Web IDE artifact manifest evidence kinds are incomplete')
  return manifest
}

export function validateWebIDERuntimeReport(runtime) {
  assertExactKeys(runtime, [
    'schemaVersion',
    'package',
    'observedDate',
    'digestRepresentation',
    'expectedRedirectCount',
    'requestTimeoutMs',
    'scope',
    'limitations',
    'result',
    'assets',
  ], [], 'Web IDE runtime-assets report')
  if (
    runtime.schemaVersion !== 1
    || runtime.package !== 'web-ide'
    || runtime.result !== 'pass'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(runtime.observedDate)
    || runtime.digestRepresentation !== 'identity-encoded-response-body'
    || runtime.expectedRedirectCount !== 0
    || !Number.isSafeInteger(runtime.requestTimeoutMs)
    || runtime.requestTimeoutMs < 1000
    || typeof runtime.scope !== 'string'
    || runtime.scope.length === 0
    || !Array.isArray(runtime.limitations)
    || runtime.limitations.length === 0
    || runtime.limitations.some((item) => (
      typeof item !== 'string' || item.length === 0
    ))
    || !Array.isArray(runtime.assets)
    || runtime.assets.length === 0
  ) throw new TypeError('Web IDE runtime-assets report is not an exact passing report')
  const runtimeAssetIds = new Set()
  for (const [index, asset] of runtime.assets.entries()) {
    const location = `Web IDE runtime-assets report assets[${index}]`
    assertExactKeys(asset, [
      'id',
      'requestedUrl',
      'finalUrl',
      'redirectCount',
      'status',
      'contentType',
      'headers',
      'size',
      'sha256',
    ], [], location)
    assertNonEmptyString(asset.id, `${location}.id`)
    if (runtimeAssetIds.has(asset.id)) {
      throw new TypeError(`Web IDE runtime-assets report duplicates ${asset.id}`)
    }
    runtimeAssetIds.add(asset.id)
    for (const field of ['requestedUrl', 'finalUrl', 'contentType']) {
      assertNonEmptyString(asset[field], `${location}.${field}`)
    }
    for (const field of ['requestedUrl', 'finalUrl']) {
      const url = new URL(asset[field])
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || url.hash
      ) throw new TypeError(`${location}.${field} is not a safe HTTPS URL`)
    }
    if (
      !Number.isSafeInteger(asset.redirectCount)
      || asset.redirectCount !== runtime.expectedRedirectCount
      || asset.status !== 200
    ) throw new TypeError(`${location} response identity is invalid`)
    assertExactKeys(asset.headers, [
      'access-control-allow-origin',
      'cross-origin-resource-policy',
    ], [], `${location}.headers`)
    for (const [header, value] of Object.entries(asset.headers)) {
      if (value !== null && typeof value !== 'string') {
        throw new TypeError(`${location}.headers.${header} is invalid`)
      }
    }
    assertPositiveSafeInteger(asset.size, `${location}.size`)
    assertSha256(asset.sha256, `${location}.sha256`)
  }
  const assetIds = runtime.assets.map((asset) => asset.id)
  if (JSON.stringify(assetIds) !== JSON.stringify([...assetIds].sort())) {
    throw new TypeError('Web IDE runtime-assets report assets are not sorted by ID')
  }
  return runtime
}

export async function verifyWebIDEEvidence({
  configuration,
  manifestPath,
  tarballPath,
  consumerLock,
  mode,
}) {
  const identity = finalIdentity(configuration)
  if (path.basename(manifestPath) !== configuration.webIDE.artifactManifestFilename) {
    throw new TypeError('Web IDE artifact manifest filename is not exact')
  }
  if (path.basename(tarballPath) !== configuration.webIDE.releaseAssetFilename) {
    throw new TypeError('Web IDE candidate filename is not exact')
  }
  const manifestBytes = await readBoundedFile(
    manifestPath,
    16 * 1024 * 1024,
    'Web IDE artifact manifest',
  )
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  assertCanonical(manifestBytes, manifest, 'Web IDE artifact manifest')
  requiredObject(manifest, 'Web IDE artifact manifest')
  for (const field of [
    'schemaVersion',
    'manifestKind',
    'capabilityReleaseIds',
    'packageRole',
    'package',
    'source',
    'distribution',
    'evidence',
  ]) {
    if (!(field in manifest)) {
      throw new TypeError(`Web IDE artifact manifest is missing ${field}`)
    }
  }
  if (
    manifest.schemaVersion !== 2
    || manifest.manifestKind !== 'hamilton-capability-package-artifact'
    || canonicalJSONString(manifest.capabilityReleaseIds)
      !== canonicalJSONString(identity.capabilityReleaseIds)
    || manifest.packageRole !== configuration.webIDE.packageRole
  ) throw new TypeError('Web IDE artifact manifest composition identity is wrong')
  if (mode === 'final' && manifest.nonFinalTestFixture === true) {
    throw new TypeError('A non-final Web IDE fixture cannot satisfy final Karel evidence')
  }
  validateWebIDEArtifactManifest(manifest, configuration, mode, identity)
  const packageIdentity = requiredObject(manifest.package, 'Web IDE package identity')
  if (
    packageIdentity.name !== 'web-ide'
    || packageIdentity.version !== identity.version
    || packageIdentity.private !== true
    || packageIdentity.license !== 'MIT'
  ) throw new TypeError('Web IDE package identity is not the accepted MIT peer')
  const source = requiredObject(manifest.source, 'Web IDE source identity')
  assertNonEmptyString(source.repository, 'Web IDE source.repository')
  const distribution = requiredObject(manifest.distribution, 'Web IDE distribution')
  if (
    distribution.mechanism !== 'private-github-release-asset'
    || distribution.npmPublished !== false
    || distribution.repository !== configuration.webIDE.releaseRepository
    || distribution.intendedTag !== configuration.webIDE.releaseTag
    || distribution.intendedAssetFilename !== configuration.webIDE.releaseAssetFilename
  ) throw new TypeError('Web IDE intended distribution identity does not match Karel input')
  assertExactKeys(distribution.artifact, [
    'kind',
    'fileName',
    'size',
    'sha256',
    'sha512Integrity',
    'files',
  ], [], 'Web IDE distribution.artifact')
  assertNonEmptyString(
    distribution.artifact.kind,
    'Web IDE distribution.artifact.kind',
  )
  if (
    distribution.artifact.fileName !== path.basename(
      distribution.artifact.fileName,
    )
  ) throw new TypeError('Web IDE distribution artifact filename is unsafe')
  assertPositiveSafeInteger(
    distribution.artifact.size,
    'Web IDE distribution artifact size',
  )
  assertSha256(
    distribution.artifact.sha256,
    'Web IDE distribution artifact SHA-256',
  )
  assertSha512Integrity(
    distribution.artifact.sha512Integrity,
    'Web IDE distribution artifact integrity',
  )
  if (!Array.isArray(distribution.artifact.files)) {
    throw new TypeError('Web IDE distribution artifact files must be an array')
  }
  if (
    distribution.artifact.kind !== 'package-tarball'
    || distribution.artifact.fileName !== configuration.webIDE.releaseAssetFilename
  ) throw new TypeError('Web IDE package artifact record is not exact')

  if (!Array.isArray(manifest.evidence)) {
    throw new TypeError('Web IDE manifest evidence must be an array')
  }
  const evidenceByKind = new Map()
  for (const [index, evidence] of manifest.evidence.entries()) {
    assertFileRecord(evidence, `Web IDE evidence[${index}]`)
    if (evidenceByKind.has(evidence.kind)) {
      throw new TypeError(`Web IDE manifest has duplicate evidence kind ${evidence.kind}`)
    }
    evidenceByKind.set(evidence.kind, evidence)
  }
  const runtimeRecord = evidenceByKind.get('runtime-assets')
  if (
    !runtimeRecord
    || runtimeRecord.fileName !== configuration.webIDE.runtimeEvidenceFilename
  ) throw new TypeError('Web IDE manifest has no exact runtime-assets evidence reference')

  const manifestSha256 = sha256Bytes(manifestBytes)
  const sidecarPath = await assertExternalInputFile(path.join(
    path.dirname(manifestPath),
    `${configuration.webIDE.artifactManifestFilename}.sha256`,
  ), 'Web IDE artifact manifest sidecar')
  const sidecar = (await readBoundedFile(
    sidecarPath,
    4 * 1024,
    'Web IDE artifact manifest sidecar',
  )).toString('utf8')
  const expectedSidecar = `${manifestSha256}  ${configuration.webIDE.artifactManifestFilename}\n`
  if (sidecar !== expectedSidecar) {
    throw new TypeError('Web IDE artifact manifest SHA-256 sidecar does not match')
  }

  const tarballBytes = await readBoundedFile(
    tarballPath,
    PACKAGE_TAR_LIMITS.compressedBytes,
    'Web IDE release tarball',
  )
  const tarballSha256 = sha256Bytes(tarballBytes)
  const tarballSRI = sha512IntegrityBytes(tarballBytes)
  if (
    distribution.artifact.size !== tarballBytes.length
    || distribution.artifact.sha256 !== tarballSha256
    || distribution.artifact.sha512Integrity !== tarballSRI
  ) throw new TypeError('Web IDE tarball does not match its artifact manifest')
  const entries = readPackageTarball(tarballBytes)
  for (const entry of entries) {
    scanPackedTextEntry(entry, { packageKind: 'web-ide' })
  }
  const byPath = new Map(entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => [entry.path, entry]))
  const packedManifest = JSON.parse(byPath.get('package.json')?.bytes.toString('utf8') ?? 'null')
  if (
    packedManifest?.name !== 'web-ide'
    || packedManifest.version !== identity.version
    || packedManifest.private !== true
    || packedManifest.license !== 'MIT'
    || !byPath.has('LICENSE.md')
  ) throw new TypeError('Web IDE tarball package identity or license file is wrong')
  const actualFiles = entries
    .filter((entry) => entry.type === 'file')
    .map(({ path: filePath, size, mode, sha256 }) => ({
      path: filePath,
      size,
      mode,
      sha256,
    }))
    .sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ))
  if (
    canonicalJSONString(distribution.artifact.files)
    !== canonicalJSONString(actualFiles)
  ) throw new TypeError('Web IDE artifact manifest file inventory does not match its tarball')

  const runtimePath = await assertExternalInputFile(
    path.join(path.dirname(manifestPath), runtimeRecord.fileName),
    'Web IDE runtime-assets report',
  )
  const runtimeBytes = await readBoundedFile(
    runtimePath,
    16 * 1024 * 1024,
    'Web IDE runtime-assets report',
  )
  if (
    runtimeBytes.length !== runtimeRecord.size
    || sha256Bytes(runtimeBytes) !== runtimeRecord.sha256
  ) throw new TypeError('Web IDE runtime-assets report does not match its manifest')
  const runtime = JSON.parse(runtimeBytes.toString('utf8'))
  assertCanonical(runtimeBytes, runtime, 'Web IDE runtime-assets report')
  validateWebIDERuntimeReport(runtime)
  for (const field of [
    'observedDate',
    'digestRepresentation',
    'expectedRedirectCount',
    'requestTimeoutMs',
    'scope',
    'limitations',
  ]) {
    if (
      canonicalJSONString(runtime[field])
      !== canonicalJSONString(manifest.runtime[field])
    ) throw new TypeError(`Web IDE runtime report ${field} differs from its manifest`)
  }
  const runtimeById = new Map(runtime.assets.map((asset) => [asset.id, asset]))
  const manifestRuntimeIds = manifest.runtime.assets.map((asset) => asset.id)
  const reportRuntimeIds = runtime.assets.map((asset) => asset.id)
  if (
    runtime.assets.length !== manifest.runtime.assets.length
    || canonicalJSONString(reportRuntimeIds)
      !== canonicalJSONString(manifestRuntimeIds)
  ) throw new TypeError('Web IDE runtime report asset set differs from its manifest')
  for (const expected of manifest.runtime.assets) {
    const actual = runtimeById.get(expected.id)
    if (!actual) throw new TypeError(`Web IDE runtime report is missing ${expected.id}`)
    for (const field of [
      'requestedUrl',
      'finalUrl',
      'size',
      'sha256',
      'contentType',
      'headers',
    ]) {
      if (
        canonicalJSONString(actual[field])
        !== canonicalJSONString(expected[field])
      ) throw new TypeError(`Web IDE runtime report ${expected.id}.${field} differs`)
    }
  }
  if (
    runtime.assets.reduce((total, asset) => total + asset.redirectCount, 0)
      !== manifest.runtime.expectedRedirectCount
  ) throw new TypeError('Web IDE runtime redirect count differs from its manifest')

  const lockValidation = validateProductionConsumerLock(consumerLock, {
    webIDEIntegrity: tarballSRI,
    requireWebIDEIntegrity: mode === 'final',
    webIDEVersion: identity.version,
    karelVersion: karelVersionForConfiguration(configuration, identity),
  })
  const lockEntry = lockValidation.webIDE
  const lockMatchesArtifact = lockEntry.binding === 'exact'
  if (mode === 'final' && !lockMatchesArtifact) {
    throw new TypeError('Packed consumer lock is not bound to the final Web IDE artifact')
  }

  const report = {
    schemaVersion: 1,
    result: 'pass',
    capabilityReleaseId: identity.capabilityReleaseId,
    packageRole: 'web-ide-peer',
    package: {
      name: 'web-ide',
      version: identity.version,
      peerRange: configuration.webIDE.peerRange,
      license: 'MIT',
    },
    artifactManifest: {
      fileName: configuration.webIDE.artifactManifestFilename,
      size: manifestBytes.length,
      sha256: manifestSha256,
      manifestId: manifest.manifestId,
      source: {
        repository: source.repository,
        commit: source.commit,
        tree: source.tree,
        tag: source.tag.name,
      },
    },
    artifact: {
      fileName: configuration.webIDE.releaseAssetFilename,
      size: tarballBytes.length,
      sha256: tarballSha256,
      sha512Integrity: tarballSRI,
    },
    runtimeEvidence: {
      ownerPackageRole: 'web-ide',
      fileName: runtimeRecord.fileName,
      size: runtimeRecord.size,
      sha256: runtimeRecord.sha256,
      verifiedAssetCount: runtime.assets.length,
    },
    consumerLock: {
      reference: lockEntry.reference,
      integrity: lockEntry.integrity,
      binding: lockMatchesArtifact
        ? 'exact'
        : 'pending-final-web-regeneration',
    },
    nonFinalTestFixture: manifest.nonFinalTestFixture === true,
  }
  validateWebIDEEvidenceReport(report, configuration)
  return {
    entries,
    licenseEntry: byPath.get('LICENSE.md'),
    manifest,
    report,
  }
}
