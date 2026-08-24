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
import { validateWebIDERuntimeReport } from './web-ide-evidence.mjs'

const WEB_CANDIDATE_ARTIFACTS = [
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

function assertPositiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${location} must be a positive safe integer`)
  }
}

function assertGitObject(value, location) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${location} must be a lowercase 40-character Git object ID`)
  }
}

function validateSource(source, sourceTag) {
  assertExactKeys(source, [
    'branch',
    'commit',
    'tree',
    'tag',
    'remote',
    'commitTimestamp',
    'sourceDateEpoch',
    'nodeVersion',
    'npmVersion',
  ], [], 'Web IDE candidate source')
  if (source.branch !== 'main') throw new TypeError('Web IDE candidate source is not main')
  assertGitObject(source.commit, 'Web IDE candidate source commit')
  assertGitObject(source.tree, 'Web IDE candidate source tree')
  assertNonEmptyString(source.remote, 'Web IDE candidate source remote')
  assertPositiveSafeInteger(
    source.commitTimestamp,
    'Web IDE candidate source commit timestamp',
  )
  if (source.sourceDateEpoch !== String(source.commitTimestamp)) {
    throw new TypeError('Web IDE candidate source date epoch is not exact')
  }
  assertNonEmptyString(source.nodeVersion, 'Web IDE candidate Node version')
  assertNonEmptyString(source.npmVersion, 'Web IDE candidate npm version')
  assertExactKeys(source.tag, [
    'name',
    'objectId',
    'objectType',
    'peeledCommit',
  ], [], 'Web IDE candidate source tag')
  assertGitObject(source.tag.objectId, 'Web IDE candidate tag object')
  assertGitObject(source.tag.peeledCommit, 'Web IDE candidate peeled tag commit')
  if (
    source.tag.name !== sourceTag
    || source.tag.objectType !== 'tag'
    || source.tag.peeledCommit !== source.commit
  ) throw new TypeError('Web IDE candidate source tag is not the exact annotated tag at HEAD')
  return source
}

export function validateWebIDECandidateState(
  state,
  mode,
  sourceTag = 'web-ide-v0.3.0-source',
) {
  assertExactKeys(state, [
    'schemaVersion',
    'package',
    'result',
    'source',
    'capabilityReleaseId',
    'packageRole',
    'artifacts',
  ], mode === 'test' ? ['preflightFixture'] : [], 'Web IDE candidate state')
  const permittedResult = mode === 'final'
    ? 'candidate-generated'
    : ['candidate-generated', 'nonrelease-preflight']
  const resultMatches = Array.isArray(permittedResult)
    ? permittedResult.includes(state.result)
    : state.result === permittedResult
  if (
    state.schemaVersion !== 1
    || state.package !== 'web-ide@0.3.0'
    || !resultMatches
    || state.capabilityReleaseId !== 'hamilton.python-karel/2'
    || state.packageRole !== 'web-ide'
  ) throw new TypeError('Web IDE candidate state identity is not eligible')
  if (state.result === 'nonrelease-preflight') {
    assertExactKeys(state.preflightFixture, [
      'mode',
      'remote',
      'finalizable',
    ], [], 'Web IDE candidate preflight fixture')
    if (
      state.preflightFixture.mode !== 'disposable-local-remote'
      || typeof state.preflightFixture.remote !== 'string'
      || !path.isAbsolute(state.preflightFixture.remote)
      || state.preflightFixture.finalizable !== false
      || state.source.remote !== state.preflightFixture.remote
    ) throw new TypeError('Web IDE candidate preflight fixture identity is wrong')
  } else if ('preflightFixture' in state) {
    throw new TypeError('Final Web IDE candidate state cannot contain preflightFixture')
  } else if (
    state.source.remote
      !== 'https://github.com/justinvassantachart/web-ide.git'
  ) {
    throw new TypeError('Final Web IDE candidate source repository is wrong')
  }
  validateSource(state.source, sourceTag)
  if (!Array.isArray(state.artifacts) || state.artifacts.length !== 10) {
    throw new TypeError('Web IDE candidate state artifact set is incomplete')
  }
  const names = []
  for (const [index, artifact] of state.artifacts.entries()) {
    const location = `Web IDE candidate state artifacts[${index}]`
    assertExactKeys(artifact, [
      'fileName',
      'size',
      'sha256',
    ], [], location)
    if (artifact.fileName !== path.basename(artifact.fileName)) {
      throw new TypeError(`${location}.fileName is unsafe`)
    }
    assertPositiveSafeInteger(artifact.size, `${location}.size`)
    assertSha256(artifact.sha256, `${location}.sha256`)
    names.push(artifact.fileName)
  }
  if (
    JSON.stringify(names) !== JSON.stringify(WEB_CANDIDATE_ARTIFACTS)
    || JSON.stringify(names) !== JSON.stringify(sortStrings(names))
    || new Set(names).size !== names.length
  ) throw new TypeError('Web IDE candidate state artifacts are not exact and sorted')
  return state
}

