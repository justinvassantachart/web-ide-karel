import path from 'node:path'

import { validateCandidateState } from './candidate-evidence.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  inspectExistingPackedPackage,
  PACKAGE_TAR_LIMITS,
} from './package-inspection.mjs'
import {
  assertExactKeys,
  assertExternalInputFile,
  readBoundedFile,
  sha256Bytes,
} from './release-utils.mjs'
import { webIDEActiveCompatibilityReceipt } from './web-compatibility-receipt.mjs'

const ACTIVE_KAREL_IDENTITY = Object.freeze({
  package: '@web-ide/karel@0.3.3',
  capabilityReleaseId: 'hamilton.python-karel/8',
  packageRole: 'karel',
  sourceTag: 'web-ide-karel-v0.3.3-source-r3',
  releaseAssetFilename: 'web-ide-karel-0.3.3.tgz',
  version: '0.3.3',
})

async function verifyActiveKarelCandidate({ candidateStateInput, tarballInput }) {
  const candidateStatePath = await assertExternalInputFile(
    candidateStateInput,
    'Karel active compatibility candidate state',
  )
  const tarballPath = await assertExternalInputFile(
    tarballInput,
    'Karel active compatibility candidate tarball',
  )
  if (
    path.basename(candidateStatePath) !== 'candidate-state.json'
    || path.basename(tarballPath) !== ACTIVE_KAREL_IDENTITY.releaseAssetFilename
  ) throw new TypeError('Karel active compatibility inputs have unexpected filenames')

  const stateBytes = await readBoundedFile(
    candidateStatePath,
    4 * 1024 * 1024,
    'Karel active compatibility candidate state',
  )
  const state = JSON.parse(stateBytes.toString('utf8'))
  if (!stateBytes.equals(Buffer.from(canonicalJSONString(state)))) {
    throw new TypeError('Karel active compatibility candidate state is not canonical JSON')
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
  ], [], 'Karel active compatibility candidate source')
  assertExactKeys(state.source.tag, [
    'name', 'objectId', 'objectType', 'peeledCommit',
  ], [], 'Karel active compatibility candidate source tag')
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
    || state.source.sourceReference !== ACTIVE_KAREL_IDENTITY.sourceTag
    || state.source.tag.name !== ACTIVE_KAREL_IDENTITY.sourceTag
    || state.source.tag.objectType !== 'tag'
    || !/^[a-f0-9]{40}$/u.test(state.source.tag.objectId)
    || state.source.tag.peeledCommit !== state.source.commit
    || state.source.worktreeClean !== true
  ) throw new TypeError('Karel active compatibility source is not final exact evidence')

  validateCandidateState(state, {
    configuration: ACTIVE_KAREL_IDENTITY,
    source: state.source,
  })
  const tarballBytes = await readBoundedFile(
    tarballPath,
    PACKAGE_TAR_LIMITS.compressedBytes,
    'Karel active compatibility candidate tarball',
  )
  const candidateSha256 = sha256Bytes(tarballBytes)
  const artifacts = state.artifacts.filter(
    (item) => item.fileName === ACTIVE_KAREL_IDENTITY.releaseAssetFilename,
  )
  if (
    artifacts.length !== 1
    || artifacts[0].size !== tarballBytes.length
    || artifacts[0].sha256 !== candidateSha256
  ) throw new TypeError('Karel active compatibility tarball does not match candidate state')
  const inspection = inspectExistingPackedPackage(tarballBytes)
  if (inspection.manifest.version !== ACTIVE_KAREL_IDENTITY.version) {
    throw new TypeError('Karel active compatibility tarball version is wrong')
  }
  return {
    candidateSha256,
    sourceCommit: state.source.commit,
    sha512Integrity: inspection.report.tarball.sha512Integrity,
  }
}

export async function exactActivePairCompatibilityEvidence({
  webIDECandidateStatePath,
  webIDETarballPath,
  karelCandidateStatePath,
  karelTarballPath,
}) {
  const [webIDE, karel] = await Promise.all([
    webIDEActiveCompatibilityReceipt({
      candidateStatePath: webIDECandidateStatePath,
      tarballPath: webIDETarballPath,
    }),
    verifyActiveKarelCandidate({
      candidateStateInput: karelCandidateStatePath,
      tarballInput: karelTarballPath,
    }),
  ])
  return { receipt: webIDE.receipt, webIDE, karel }
}
