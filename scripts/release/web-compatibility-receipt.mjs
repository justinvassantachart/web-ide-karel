import path from 'node:path'

import { validateArtifactManifest } from './artifact-manifest.mjs'
import { validateCandidateState } from './candidate-evidence.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  inspectExistingPackedPackage,
  PACKAGE_TAR_LIMITS,
} from './package-inspection.mjs'
import {
  assertExactKeys,
  assertExternalInputFile,
  assertSha256,
  readBoundedFile,
  sha256Bytes,
  sha512IntegrityBytes,
} from './release-utils.mjs'
import {
  validateWebIDECandidateState,
  WEB_IDE_CANDIDATE_IDENTITIES,
} from './web-ide-candidate-evidence.mjs'

export const WEB_IDE_GATE_RECEIPT_PREFIX = '@@WEB_IDE_RELEASE_GATE_RECEIPT@@'
export const WEB_IDE_SUCCESSOR_COMPATIBILITY_EMITTER
  = 'karel:release-compatibility-gate@2'

const IMMUTABLE_KAREL_0_3_1 = Object.freeze({
  artifactManifestSha256:
    '5af9f17bb1066dd30a4076070058e2e1a549f4ebe26606d04806a1240ed4e447',
  candidateStateSha256:
    '0512207c78241671d680294b590ab79c307f06193b736c0434e3247b3fed091b',
  releaseReceiptSha256:
    'aa3618ccd27ddd9ce030f8011f033001bbbcbd0957837c2aa8b5690aa60df7c9',
  sourceCommit: '95c624bf934fc74f0e6f2a2054d930d61a400c64',
  tarballSha256:
    '3fde31c60fe7f637282ce1b7020a851fa710ca2cfbd2484c8b932fe2fde84e0b',
})

async function verifyImmutableKarelRelease({
  artifactManifestInput,
  candidateStateInput,
  releaseReceiptInput,
  tarballInput,
}) {
  const candidate = await verifyKarelCompatibilityCandidate({
    candidateStateInput,
    tarballInput,
  })
  const artifactManifestPath = await assertExternalInputFile(
    artifactManifestInput,
    'Karel compatibility artifact manifest',
  )
  const releaseReceiptPath = await assertExternalInputFile(
    releaseReceiptInput,
    'Karel compatibility release receipt',
  )
  const tarballPath = await assertExternalInputFile(
    tarballInput,
    'Karel compatibility release tarball',
  )
  const candidateStatePath = await assertExternalInputFile(
    candidateStateInput,
    'Karel compatibility candidate state',
  )
  if (
    path.basename(artifactManifestPath) !== 'artifact-manifest.json'
    || path.basename(candidateStatePath) !== 'candidate-state.json'
    || path.basename(releaseReceiptPath) !== 'release-receipt.json'
    || path.basename(tarballPath) !== 'web-ide-karel-0.3.1.tgz'
  ) throw new TypeError('Karel immutable release inputs have unexpected filenames')
  const [artifactManifestBytes, candidateStateBytes, releaseReceiptBytes,
    tarballBytes] = await Promise.all([
    readBoundedFile(
      artifactManifestPath,
      4 * 1024 * 1024,
      'Karel compatibility artifact manifest',
    ),
    readBoundedFile(
      candidateStatePath,
      4 * 1024 * 1024,
      'Karel compatibility candidate state',
    ),
    readBoundedFile(
      releaseReceiptPath,
      16 * 1024 * 1024,
      'Karel compatibility release receipt',
    ),
    readBoundedFile(
      tarballPath,
      PACKAGE_TAR_LIMITS.compressedBytes,
      'Karel compatibility release tarball',
    ),
  ])
  if (
    sha256Bytes(artifactManifestBytes)
      !== IMMUTABLE_KAREL_0_3_1.artifactManifestSha256
    || sha256Bytes(candidateStateBytes)
      !== IMMUTABLE_KAREL_0_3_1.candidateStateSha256
    || sha256Bytes(releaseReceiptBytes)
      !== IMMUTABLE_KAREL_0_3_1.releaseReceiptSha256
  ) throw new TypeError('Karel compatibility evidence is not the immutable 0.3.1 release')
  const artifactManifest = JSON.parse(artifactManifestBytes.toString('utf8'))
  if (!artifactManifestBytes.equals(Buffer.from(canonicalJSONString(artifactManifest)))) {
    throw new TypeError('Karel compatibility artifact manifest is not canonical JSON')
  }
  validateArtifactManifest(artifactManifest)
  const inspection = inspectExistingPackedPackage(tarballBytes)
  const candidateStateReport = artifactManifest.reports.find(
    (report) => report.kind === 'candidate-state',
  )
  if (
    inspection.report.tarball.size !== artifactManifest.artifact.size
    || inspection.report.tarball.sha256 !== artifactManifest.artifact.sha256
    || inspection.report.tarball.sha512Integrity
      !== artifactManifest.artifact.sha512Integrity
    || inspection.report.tarball.sha256 !== IMMUTABLE_KAREL_0_3_1.tarballSha256
    || candidateStateReport?.size !== candidateStateBytes.length
    || candidateStateReport.sha256 !== sha256Bytes(candidateStateBytes)
    || artifactManifest.source.commit !== IMMUTABLE_KAREL_0_3_1.sourceCommit
  ) throw new TypeError('Karel compatibility tarball is not the immutable 0.3.1 release')
  return {
    ...candidate,
    sha512Integrity: inspection.report.tarball.sha512Integrity,
  }
}

