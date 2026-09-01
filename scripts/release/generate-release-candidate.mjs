import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildDeterministicCandidates } from './candidate-builds.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  validateProductionConsumerLock,
  validateProductionConsumerManifest,
} from './consumer-lock.mjs'
import { generateLicenseEvidence } from './license-evidence.mjs'
import { git } from './process-utils.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import {
  assertExternalInputFile,
  hashFile,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
  withAtomicOutputDirectory,
  writeCanonicalJSON,
} from './release-utils.mjs'
import { generateCycloneDx } from './sbom.mjs'
import {
  inspectNonFinalSourceState,
  sourceArchiveBytes,
  verifyReleaseSourceState,
} from './source-state.mjs'
import { verifyWebIDECandidateEvidence } from './web-ide-candidate-evidence.mjs'

const outputInput = process.env.KAREL_RELEASE_OUTPUT_DIR
const webCandidateStateInput = process.env.KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE
const webTarballInput = process.env.KAREL_RELEASE_WEB_IDE_TARBALL
const mode = process.env.KAREL_RELEASE_MODE ?? 'final'
if (!outputInput) throw new TypeError('KAREL_RELEASE_OUTPUT_DIR is required')
if (!webCandidateStateInput) {
  throw new TypeError('KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE is required')
}
if (!webTarballInput) {
  throw new TypeError('KAREL_RELEASE_WEB_IDE_TARBALL is required')
}
if (!['final', 'test'].includes(mode)) {
  throw new TypeError('KAREL_RELEASE_MODE must be final or test')
}
const webCandidateStatePath = await assertExternalInputFile(
  webCandidateStateInput,
  'Web IDE candidate state',
)
const webTarballPath = await assertExternalInputFile(
  webTarballInput,
  'Web IDE package tarball',
)