function inspectWebIDETarball(bytes) {
  const entries = readPackageTarball(bytes)
  for (const entry of entries) {
    scanPackedTextEntry(entry, { packageKind: 'web-ide' })
  }
  const files = new Map(entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => [entry.path, entry]))
  const manifest = JSON.parse(files.get('package.json')?.bytes.toString('utf8') ?? 'null')
  if (
    manifest?.name !== 'web-ide'
    || manifest.version !== '0.3.0'
    || manifest.private !== true
    || manifest.license !== 'MIT'
    || !files.has('LICENSE.md')
  ) throw new TypeError('Web IDE candidate tarball package identity or license is wrong')
  return { entries, licenseEntry: files.get('LICENSE.md') }
}

function validateWebIDEPackageInspection(report, tarballBytes, entries) {
  assertExactKeys(report, [
    'schemaVersion', 'package', 'result', 'tarball', 'checks', 'files',
  ], [], 'Web IDE package inspection')
  assertExactKeys(report.tarball, [
    'filename', 'size', 'sha256', 'sha512Integrity',
  ], [], 'Web IDE package inspection tarball')
  assertExactKeys(report.checks, [
    'npmPackJsonMatched',
    'regularFilesOnly',
    'pathsSafeAndCaseUnique',
    'privatePackage',
    'exportsResolved',
    'licenseFilesPresent',
    'internalPathAndSecretScanPassed',
    'bundledDependenciesAbsent',
  ], [], 'Web IDE package inspection checks')
  if (
    report.schemaVersion !== 1
    || report.package !== 'web-ide@0.3.0'
    || report.result !== 'pass'
    || Object.values(report.checks).some((value) => value !== true)
    || report.tarball.filename !== 'web-ide-0.3.0.tgz'
    || report.tarball.size !== tarballBytes.length
    || report.tarball.sha256 !== sha256Bytes(tarballBytes)
    || report.tarball.sha512Integrity !== sha512IntegrityBytes(tarballBytes)
  ) throw new TypeError('Web IDE package inspection identity or checks are wrong')
  if (!Array.isArray(report.files)) {
    throw new TypeError('Web IDE package inspection files must be an array')
  }
  const actualFiles = entries.map(({ path: filePath, size, mode, sha256 }) => ({
    path: filePath,
    size,
    mode,
    sha256,
  })).sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))
  if (canonicalJSONString(report.files) !== canonicalJSONString(actualFiles)) {
    throw new TypeError('Web IDE package inspection inventory differs from its tarball')
  }
  return report
}