async function verifyKarelCompatibilityCandidate({
  candidateStateInput,
  tarballInput,
}) {
  const candidateStatePath = await assertExternalInputFile(
    candidateStateInput,
    'Karel compatibility candidate state',
  )
  const tarballPath = await assertExternalInputFile(
    tarballInput,
    'Karel compatibility candidate tarball',
  )
  if (
    path.basename(candidateStatePath) !== 'candidate-state.json'
    || path.basename(tarballPath) !== 'web-ide-karel-0.3.1.tgz'
  ) throw new TypeError('Karel compatibility inputs have unexpected filenames')
  const stateBytes = await readBoundedFile(
    candidateStatePath,
    4 * 1024 * 1024,
    'Karel compatibility candidate state',
  )
  const state = JSON.parse(stateBytes.toString('utf8'))
  if (!stateBytes.equals(Buffer.from(canonicalJSONString(state)))) {
    throw new TypeError('Karel compatibility candidate state is not canonical JSON')
  }
  assertExactKeys(state.source, [
    'branch',
    'commit',
    'tree',
    'remote',
    'nodeVersion',
    'npmVersion',
    'sourceEpoch',
    'finalEligible',
    'sourceReference',
    'tag',
    'worktreeClean',
  ], [], 'Karel compatibility candidate source')
  assertExactKeys(state.source.tag, [
    'name', 'objectId', 'objectType', 'peeledCommit',
  ], [], 'Karel compatibility candidate source tag')
  if (
    state.source.branch !== 'main'
    || !/^[a-f0-9]{40}$/u.test(state.source.commit)
    || !/^[a-f0-9]{40}$/u.test(state.source.tree)
    || state.source.remote
      !== 'https://github.com/justinvassantachart/web-ide-karel.git'
    || state.source.nodeVersion !== '24.11.1'
    || state.source.npmVersion !== '11.6.2'
    || !Number.isSafeInteger(state.source.sourceEpoch)
    || state.source.sourceEpoch <= 0
    || state.source.finalEligible !== true
    || state.source.sourceReference !== 'web-ide-karel-v0.3.1-source'
    || state.source.tag.name !== 'web-ide-karel-v0.3.1-source'
    || state.source.tag.objectType !== 'tag'
    || !/^[a-f0-9]{40}$/u.test(state.source.tag.objectId)
    || state.source.tag.peeledCommit !== state.source.commit
    || state.source.worktreeClean !== true
  ) throw new TypeError('Karel compatibility candidate source is not final exact evidence')
  validateCandidateState(state, {
    configuration: {
      package: '@web-ide/karel@0.3.1',
      capabilityReleaseId: 'hamilton.python-karel/3',
      packageRole: 'karel',
    },
    source: state.source,
  })
  const tarballBytes = await readBoundedFile(
    tarballPath,
    PACKAGE_TAR_LIMITS.compressedBytes,
    'Karel compatibility candidate tarball',
  )
  const candidateSha256 = sha256Bytes(tarballBytes)
  const artifact = state.artifacts.find(
    (item) => item.fileName === 'web-ide-karel-0.3.1.tgz',
  )
  if (
    artifact?.size !== tarballBytes.length
    || artifact.sha256 !== candidateSha256
  ) throw new TypeError('Karel compatibility tarball does not match candidate state')
  return {
    candidateSha256,
    sourceCommit: state.source.commit,
  }
}