const transaction = await withAtomicOutputDirectory(
  outputInput,
  async (outputDirectory) => {
const configuration = await loadReleaseConfiguration()
const source = mode === 'final'
  ? await verifyReleaseSourceState(configuration)
  : await inspectNonFinalSourceState(configuration)

async function committedSourceFile(fileName) {
  const { stdout } = await git(
    ['show', `${source.commit}:${fileName}`],
    { cwd: repositoryRoot },
  )
  return Buffer.from(stdout)
}

const sourceBytes = {
  packageManifest: await committedSourceFile('package.json'),
  packageLock: await committedSourceFile('package-lock.json'),
  consumerManifest: await committedSourceFile(
    'tests/production/consumer/package.json',
  ),
  consumerLock: await committedSourceFile(
    'tests/production/consumer/package-lock.json',
  ),
}
const packageManifest = JSON.parse(sourceBytes.packageManifest.toString('utf8'))
const packageLock = JSON.parse(sourceBytes.packageLock.toString('utf8'))
const consumerLock = JSON.parse(sourceBytes.consumerLock.toString('utf8'))
const consumerManifest = JSON.parse(sourceBytes.consumerManifest.toString('utf8'))
validateProductionConsumerManifest(consumerManifest)
validateProductionConsumerLock(consumerLock)
const sourceFiles = Object.fromEntries(Object.entries(sourceBytes).map(
  ([name, bytes]) => [name, {
    fileName: {
      packageManifest: 'package.json',
      packageLock: 'package-lock.json',
      consumerManifest: 'tests/production/consumer/package.json',
      consumerLock: 'tests/production/consumer/package-lock.json',
    }[name],
    size: bytes.length,
    sha256: sha256Bytes(bytes),
  }],
))

const webIDEEvidence = await verifyWebIDECandidateEvidence({
  configuration,
  candidateStatePath: webCandidateStatePath,
  tarballPath: webTarballPath,
  consumerLock,
  mode,
})

const archiveResults = await Promise.allSettled([
  sourceArchiveBytes(configuration, { reference: source.sourceReference }),
  sourceArchiveBytes(configuration, { reference: source.sourceReference }),
])
const archiveFailures = archiveResults
  .filter((result) => result.status === 'rejected')
  .map((result) => result.reason)
if (archiveFailures.length > 0) {
  throw new AggregateError(
    archiveFailures,
    'One or more deterministic Karel source archives failed',
  )
}
const [sourceArchiveFirst, sourceArchiveSecond]
  = archiveResults.map((result) => result.value)
if (!sourceArchiveFirst.bytes.equals(sourceArchiveSecond.bytes)) {
  throw new TypeError('Two exact-source Karel archives were not byte-identical')
}
await writeFile(
  path.join(outputDirectory, configuration.sourceAssetFilename),
  sourceArchiveFirst.bytes,
  { flag: 'wx' },
)

const candidate = await buildDeterministicCandidates({
  outputDirectory,
  sourceCommit: source.commit,
  sourceEpoch: source.sourceEpoch,
  configuration,
  webIDEEntries: webIDEEvidence.entries,
  expectedPackageManifest: packageManifest,
})
const lockValidation = validateProductionConsumerLock(consumerLock, {
  webIDEIntegrity: webIDEEvidence.report.artifact.sha512Integrity,
  karelIntegrity: candidate.inspection.tarball.sha512Integrity,
  requireWebIDEIntegrity: mode === 'final',
  requireKarelIntegrity: mode === 'final',
})
const karelLockMatches = lockValidation.karel.binding === 'exact'
if (mode === 'final' && !karelLockMatches) {
  throw new TypeError('Packed consumer lock is not bound to the final Karel artifact')
}

const determinism = {
  ...candidate.determinism,
  sourceArchiveReference: mode === 'final' ? 'exact-tag' : 'exact-pushed-commit',
  exactTagSourceArchivesByteIdentical: mode === 'final' ? true : null,
  exactPushedCommitSourceArchivesByteIdentical: true,
  sourceArchive: {
    filename: configuration.sourceAssetFilename,
    size: sourceArchiveFirst.size,
    sha256: sourceArchiveFirst.sha256,
  },
}
await writeCanonicalJSON(
  path.join(outputDirectory, 'package-inspection.json'),
  candidate.inspection,
)
await writeCanonicalJSON(
  path.join(outputDirectory, 'deterministic-builds.json'),
  determinism,
)
await writeCanonicalJSON(
  path.join(outputDirectory, 'web-ide-candidate-verification.json'),
  webIDEEvidence.report,
)

const policy = await readJSON(path.join(
  repositoryRoot,
  'release/license-policy.json',
))
const licenses = await generateLicenseEvidence({
  policy,
  packageManifest,
  packageLock,
  consumerLock,
  packageEntries: candidate.entries,
  inspection: candidate.inspection,
  webIDEEvidence,
})
await writeFile(
  path.join(outputDirectory, 'license-inventory.json'),
  licenses.reportBytes,
  { encoding: 'utf8', flag: 'wx' },
)
await writeFile(
  path.join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'),
  licenses.textBytes,
  { encoding: 'utf8', flag: 'wx' },
)
const sbom = generateCycloneDx({
  packageManifest,
  inspection: candidate.inspection,
  licenseReport: licenses.report,
  webIDEEvidence,
})
await writeCanonicalJSON(
  path.join(outputDirectory, 'web-ide-karel-0.3.2.cdx.json'),
  sbom,
)

const artifactFiles = [
  configuration.releaseAssetFilename,
  configuration.sourceAssetFilename,
  'deterministic-builds.json',
  'license-inventory.json',
  'package-inspection.json',
  'THIRD_PARTY_LICENSES.txt',
  'web-ide-karel-0.3.2.cdx.json',
  'web-ide-candidate-verification.json',
].sort()
const artifacts = []
for (const fileName of artifactFiles) {
  const { size, digest } = await hashFile(path.join(outputDirectory, fileName))
  artifacts.push({ fileName, size, sha256: digest })
}
const state = {
  schemaVersion: 1,
  package: configuration.package,
  result: mode === 'final'
    ? 'candidate-generated'
    : 'non-final-candidate-generated',
  mode,
  source,
  capabilityReleaseId: configuration.capabilityReleaseId,
  packageRole: configuration.packageRole,
  sourceFiles,
  webIDECandidate: webIDEEvidence.report,
  consumerLockBindings: {
    webIDE: lockValidation.webIDE.binding === 'exact'
      ? 'exact'
      : 'pending-final-web-regeneration',
    karel: karelLockMatches ? 'exact' : 'pending-final-karel-regeneration',
  },
  artifacts,
}
await writeCanonicalJSON(path.join(outputDirectory, 'candidate-state.json'), state)
if (
  JSON.stringify(sortStrings(await readdir(outputDirectory)))
  !== JSON.stringify(sortStrings([
    ...artifactFiles,
    'candidate-state.json',
  ]))
) throw new TypeError('Candidate output has missing or unexpected files')

const stateSha256 = sha256Bytes(Buffer.from(canonicalJSONString(state)))
return {
  candidateSha256: candidate.inspection.tarball.sha256,
  package: configuration.package,
  stateSha256,
}
  },
)
process.stdout.write(
  `${mode === 'final' ? 'Generated final-eligible' : 'Generated NON-FINAL test'} deterministic ${transaction.result.package} candidate ${transaction.result.candidateSha256}\n`
    + `Candidate state SHA-256 ${transaction.result.stateSha256}\n`,
)