export function validateWebIDECandidateReport(report, configuration) {
  assertExactKeys(report, [
    'schemaVersion',
    'result',
    'capabilityReleaseId',
    'packageRole',
    'package',
    'candidateState',
    'artifact',
    'runtimeEvidence',
    'consumerLock',
    'nonFinalTestFixture',
  ], [], 'Web IDE candidate verification report')
  if (
    report.schemaVersion !== 1
    || report.result !== 'pass'
    || report.capabilityReleaseId !== 'hamilton.python-karel/2'
    || report.packageRole !== 'web-ide-peer-candidate'
    || typeof report.nonFinalTestFixture !== 'boolean'
  ) throw new TypeError('Web IDE candidate verification report identity is wrong')
  assertExactKeys(report.package, [
    'name',
    'version',
    'peerRange',
    'license',
  ], [], 'Web IDE candidate verification package')
  if (
    report.package.name !== 'web-ide'
    || report.package.version !== '0.3.0'
    || report.package.peerRange
      !== (configuration?.webIDE.peerRange ?? '>=0.3.0 <0.4.0')
    || report.package.license !== 'MIT'
  ) throw new TypeError('Web IDE candidate verification package is wrong')
  assertExactKeys(report.candidateState, [
    'fileName',
    'size',
    'sha256',
    'result',
    'source',
  ], [], 'Web IDE candidate verification state')
  if (
    report.candidateState.fileName !== 'candidate-state.json'
    || !['candidate-generated', 'nonrelease-preflight'].includes(
      report.candidateState.result,
    )
  ) throw new TypeError('Web IDE candidate verification state identity is wrong')
  assertPositiveSafeInteger(
    report.candidateState.size,
    'Web IDE candidate verification state size',
  )
  assertSha256(
    report.candidateState.sha256,
    'Web IDE candidate verification state SHA-256',
  )
  assertExactKeys(report.candidateState.source, [
    'repository',
    'commit',
    'tree',
    'tag',
  ], [], 'Web IDE candidate verification source')
  assertNonEmptyString(
    report.candidateState.source.repository,
    'Web IDE candidate verification repository',
  )
  assertGitObject(
    report.candidateState.source.commit,
    'Web IDE candidate verification commit',
  )
  assertGitObject(
    report.candidateState.source.tree,
    'Web IDE candidate verification tree',
  )
  if (
    report.candidateState.source.tag
      !== (configuration?.webIDE.sourceTag ?? 'web-ide-v0.3.0-source')
  ) {
    throw new TypeError('Web IDE candidate verification tag is wrong')
  }
  assertExactKeys(report.artifact, [
    'fileName',
    'size',
    'sha256',
    'sha512Integrity',
  ], [], 'Web IDE candidate verification artifact')
  if (report.artifact.fileName !== 'web-ide-0.3.0.tgz') {
    throw new TypeError('Web IDE candidate verification artifact filename is wrong')
  }
  assertPositiveSafeInteger(
    report.artifact.size,
    'Web IDE candidate verification artifact size',
  )
  assertSha256(
    report.artifact.sha256,
    'Web IDE candidate verification artifact SHA-256',
  )
  if (
    typeof report.artifact.sha512Integrity !== 'string'
    || !report.artifact.sha512Integrity.startsWith('sha512-')
  ) throw new TypeError('Web IDE candidate verification artifact SRI is wrong')
  assertExactKeys(report.runtimeEvidence, [
    'ownerPackageRole',
    'fileName',
    'size',
    'sha256',
    'verifiedAssetCount',
  ], [], 'Web IDE candidate runtime evidence')
  if (
    report.runtimeEvidence.ownerPackageRole !== 'web-ide'
    || report.runtimeEvidence.fileName !== 'runtime-assets-verification.json'
  ) throw new TypeError('Web IDE candidate runtime evidence ownership is wrong')
  assertPositiveSafeInteger(
    report.runtimeEvidence.size,
    'Web IDE candidate runtime evidence size',
  )
  assertSha256(
    report.runtimeEvidence.sha256,
    'Web IDE candidate runtime evidence SHA-256',
  )
  assertPositiveSafeInteger(
    report.runtimeEvidence.verifiedAssetCount,
    'Web IDE candidate runtime asset count',
  )
  assertExactKeys(report.consumerLock, [
    'reference',
    'integrity',
    'binding',
  ], [], 'Web IDE candidate consumer lock')
  if (
    report.consumerLock.reference !== 'file:artifacts/web-ide.tgz'
    || !['exact', 'pending-final-web-regeneration'].includes(
      report.consumerLock.binding,
    )
  ) throw new TypeError('Web IDE candidate consumer lock identity is wrong')
  return report
}