async function webIDECompatibilityReceiptForIdentity({
  candidateStatePath: candidateStateInput,
  tarballPath: tarballInput,
  identity,
  emitter,
}) {
  const candidateStatePath = await assertExternalInputFile(
    candidateStateInput,
    'Web IDE compatibility candidate state',
  )
  const tarballPath = await assertExternalInputFile(
    tarballInput,
    'Web IDE compatibility candidate tarball',
  )
  if (
    path.basename(candidateStatePath) !== 'candidate-state.json'
    || path.basename(tarballPath) !== identity.releaseAssetFilename
  ) throw new TypeError('Web IDE compatibility inputs have unexpected filenames')
  const stateBytes = await readBoundedFile(
    candidateStatePath,
    4 * 1024 * 1024,
    'Web IDE compatibility candidate state',
  )
  const state = JSON.parse(stateBytes.toString('utf8'))
  if (!stateBytes.equals(Buffer.from(canonicalJSONString(state)))) {
    throw new TypeError('Web IDE compatibility candidate state is not canonical JSON')
  }
  if (state.result !== 'candidate-generated' || 'preflightFixture' in state) {
    throw new TypeError(
      'Web IDE production compatibility receipt requires candidate-generated final state',
    )
  }
  validateWebIDECandidateState(state, 'final', identity.sourceTag, identity)
  assertExactKeys(state, [
    'schemaVersion',
    'package',
    'result',
    'source',
    'capabilityReleaseId',
    'packageRole',
    'artifacts',
  ], [], 'Web IDE candidate state')
  if (
    state.schemaVersion !== 1
    || state.package !== identity.package
    || state.result !== 'candidate-generated'
    || state.capabilityReleaseId !== identity.capabilityReleaseId
    || state.packageRole !== 'web-ide'
  ) throw new TypeError('Web IDE compatibility candidate identity is wrong')
  assertExactKeys(state.source, [
    'branch',
    'commit',
    'tree',
    'tag',
    'remote',
    'commitTimestamp',
    'sourceDateEpoch',
    'nodeVersion',
    'npmVersion',
  ], [], 'Web IDE compatibility candidate source')
  if (
    state.source.branch !== 'main'
    || !/^[a-f0-9]{40}$/u.test(state.source.commit)
  ) throw new TypeError('Web IDE compatibility candidate source is invalid')
  assertExactKeys(state.source.tag, [
    'name', 'objectId', 'objectType', 'peeledCommit',
  ], [], 'Web IDE compatibility candidate tag')
  if (
    state.source.tag.name !== identity.sourceTag
    || state.source.tag.objectType !== 'tag'
    || state.source.tag.peeledCommit !== state.source.commit
  ) throw new TypeError('Web IDE compatibility candidate tag is invalid')
  if (!Array.isArray(state.artifacts)) {
    throw new TypeError('Web IDE compatibility candidate artifacts must be an array')
  }
  const matches = state.artifacts.filter(
    (artifact) => artifact.fileName === identity.releaseAssetFilename,
  )
  if (matches.length !== 1) {
    throw new TypeError('Web IDE compatibility candidate has no unique package artifact')
  }
  const artifact = matches[0]
  assertExactKeys(artifact, ['fileName', 'size', 'sha256'], [], 'Web IDE compatibility artifact')
  assertSha256(artifact.sha256, 'Web IDE compatibility artifact SHA-256')
  const tarballBytes = await readBoundedFile(
    tarballPath,
    PACKAGE_TAR_LIMITS.compressedBytes,
    'Web IDE compatibility candidate tarball',
  )
  const candidateSha256 = sha256Bytes(tarballBytes)
  if (artifact.size !== tarballBytes.length || artifact.sha256 !== candidateSha256) {
    throw new TypeError('Web IDE compatibility tarball does not match candidate state')
  }
  return {
    receipt: {
      schemaVersion: 2,
      receiptKind: 'web-ide-release-validation-gate',
      mode: 'release-gate',
      package: identity.package,
      gateId: 'karel-compatibility',
      sourceCommit: state.source.commit,
      candidateSha256,
      command: 'Karel exact-candidate compatibility gate',
      exitCode: 0,
      emitter,
    },
    sha512Integrity: sha512IntegrityBytes(tarballBytes),
  }
}

export async function webIDECompatibilityReceipt(inputs) {
  return (await webIDECompatibilityReceiptForIdentity({
    ...inputs,
    identity: WEB_IDE_CANDIDATE_IDENTITIES['0.3.0'],
    emitter: 'karel:release-compatibility-gate@2',
  })).receipt
}

export async function webIDESuccessorCompatibilityReceipt(inputs) {
  return await webIDECompatibilityReceiptForIdentity({
    ...inputs,
    identity: WEB_IDE_CANDIDATE_IDENTITIES['0.3.1'],
    emitter: WEB_IDE_SUCCESSOR_COMPATIBILITY_EMITTER,
  })
}

export async function exactPairCompatibilityEvidence({
  webIDECandidateStatePath,
  webIDETarballPath,
  karelCandidateStatePath,
  karelTarballPath,
}) {
  const [receipt, karel] = await Promise.all([
    webIDECompatibilityReceipt({
      candidateStatePath: webIDECandidateStatePath,
      tarballPath: webIDETarballPath,
    }),
    verifyKarelCompatibilityCandidate({
      candidateStateInput: karelCandidateStatePath,
      tarballInput: karelTarballPath,
    }),
  ])
  return { receipt, karel }
}

export async function exactSuccessorPairCompatibilityEvidence({
  webIDECandidateStatePath,
  webIDETarballPath,
  karelArtifactManifestPath,
  karelCandidateStatePath,
  karelReleaseReceiptPath,
  karelTarballPath,
}) {
  const [webIDE, karel] = await Promise.all([
    webIDESuccessorCompatibilityReceipt({
      candidateStatePath: webIDECandidateStatePath,
      tarballPath: webIDETarballPath,
    }),
    verifyImmutableKarelRelease({
      artifactManifestInput: karelArtifactManifestPath,
      candidateStateInput: karelCandidateStatePath,
      releaseReceiptInput: karelReleaseReceiptPath,
      tarballInput: karelTarballPath,
    }),
  ])
  return { receipt: webIDE.receipt, webIDE, karel }
}

export function formatWebIDECompatibilityReceipt(receipt) {
  return `${WEB_IDE_GATE_RECEIPT_PREFIX}${canonicalJSONString(receipt)}`
}
