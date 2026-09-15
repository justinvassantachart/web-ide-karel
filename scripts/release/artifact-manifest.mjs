import os from 'node:os'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertSha256,
  hashFile,
  sha256Bytes,
  sortStrings,
} from './release-utils.mjs'
import { validateWebIDEEvidenceReport } from './web-ide-evidence.mjs'
import { EXPECTED_VALIDATION_GATES } from './validation-evidence.mjs'

const EXPECTED_EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './styles.css': './dist/styles.css',
  './python/karel.py': './python/karel.py',
  './python/karel_world_contract.py': './python/karel_world_contract.py',
  './worlds/default.json': './worlds/default.json',
  './package.json': './package.json',
}

// 0.3.3 widens the Web IDE peer to admit the one reviewed 0.4.0 build in
// addition to the historical 0.3.x range. The immutable 0.3.1 and 0.3.2
// manifests keep their own published peer contract.
const EXPECTED_PEERS_BY_VERSION = Object.freeze({
  '0.3.1': Object.freeze({
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
    'web-ide': '>=0.3.0 <0.4.0',
  }),
  '0.3.2': Object.freeze({
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
    'web-ide': '>=0.3.0 <0.4.0',
  }),
  '0.3.3': Object.freeze({
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
    'web-ide': '>=0.3.0 <0.4.0 || 0.4.0',
  }),
})

const KAREL_ARTIFACT_IDENTITIES = Object.freeze({
  '0.3.1': Object.freeze({
    version: '0.3.1',
    capabilityReleaseIds: Object.freeze(['hamilton.python-karel/3']),
    sourceTag: 'web-ide-karel-v0.3.1-source',
    sourceAssetFilename: 'web-ide-karel-0.3.1-source.tar.gz',
    releaseTag: 'web-ide-karel-v0.3.1',
    releaseAssetFilename: 'web-ide-karel-0.3.1.tgz',
    sbomFilename: 'web-ide-karel-0.3.1.cdx.json',
    webIDEVersion: '0.3.0',
  }),
  '0.3.2': Object.freeze({
    version: '0.3.2',
    capabilityReleaseIds: Object.freeze(['hamilton.python-karel/5']),
    sourceTag: 'web-ide-karel-v0.3.2-source-r3',
    sourceAssetFilename: 'web-ide-karel-0.3.2-source.tar.gz',
    releaseTag: 'web-ide-karel-v0.3.2',
    releaseAssetFilename: 'web-ide-karel-0.3.2.tgz',
    sbomFilename: 'web-ide-karel-0.3.2.cdx.json',
    webIDEVersion: '0.3.1',
  }),
  '0.3.3': Object.freeze({
    version: '0.3.3',
    capabilityReleaseIds: Object.freeze(['hamilton.python-karel/7']),
    sourceTag: 'web-ide-karel-v0.3.3-source',
    sourceAssetFilename: 'web-ide-karel-0.3.3-source.tar.gz',
    releaseTag: 'web-ide-karel-v0.3.3',
    releaseAssetFilename: 'web-ide-karel-0.3.3.tgz',
    sbomFilename: 'web-ide-karel-0.3.3.cdx.json',
    webIDEVersion: '0.4.0',
  }),
})

function artifactIdentity(version) {
  const identity = KAREL_ARTIFACT_IDENTITIES[version]
  if (!identity) throw new TypeError('Karel artifact manifest version is unsupported')
  return identity
}

function expectedReports(identity) {
  const reports = new Map([
    ['candidate-state', 'candidate-state.json'],
    ['cyclonedx-sbom', identity.sbomFilename],
    ['deterministic-builds', 'deterministic-builds.json'],
    ['license-inventory', 'license-inventory.json'],
    ['package-inspection', 'package-inspection.json'],
    ['third-party-license-text', 'THIRD_PARTY_LICENSES.txt'],
    ['validation-summary', 'validation-summary.json'],
    ['web-ide-candidate-verification', 'web-ide-candidate-verification.json'],
    ['web-ide-final-verification', 'web-ide-final-verification.json'],
  ])
  for (const gateId of EXPECTED_VALIDATION_GATES.keys()) {
    reports.set(`validation-log:${gateId}`, `validation-${gateId}.log`)
    reports.set(
      `validation-receipt:${gateId}`,
      `validation-${gateId}.receipt.json`,
    )
  }
  return reports
}

function assertPositiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${location} must be a positive safe integer`)
  }
}

function assertGitObject(value, location) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${location} must be a lowercase 40-character Git object ID`)
  }
}

function assertSourceFile(record, expectedName, location) {
  assertExactKeys(record, ['fileName', 'size', 'sha256'], [], location)
  if (record.fileName !== expectedName) {
    throw new TypeError(`${location} filename is wrong`)
  }
  assertPositiveInteger(record.size, `${location}.size`)
  assertSha256(record.sha256, `${location}.sha256`)
}

function assertFileEvidence(record, expectedKind, expectedName, location) {
  assertExactKeys(record, ['kind', 'fileName', 'size', 'sha256'], [], location)
  if (record.kind !== expectedKind || record.fileName !== expectedName) {
    throw new TypeError(`${location} identity is wrong`)
  }
  assertPositiveInteger(record.size, `${location}.size`)
  assertSha256(record.sha256, `${location}.sha256`)
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

async function evidenceFile(outputDirectory, kind, fileName) {
  if (fileName !== path.basename(fileName)) {
    throw new TypeError(`Unsafe evidence filename ${fileName}`)
  }
  const { size, digest } = await hashFile(path.join(outputDirectory, fileName))
  return { kind, fileName, size, sha256: digest }
}

export function validateArtifactManifest(manifest) {
  assertExactKeys(manifest, [
    'schemaVersion',
    'manifestKind',
    'manifestId',
    'capabilityReleaseIds',
    'packageRole',
    'package',
    'source',
    'build',
    'artifact',
    'webIDEPeer',
    'runtimeEvidence',
    'distribution',
    'reports',
  ], [], 'Karel artifact manifest')
  const identity = artifactIdentity(manifest.package?.version)
  const reportsContract = expectedReports(identity)
  if (
    manifest.schemaVersion !== 2
    || manifest.manifestKind !== 'hamilton-capability-package-artifact'
    || canonicalJSONString(manifest.capabilityReleaseIds)
      !== canonicalJSONString(identity.capabilityReleaseIds)
    || manifest.packageRole !== 'karel'
  ) throw new TypeError('Karel artifact manifest composition identity is wrong')
  assertExactKeys(manifest.package, [
    'name',
    'version',
    'private',
    'license',
    'exports',
    'peerDependencies',
    'manifest',
    'lockfile',
    'consumerManifest',
    'consumerLockfile',
    'packagedRuntimeFiles',
  ], [], 'Karel artifact manifest package')
  if (
    manifest.package.name !== '@web-ide/karel'
    || manifest.package.version !== identity.version
    || manifest.package.private !== true
    || manifest.package.license !== 'MIT'
    || canonicalJSONString(manifest.package.exports)
      !== canonicalJSONString(EXPECTED_EXPORTS)
    || canonicalJSONString(manifest.package.peerDependencies)
      !== canonicalJSONString(EXPECTED_PEERS_BY_VERSION[identity.version])
  ) throw new TypeError('Karel artifact manifest package contract is wrong')
  assertSourceFile(
    manifest.package.manifest,
    'package.json',
    'Karel artifact manifest package manifest',
  )
  assertSourceFile(
    manifest.package.lockfile,
    'package-lock.json',
    'Karel artifact manifest package lockfile',
  )
  assertSourceFile(
    manifest.package.consumerManifest,
    'tests/production/consumer/package.json',
    'Karel artifact manifest consumer manifest',
  )
  assertSourceFile(
    manifest.package.consumerLockfile,
    'tests/production/consumer/package-lock.json',
    'Karel artifact manifest consumer lockfile',
  )
  if (!Array.isArray(manifest.package.packagedRuntimeFiles)) {
    throw new TypeError('Karel packaged runtime file inventory must be an array')
  }
  const runtimePaths = []
  for (const [index, file] of manifest.package.packagedRuntimeFiles.entries()) {
    const location = `Karel packaged runtime files[${index}]`
    assertExactKeys(file, ['path', 'size', 'mode', 'sha256'], [], location)
    if (
      !file.path.startsWith('python/')
      && !file.path.startsWith('worlds/')
    ) throw new TypeError(`${location} is outside python/worlds`)
    assertPositiveInteger(file.size, `${location}.size`)
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new TypeError(`${location}.mode is invalid`)
    }
    assertSha256(file.sha256, `${location}.sha256`)
    runtimePaths.push(file.path)
  }
  if (
    JSON.stringify(runtimePaths) !== JSON.stringify([
      'python/karel.py',
      'python/karel_world_contract.py',
      'python/starter.py',
      'worlds/default.json',
    ])
  ) throw new TypeError('Karel packaged runtime file inventory is incomplete')
  assertExactKeys(manifest.source, [
    'repository',
    'branch',
    'commit',
    'tree',
    'tag',
    'archive',
  ], [], 'Karel artifact manifest source')
  if (
    manifest.source.repository
      !== 'https://github.com/justinvassantachart/web-ide-karel.git'
    || manifest.source.branch !== 'main'
  ) throw new TypeError('Karel artifact manifest source identity is wrong')
  assertGitObject(manifest.source.commit, 'Karel artifact manifest source commit')
  assertGitObject(manifest.source.tree, 'Karel artifact manifest source tree')
  assertExactKeys(manifest.source.tag, [
    'name',
    'objectId',
    'objectType',
    'peeledCommit',
  ], [], 'Karel artifact manifest source tag')
  assertGitObject(
    manifest.source.tag.objectId,
    'Karel artifact manifest source tag object',
  )
  if (
    manifest.source.tag.name !== identity.sourceTag
    || manifest.source.tag.objectType !== 'tag'
    || manifest.source.tag.peeledCommit !== manifest.source.commit
  ) throw new TypeError('Karel artifact manifest annotated source tag is wrong')
  assertFileEvidence(
    manifest.source.archive,
    'source-archive',
    identity.sourceAssetFilename,
    'Karel artifact manifest source archive',
  )
  assertExactKeys(manifest.build, [
    'node',
    'npm',
    'platform',
    'architecture',
    'osRelease',
    'sourceDateEpoch',
    'isolatedBuildCount',
    'reproducibilityResult',
    'installCommand',
    'packCommand',
  ], [], 'Karel artifact manifest build')
  if (
    manifest.build.node !== '24.11.1'
    || manifest.build.npm !== '11.6.2'
    || manifest.build.isolatedBuildCount !== 2
    || manifest.build.reproducibilityResult !== 'pass'
    || !Number.isSafeInteger(manifest.build.sourceDateEpoch)
    || manifest.build.sourceDateEpoch <= 0
  ) throw new TypeError('Karel artifact manifest build identity is wrong')
  for (const field of [
    'platform',
    'architecture',
    'osRelease',
    'installCommand',
    'packCommand',
  ]) {
    if (typeof manifest.build[field] !== 'string' || !manifest.build[field]) {
      throw new TypeError(`Karel artifact manifest build.${field} is empty`)
    }
  }
  assertExactKeys(manifest.artifact, [
    'kind',
    'fileName',
    'size',
    'sha256',
    'sha512Integrity',
  ], [], 'Karel artifact manifest artifact')
  if (
    manifest.artifact.kind !== 'package-tarball'
    || manifest.artifact.fileName !== identity.releaseAssetFilename
  ) throw new TypeError('Karel artifact manifest tarball identity is wrong')
  assertPositiveInteger(manifest.artifact.size, 'Karel artifact manifest tarball size')
  assertSha256(manifest.artifact.sha256, 'Karel artifact manifest tar SHA-256')
  assertSha512Integrity(
    manifest.artifact.sha512Integrity,
    'Karel artifact manifest tar integrity',
  )
  const { manifestId, ...identityInput } = manifest
  const expectedId = `urn:sha256:${sha256Bytes(Buffer.from(
    canonicalJSONString(identityInput),
  ))}`
  if (manifestId !== expectedId) {
    throw new TypeError('Karel artifact manifest ID is not its canonical content identity')
  }
  validateWebIDEEvidenceReport(manifest.webIDEPeer)
  if (
    manifest.webIDEPeer.package.version !== identity.webIDEVersion
    || manifest.webIDEPeer.consumerLock.binding !== 'exact'
    || manifest.webIDEPeer.nonFinalTestFixture
  ) throw new TypeError('Karel artifact manifest does not bind final Web IDE evidence')
  assertExactKeys(manifest.runtimeEvidence, [
    'ownerPackageRole',
    'ownership',
    'artifactManifestSha256',
    'reportFileName',
    'reportSha256',
  ], [], 'Karel artifact manifest runtime evidence')
  assertExactKeys(manifest.distribution, [
    'mechanism',
    'npmPublished',
    'repository',
    'intendedTag',
    'intendedAssets',
  ], [], 'Karel artifact manifest distribution')
  const expectedAssets = sortStrings([
    identity.releaseAssetFilename,
    identity.sourceAssetFilename,
    'artifact-manifest.json',
    'artifact-manifest.json.sha256',
    ...[...reportsContract.values()],
  ])
  if (
    manifest.distribution.mechanism !== 'private-github-release-assets'
    || manifest.distribution.npmPublished !== false
    || manifest.distribution.repository !== 'justinvassantachart/ths-ide'
    || manifest.distribution.intendedTag !== identity.releaseTag
    || JSON.stringify(manifest.distribution.intendedAssets)
      !== JSON.stringify(expectedAssets)
  ) throw new TypeError('Karel artifact manifest distribution identity is wrong')
  if (
    !Array.isArray(manifest.reports)
    || manifest.reports.length !== reportsContract.size
  ) {
    throw new TypeError('Karel artifact manifest reports are incomplete')
  }
  const kinds = manifest.reports.map((report) => report.kind)
  if (new Set(kinds).size !== kinds.length) {
    throw new TypeError('Karel artifact manifest has duplicate report kinds')
  }
  for (const [index, report] of manifest.reports.entries()) {
    assertExactKeys(report, ['kind', 'fileName', 'size', 'sha256'], [], `reports[${index}]`)
    if (reportsContract.get(report.kind) !== report.fileName) {
      throw new TypeError(`Karel artifact manifest report ${report.kind} is unexpected`)
    }
    assertPositiveInteger(report.size, `reports[${index}].size`)
    assertSha256(report.sha256, `reports[${index}].sha256`)
  }
  if (
    JSON.stringify(kinds) !== JSON.stringify(sortStrings(reportsContract.keys()))
  ) throw new TypeError('Karel artifact manifest report set is not exact and sorted')
  if (
    manifest.runtimeEvidence.ownerPackageRole !== 'web-ide'
    || manifest.runtimeEvidence.ownership !== 'referenced-not-duplicated'
    || manifest.runtimeEvidence.reportFileName
      !== 'runtime-assets-verification.json'
    || manifest.runtimeEvidence.artifactManifestSha256
      !== manifest.webIDEPeer.artifactManifest.sha256
    || manifest.runtimeEvidence.reportSha256
      !== manifest.webIDEPeer.runtimeEvidence.sha256
  ) throw new TypeError('Karel runtime evidence is not owned by the exact Web IDE peer')
  return manifest
}