export async function verifyWebIDECandidateEvidence({
  configuration,
  candidateStatePath,
  tarballPath,
  consumerLock,
  mode,
}) {
  if (path.basename(candidateStatePath) !== 'candidate-state.json') {
    throw new TypeError('Web IDE candidate-state filename is not exact')
  }
  if (path.basename(tarballPath) !== configuration.webIDE.releaseAssetFilename) {
    throw new TypeError('Web IDE candidate filename is not exact')
  }
  const stateBytes = await readBoundedFile(
    candidateStatePath,
    4 * 1024 * 1024,
    'Web IDE candidate state',
  )
  const state = JSON.parse(stateBytes.toString('utf8'))
  if (!stateBytes.equals(Buffer.from(canonicalJSONString(state)))) {
    throw new TypeError('Web IDE candidate state is not canonical JSON')
  }
  validateWebIDECandidateState(state, mode, configuration.webIDE.sourceTag)
  const artifactByName = new Map(state.artifacts.map((artifact) => [
    artifact.fileName,
    artifact,
  ]))

  const tarballBytes = await readBoundedFile(
    tarballPath,
    PACKAGE_TAR_LIMITS.compressedBytes,
    'Web IDE candidate tarball',
  )
  const tarballRecord = artifactByName.get(configuration.webIDE.releaseAssetFilename)
  const tarballSha256 = sha256Bytes(tarballBytes)
  const tarballSRI = sha512IntegrityBytes(tarballBytes)
  if (
    tarballRecord.size !== tarballBytes.length
    || tarballRecord.sha256 !== tarballSha256
  ) throw new TypeError('Web IDE tarball does not match its canonical candidate state')
  const tarball = inspectWebIDETarball(tarballBytes)

  const inspectionRecord = artifactByName.get('package-inspection.json')
  const inspectionPath = await assertExternalInputFile(
    path.join(path.dirname(candidateStatePath), 'package-inspection.json'),
    'Web IDE package inspection',
  )
  const inspectionBytes = await readBoundedFile(
    inspectionPath,
    16 * 1024 * 1024,
    'Web IDE package inspection',
  )
  if (
    inspectionRecord.size !== inspectionBytes.length
    || inspectionRecord.sha256 !== sha256Bytes(inspectionBytes)
  ) throw new TypeError('Web IDE package inspection does not match candidate state')
  const inspection = JSON.parse(inspectionBytes.toString('utf8'))
  if (!inspectionBytes.equals(Buffer.from(canonicalJSONString(inspection)))) {
    throw new TypeError('Web IDE package inspection is not canonical JSON')
  }
  validateWebIDEPackageInspection(inspection, tarballBytes, tarball.entries)

  const runtimeRecord = artifactByName.get(configuration.webIDE.runtimeEvidenceFilename)
  const runtimePath = path.join(
    path.dirname(candidateStatePath),
    configuration.webIDE.runtimeEvidenceFilename,
  )
  const runtimeBytes = await readBoundedFile(
    runtimePath,
    16 * 1024 * 1024,
    'Web IDE runtime report',
  )
  if (
    runtimeRecord.size !== runtimeBytes.length
    || runtimeRecord.sha256 !== sha256Bytes(runtimeBytes)
  ) throw new TypeError('Web IDE runtime report does not match its candidate state')
  const runtime = JSON.parse(runtimeBytes.toString('utf8'))
  if (!runtimeBytes.equals(Buffer.from(canonicalJSONString(runtime)))) {
    throw new TypeError('Web IDE runtime report is not canonical JSON')
  }
  validateWebIDERuntimeReport(runtime)

  const lockValidation = validateProductionConsumerLock(consumerLock, {
    webIDEIntegrity: tarballSRI,
    requireWebIDEIntegrity: mode === 'final',
  })
  const lockEntry = lockValidation.webIDE
  const lockMatchesArtifact = lockEntry.binding === 'exact'
  if (mode === 'final' && !lockMatchesArtifact) {
    throw new TypeError('Packed consumer lock is not bound to the final Web IDE candidate')
  }

  const report = {
    schemaVersion: 1,
    result: 'pass',
    capabilityReleaseId: configuration.capabilityReleaseId,
    packageRole: 'web-ide-peer-candidate',
    package: {
      name: 'web-ide',
      version: '0.3.0',
      peerRange: configuration.webIDE.peerRange,
      license: 'MIT',
    },
    candidateState: {
      fileName: 'candidate-state.json',
      size: stateBytes.length,
      sha256: sha256Bytes(stateBytes),
      result: state.result,
      source: {
        repository: state.source.remote,
        commit: state.source.commit,
        tree: state.source.tree,
        tag: state.source.tag.name,
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
      fileName: configuration.webIDE.runtimeEvidenceFilename,
      size: runtimeBytes.length,
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
    nonFinalTestFixture: state.result !== 'candidate-generated',
  }
  validateWebIDECandidateReport(report, configuration)
  return {
    entries: tarball.entries,
    licenseEntry: tarball.licenseEntry,
    report,
  }
}
