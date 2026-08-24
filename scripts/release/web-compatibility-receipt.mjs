import path from 'node:path'

import { validateCandidateState } from './candidate-evidence.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import { PACKAGE_TAR_LIMITS } from './package-inspection.mjs'
import {
  assertExactKeys,
  assertExternalInputFile,
  assertSha256,
  readBoundedFile,
  sha256Bytes,
} from './release-utils.mjs'
import { validateWebIDECandidateState } from './web-ide-candidate-evidence.mjs'

export const WEB_IDE_GATE_RECEIPT_PREFIX = '@@WEB_IDE_RELEASE_GATE_RECEIPT@@'

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
    || path.basename(tarballPath) !== 'web-ide-karel-0.2.0.tgz'
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
    || state.source.sourceReference !== 'web-ide-karel-v0.2.0-source-r3'
    || state.source.tag.name !== 'web-ide-karel-v0.2.0-source-r3'
    || state.source.tag.objectType !== 'tag'
    || !/^[a-f0-9]{40}$/u.test(state.source.tag.objectId)
    || state.source.tag.peeledCommit !== state.source.commit
    || state.source.worktreeClean !== true
  ) throw new TypeError('Karel compatibility candidate source is not final exact evidence')
  validateCandidateState(state, {
    configuration: {
      package: '@web-ide/karel@0.2.0',
      capabilityReleaseId: 'hamilton.python-karel/1',
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
    (item) => item.fileName === 'web-ide-karel-0.2.0.tgz',
  )
  if (
    artifact?.size !== tarballBytes.length
    || artifact.sha256 !== candidateSha256
  ) throw new TypeError('Karel compatibility tarball does not match candidate state')
  return { candidateSha256, sourceCommit: state.source.commit }
}

export async function webIDECompatibilityReceipt({
  candidateStatePath: candidateStateInput,
  tarballPath: tarballInput,
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
    || path.basename(tarballPath) !== 'web-ide-0.2.0.tgz'
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
  validateWebIDECandidateState(state, 'final')
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
    || state.package !== 'web-ide@0.2.0'
    || state.result !== 'candidate-generated'
    || state.capabilityReleaseId !== 'hamilton.python-karel/1'
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
    state.source.tag.name !== 'web-ide-v0.2.0-source-r3'
    || state.source.tag.objectType !== 'tag'
    || state.source.tag.peeledCommit !== state.source.commit
  ) throw new TypeError('Web IDE compatibility candidate tag is invalid')
  if (!Array.isArray(state.artifacts)) {
    throw new TypeError('Web IDE compatibility candidate artifacts must be an array')
  }
  const matches = state.artifacts.filter(
    (artifact) => artifact.fileName === 'web-ide-0.2.0.tgz',
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
    schemaVersion: 2,
    receiptKind: 'web-ide-release-validation-gate',
    mode: 'release-gate',
    package: 'web-ide@0.2.0',
    gateId: 'karel-compatibility',
    sourceCommit: state.source.commit,
    candidateSha256,
    command: 'Karel exact-candidate compatibility gate',
    exitCode: 0,
    emitter: 'karel:release-compatibility-gate@2',
  }
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

export function formatWebIDECompatibilityReceipt(receipt) {
  return `${WEB_IDE_GATE_RECEIPT_PREFIX}${canonicalJSONString(receipt)}`
}