export async function createArtifactManifest({
  outputDirectory,
  configuration,
  source,
  packageManifest,
  sourceFiles,
  inspection,
  determinism,
  webIDEEvidence,
}) {
  const identity = artifactIdentity(packageManifest.version)
  const evidenceNames = {
    'candidate-state': 'candidate-state.json',
    'cyclonedx-sbom': identity.sbomFilename,
    'deterministic-builds': 'deterministic-builds.json',
    'license-inventory': 'license-inventory.json',
    'package-inspection': 'package-inspection.json',
    'third-party-license-text': 'THIRD_PARTY_LICENSES.txt',
    'validation-summary': 'validation-summary.json',
    'web-ide-candidate-verification': 'web-ide-candidate-verification.json',
    'web-ide-final-verification': 'web-ide-final-verification.json',
  }
  for (const gateId of EXPECTED_VALIDATION_GATES.keys()) {
    evidenceNames[`validation-log:${gateId}`] = `validation-${gateId}.log`
    evidenceNames[`validation-receipt:${gateId}`]
      = `validation-${gateId}.receipt.json`
  }
  const reportResults = await Promise.allSettled(
    sortStrings(Object.keys(evidenceNames)).map(
      (kind) => evidenceFile(outputDirectory, kind, evidenceNames[kind]),
    ),
  )
  const reportFailures = reportResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (reportFailures.length > 0) {
    throw new AggregateError(
      reportFailures,
      'One or more Karel evidence reports could not be retained',
    )
  }
  const reports = reportResults.map((result) => result.value)
  const artifact = await evidenceFile(
    outputDirectory,
    'package-tarball',
    configuration.releaseAssetFilename,
  )
  artifact.sha512Integrity = inspection.tarball.sha512Integrity
  if (
    artifact.size !== inspection.tarball.size
    || artifact.sha256 !== inspection.tarball.sha256
  ) throw new TypeError('Final Karel tarball changed after package inspection')
  const archive = await evidenceFile(
    outputDirectory,
    'source-archive',
    configuration.sourceAssetFilename,
  )
  const packagedRuntimeFiles = inspection.files.filter((file) => (
    file.path.startsWith('python/') || file.path.startsWith('worlds/')
  ))
  const intendedAssets = sortStrings([
    configuration.releaseAssetFilename,
    configuration.sourceAssetFilename,
    'THIRD_PARTY_LICENSES.txt',
    'artifact-manifest.json',
    'artifact-manifest.json.sha256',
    'candidate-state.json',
    'deterministic-builds.json',
    'license-inventory.json',
    'package-inspection.json',
    'validation-summary.json',
    identity.sbomFilename,
    'web-ide-candidate-verification.json',
    'web-ide-final-verification.json',
    ...[...EXPECTED_VALIDATION_GATES.keys()].flatMap((gateId) => [
      `validation-${gateId}.log`,
      `validation-${gateId}.receipt.json`,
    ]),
  ])
  const manifestInput = {
    schemaVersion: 2,
    manifestKind: 'hamilton-capability-package-artifact',
    capabilityReleaseIds: identity.capabilityReleaseIds,
    packageRole: configuration.packageRole,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      private: packageManifest.private,
      license: packageManifest.license,
      exports: packageManifest.exports,
      peerDependencies: packageManifest.peerDependencies,
      manifest: sourceFiles.packageManifest,
      lockfile: sourceFiles.packageLock,
      consumerManifest: sourceFiles.consumerManifest,
      consumerLockfile: sourceFiles.consumerLock,
      packagedRuntimeFiles,
    },
    source: {
      repository: configuration.sourceRepository,
      branch: source.branch,
      commit: source.commit,
      tree: source.tree,
      tag: source.tag,
      archive,
    },
    build: {
      node: source.nodeVersion,
      npm: source.npmVersion,
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      sourceDateEpoch: source.sourceEpoch,
      isolatedBuildCount: determinism.isolatedBuildCount,
      reproducibilityResult: determinism.result,
      installCommand:
        'HOME=<isolated-home> TMPDIR=<isolated-tmp> npm_config_userconfig=<empty-userconfig> npm_config_globalconfig=<empty-globalconfig> npm ci --ignore-scripts --strict-peer-deps --engine-strict --no-audit --no-fund --cache <isolated-cache>',
      packCommand:
        'npm pack --json --ignore-scripts --pack-destination <external-directory>',
    },
    artifact,
    webIDEPeer: webIDEEvidence.report,
    runtimeEvidence: {
      ownerPackageRole: 'web-ide',
      ownership: 'referenced-not-duplicated',
      artifactManifestSha256:
        webIDEEvidence.report.artifactManifest.sha256,
      reportFileName: webIDEEvidence.report.runtimeEvidence.fileName,
      reportSha256: webIDEEvidence.report.runtimeEvidence.sha256,
    },
    distribution: {
      mechanism: 'private-github-release-assets',
      npmPublished: false,
      repository: configuration.releaseRepository,
      intendedTag: configuration.releaseTag,
      intendedAssets,
    },
    reports,
  }
  const manifest = {
    ...manifestInput,
    manifestId: `urn:sha256:${sha256Bytes(Buffer.from(
      canonicalJSONString(manifestInput),
    ))}`,
  }
  validateArtifactManifest(manifest)
  return manifest
}

export function sourceFileRecord(fileName, bytes) {
  return { fileName, size: bytes.length, sha256: sha256Bytes(bytes) }
}
