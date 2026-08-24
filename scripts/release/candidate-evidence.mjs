import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertSha256,
  sortStrings,
} from './release-utils.mjs'

export const CANDIDATE_ARTIFACT_FILES = Object.freeze([
  'THIRD_PARTY_LICENSES.txt',
  'deterministic-builds.json',
  'license-inventory.json',
  'package-inspection.json',
  'web-ide-candidate-verification.json',
  'web-ide-karel-0.3.0-source.tar.gz',
  'web-ide-karel-0.3.0.cdx.json',
  'web-ide-karel-0.3.0.tgz',
])

const CANDIDATE_ARTIFACT_MAX_BYTES = new Map([
  ['THIRD_PARTY_LICENSES.txt', 32 * 1024 * 1024],
  ['deterministic-builds.json', 4 * 1024 * 1024],
  ['license-inventory.json', 32 * 1024 * 1024],
  ['package-inspection.json', 32 * 1024 * 1024],
  ['web-ide-candidate-verification.json', 4 * 1024 * 1024],
  ['web-ide-karel-0.3.0-source.tar.gz', 128 * 1024 * 1024],
  ['web-ide-karel-0.3.0.cdx.json', 32 * 1024 * 1024],
  ['web-ide-karel-0.3.0.tgz', 64 * 1024 * 1024],
])

function assertPositiveSafeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${location} must be a positive safe integer`)
  }
}

export function validateCandidateState(state, { configuration, source }) {
  assertExactKeys(state, [
    'schemaVersion',
    'package',
    'result',
    'mode',
    'source',
    'capabilityReleaseId',
    'packageRole',
    'sourceFiles',
    'webIDECandidate',
    'consumerLockBindings',
    'artifacts',
  ], [], 'candidate state')
  assertExactKeys(state.consumerLockBindings, [
    'webIDE',
    'karel',
  ], [], 'candidate state consumerLockBindings')
  if (
    state.schemaVersion !== 1
    || state.package !== configuration.package
    || state.result !== 'candidate-generated'
    || state.mode !== 'final'
    || canonicalJSONString(state.source) !== canonicalJSONString(source)
    || state.capabilityReleaseId !== configuration.capabilityReleaseId
    || state.packageRole !== configuration.packageRole
    || state.consumerLockBindings.webIDE !== 'exact'
    || state.consumerLockBindings.karel !== 'exact'
  ) throw new TypeError('Candidate state is not final-eligible exact source evidence')
  assertExactKeys(state.sourceFiles, [
    'packageManifest',
    'packageLock',
    'consumerManifest',
    'consumerLock',
  ], [], 'candidate state sourceFiles')
  if (!Array.isArray(state.artifacts)) {
    throw new TypeError('Candidate state artifacts must be an array')
  }
  const names = []
  for (const [index, artifact] of state.artifacts.entries()) {
    assertExactKeys(artifact, [
      'fileName',
      'size',
      'sha256',
    ], [], `candidate state artifacts[${index}]`)
    if (artifact.fileName !== path.basename(artifact.fileName)) {
      throw new TypeError('Candidate state has an unsafe filename')
    }
    assertPositiveSafeInteger(artifact.size, `candidate state artifacts[${index}].size`)
    if (artifact.size > CANDIDATE_ARTIFACT_MAX_BYTES.get(artifact.fileName)) {
      throw new TypeError(`Candidate artifact ${artifact.fileName} exceeds its size limit`)
    }
    assertSha256(artifact.sha256, `candidate state artifacts[${index}].sha256`)
    names.push(artifact.fileName)
  }
  if (
    JSON.stringify(names) !== JSON.stringify(CANDIDATE_ARTIFACT_FILES)
    || JSON.stringify(names) !== JSON.stringify(sortStrings(names))
    || new Set(names).size !== names.length
  ) throw new TypeError('Candidate state artifacts are not the exact sorted set')
  return state
}

export function validateDeterminismReport(report, { sourceArchive }) {
  assertExactKeys(report, [
    'schemaVersion',
    'package',
    'result',
    'isolatedBuildCount',
    'exactWebIDEArtifactMaterializedForBothBuilds',
    'packageTarballsByteIdentical',
    'packageInventoriesCanonicalByteIdentical',
    'sourceTrackedStateCleanBeforeAndAfter',
    'sourceArchiveReference',
    'exactTagSourceArchivesByteIdentical',
    'exactPushedCommitSourceArchivesByteIdentical',
    'sourceArchive',
  ], [], 'deterministic builds report')
  assertExactKeys(report.sourceArchive, [
    'filename',
    'size',
    'sha256',
  ], [], 'deterministic builds source archive')
  const expectedArchive = {
    filename: 'web-ide-karel-0.3.0-source.tar.gz',
    size: sourceArchive.size,
    sha256: sourceArchive.sha256,
  }
  if (
    report.schemaVersion !== 1
    || report.package !== '@web-ide/karel@0.3.0'
    || report.result !== 'pass'
    || report.isolatedBuildCount !== 2
    || report.exactWebIDEArtifactMaterializedForBothBuilds !== true
    || report.packageTarballsByteIdentical !== true
    || report.packageInventoriesCanonicalByteIdentical !== true
    || report.sourceTrackedStateCleanBeforeAndAfter !== true
    || report.sourceArchiveReference !== 'exact-tag'
    || report.exactTagSourceArchivesByteIdentical !== true
    || report.exactPushedCommitSourceArchivesByteIdentical !== true
    || canonicalJSONString(report.sourceArchive)
      !== canonicalJSONString(expectedArchive)
  ) throw new TypeError('Deterministic build report does not match final source evidence')
  return report
}
