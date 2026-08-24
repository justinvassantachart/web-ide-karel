import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import {
  createArtifactManifest,
  sourceFileRecord,
} from './artifact-manifest.mjs'
import { buildDeterministicCandidates } from './candidate-builds.mjs'
import {
  CANDIDATE_ARTIFACT_FILES,
  validateCandidateState,
  validateDeterminismReport,
} from './candidate-evidence.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  validateProductionConsumerLock,
  validateProductionConsumerManifest,
} from './consumer-lock.mjs'
import { generateLicenseEvidence } from './license-evidence.mjs'
import {
  inspectExistingPackedPackage,
  PACKAGE_TAR_LIMITS,
} from './package-inspection.mjs'
import { git } from './process-utils.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import {
  assertExternalInputDirectory,
  assertExternalInputFile,
  hashFile,
  isPathInside,
  readBoundedFile,
  readCanonicalJSON,
  readCanonicalJSONBounded,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sha512IntegrityBytes,
  sortStrings,
  withAtomicOutputDirectory,
} from './release-utils.mjs'
import { generateCycloneDx, validateCycloneDx } from './sbom.mjs'
import {
  assertReleaseSourceStateUnchanged,
  sourceArchiveBytes,
  verifyReleaseSourceState,
} from './source-state.mjs'
import {
  materializeValidationEvidence,
  validateMaterializedValidationEvidence,
} from './validation-evidence.mjs'
import { validateWebIDECandidateReport } from './web-ide-candidate-evidence.mjs'
import { verifyWebIDEEvidence } from './web-ide-evidence.mjs'

const candidateInput = process.env.KAREL_RELEASE_CANDIDATE_DIR
const outputInput = process.env.KAREL_RELEASE_OUTPUT_DIR
const validationInput = process.env.KAREL_RELEASE_VALIDATION_INPUT
const webManifestInput = process.env.KAREL_RELEASE_WEB_IDE_MANIFEST
const webTarballInput = process.env.KAREL_RELEASE_WEB_IDE_TARBALL
if (!candidateInput) throw new TypeError('KAREL_RELEASE_CANDIDATE_DIR is required')
if (!outputInput) throw new TypeError('KAREL_RELEASE_OUTPUT_DIR is required')
if (!validationInput) throw new TypeError('KAREL_RELEASE_VALIDATION_INPUT is required')
if (!webManifestInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_MANIFEST is required')
if (!webTarballInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_TARBALL is required')

const candidateDirectory = await assertExternalInputDirectory(
  candidateInput,
  'Karel candidate evidence directory',
)
const resolvedOutput = path.resolve(outputInput)
if (
  resolvedOutput === candidateDirectory
  || isPathInside(candidateDirectory, resolvedOutput)
  || isPathInside(resolvedOutput, candidateDirectory)
) throw new TypeError('Final output must be separate from the candidate directory')
const validationPath = await assertExternalInputFile(
  validationInput,
  'Karel validation input',
)
const webManifestPath = await assertExternalInputFile(
  webManifestInput,
  'Web IDE artifact manifest',
)
const webTarballPath = await assertExternalInputFile(
  webTarballInput,
  'Web IDE package tarball',
)
const configuration = await loadReleaseConfiguration()
const source = await verifyReleaseSourceState(configuration)
const candidateStatePath = await assertExternalInputFile(
  path.join(candidateDirectory, 'candidate-state.json'),
  'Karel candidate state',
)
const { value: inputState } = await readCanonicalJSONBounded(
  candidateStatePath,
  4 * 1024 * 1024,
  'Karel candidate state',
)
validateCandidateState(inputState, { configuration, source })
validateWebIDECandidateReport(inputState.webIDECandidate, configuration)

const expectedCandidateFiles = sortStrings([
  ...CANDIDATE_ARTIFACT_FILES,
  'candidate-state.json',
])
if (
  JSON.stringify(sortStrings(await readdir(candidateDirectory)))
  !== JSON.stringify(expectedCandidateFiles)
) throw new TypeError('Candidate directory has missing or unexpected files')
const candidatePaths = new Map()
for (const fileName of expectedCandidateFiles) {
  candidatePaths.set(fileName, await assertExternalInputFile(
    path.join(candidateDirectory, fileName),
    `Karel candidate file ${fileName}`,
  ))
}
for (const artifact of inputState.artifacts) {
  const actual = await hashFile(candidatePaths.get(artifact.fileName))
  if (actual.size !== artifact.size || actual.digest !== artifact.sha256) {
    throw new TypeError(`Candidate artifact changed: ${artifact.fileName}`)
  }
}

const transaction = await withAtomicOutputDirectory(
  outputInput,
  async (outputDirectory) => {
    for (const fileName of expectedCandidateFiles) {
      await copyFile(
        candidatePaths.get(fileName),
        path.join(outputDirectory, fileName),
        fsConstants.COPYFILE_EXCL,
      )
    }
    const { value: state } = await readCanonicalJSONBounded(
      path.join(outputDirectory, 'candidate-state.json'),
      4 * 1024 * 1024,
      'Staged Karel candidate state',
    )
    if (canonicalJSONString(state) !== canonicalJSONString(inputState)) {
      throw new TypeError('Copied candidate state changed')
    }
    validateCandidateState(state, { configuration, source })
    for (const artifact of state.artifacts) {
      const actual = await hashFile(path.join(outputDirectory, artifact.fileName))
      if (actual.size !== artifact.size || actual.digest !== artifact.sha256) {
        throw new TypeError(`Staged candidate artifact changed: ${artifact.fileName}`)
      }
    }

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
    const sourceFiles = Object.fromEntries(Object.entries(sourceBytes).map(
      ([name, bytes]) => [name, sourceFileRecord({
        packageManifest: 'package.json',
        packageLock: 'package-lock.json',
        consumerManifest: 'tests/production/consumer/package.json',
        consumerLock: 'tests/production/consumer/package-lock.json',
      }[name], bytes)],
    ))
    if (canonicalJSONString(sourceFiles) !== canonicalJSONString(state.sourceFiles)) {
      throw new TypeError('Candidate source-file digests no longer match verified source')
    }
    const packageManifest = JSON.parse(sourceBytes.packageManifest.toString('utf8'))
    const packageLock = JSON.parse(sourceBytes.packageLock.toString('utf8'))
    const consumerLock = JSON.parse(sourceBytes.consumerLock.toString('utf8'))
    const consumerManifest = JSON.parse(sourceBytes.consumerManifest.toString('utf8'))
    validateProductionConsumerManifest(consumerManifest)

    const candidateTarBytes = await readBoundedFile(
      path.join(outputDirectory, configuration.releaseAssetFilename),
      PACKAGE_TAR_LIMITS.compressedBytes,
      'Karel candidate tarball',
    )
    const regeneratedInspection = inspectExistingPackedPackage(
      candidateTarBytes,
      { expectedManifest: packageManifest },
    )
    const inspection = (await readCanonicalJSON(path.join(
      outputDirectory,
      'package-inspection.json',
    ))).value
    if (
      canonicalJSONString(inspection)
      !== canonicalJSONString(regeneratedInspection.report)
    ) throw new TypeError('Package inspection is not independently reproducible')
    validateProductionConsumerLock(consumerLock, {
      karelIntegrity: sha512IntegrityBytes(candidateTarBytes),
      requireKarelIntegrity: true,
    })

    const regeneratedArchive = await sourceArchiveBytes(configuration, {
      reference: configuration.sourceTag,
    })
    const retainedArchive = await readFile(path.join(
      outputDirectory,
      configuration.sourceAssetFilename,
    ))
    if (!retainedArchive.equals(regeneratedArchive.bytes)) {
      throw new TypeError('Retained source archive does not match the exact source tag')
    }
    const determinism = (await readCanonicalJSON(path.join(
      outputDirectory,
      'deterministic-builds.json',
    ))).value
    validateDeterminismReport(determinism, { sourceArchive: regeneratedArchive })

    const candidateVerification = (await readCanonicalJSON(path.join(
      outputDirectory,
      'web-ide-candidate-verification.json',
    ))).value
    validateWebIDECandidateReport(candidateVerification, configuration)
    if (
      canonicalJSONString(candidateVerification)
      !== canonicalJSONString(state.webIDECandidate)
      || candidateVerification.nonFinalTestFixture
      || candidateVerification.candidateState.result !== 'candidate-generated'
      || candidateVerification.consumerLock.binding !== 'exact'
    ) throw new TypeError('Candidate state does not bind final Web IDE candidate evidence')

    const webIDEEvidence = await verifyWebIDEEvidence({
      configuration,
      manifestPath: webManifestPath,
      tarballPath: webTarballPath,
      consumerLock,
      mode: 'final',
    })
    validateProductionConsumerLock(consumerLock, {
      karelIntegrity: sha512IntegrityBytes(candidateTarBytes),
      webIDEIntegrity: webIDEEvidence.report.artifact.sha512Integrity,
      requireKarelIntegrity: true,
      requireWebIDEIntegrity: true,
    })
    const candidateStateEvidence = webIDEEvidence.manifest.evidence.find(
      (evidence) => evidence.kind === 'candidate-state',
    )
    if (
      canonicalJSONString(candidateVerification.artifact)
        !== canonicalJSONString(webIDEEvidence.report.artifact)
      || canonicalJSONString(candidateVerification.runtimeEvidence)
        !== canonicalJSONString(webIDEEvidence.report.runtimeEvidence)
      || canonicalJSONString(candidateVerification.candidateState.source)
        !== canonicalJSONString(webIDEEvidence.report.artifactManifest.source)
      || !candidateStateEvidence
      || candidateStateEvidence.fileName !== candidateVerification.candidateState.fileName
      || candidateStateEvidence.size !== candidateVerification.candidateState.size
      || candidateStateEvidence.sha256 !== candidateVerification.candidateState.sha256
      || webIDEEvidence.report.consumerLock.binding !== 'exact'
      || webIDEEvidence.report.nonFinalTestFixture
    ) throw new TypeError('Final Web IDE evidence does not bind the peer candidate used by Karel')

    const rebuildDirectory = path.join(outputDirectory, '.finalizer-rebuild')
    await mkdir(rebuildDirectory)
    try {
      const rebuiltCandidate = await buildDeterministicCandidates({
        outputDirectory: rebuildDirectory,
        sourceCommit: source.commit,
        sourceEpoch: source.sourceEpoch,
        configuration,
        webIDEEntries: webIDEEvidence.entries,
        expectedPackageManifest: packageManifest,
      })
      if (!rebuiltCandidate.tarballBytes.equals(candidateTarBytes)) {
        throw new TypeError('Finalizer clean rebuild differs from retained Karel candidate')
      }
      if (
        canonicalJSONString(rebuiltCandidate.inspection)
        !== canonicalJSONString(inspection)
      ) throw new TypeError('Finalizer clean rebuild package inspection differs')
      const regeneratedDeterminism = {
        ...rebuiltCandidate.determinism,
        sourceArchiveReference: 'exact-tag',
        exactTagSourceArchivesByteIdentical: true,
        exactPushedCommitSourceArchivesByteIdentical: true,
        sourceArchive: {
          filename: configuration.sourceAssetFilename,
          size: regeneratedArchive.size,
          sha256: regeneratedArchive.sha256,
        },
      }
      if (
        canonicalJSONString(regeneratedDeterminism)
        !== canonicalJSONString(determinism)
      ) throw new TypeError('Determinism report differs from independent finalizer rebuild')
    } finally {
      await rm(rebuildDirectory, { recursive: true, force: true })
    }

    const policy = await readJSON(path.join(
      repositoryRoot,
      'release/license-policy.json',
    ))
    const regeneratedLicenses = await generateLicenseEvidence({
      policy,
      packageManifest,
      packageLock,
      consumerLock,
      packageEntries: regeneratedInspection.entries,
      inspection: regeneratedInspection.report,
      webIDEEvidence: {
        licenseEntry: webIDEEvidence.licenseEntry,
        report: candidateVerification,
      },
    })
    const retainedLicenseReport = await readFile(path.join(
      outputDirectory,
      'license-inventory.json',
    ))
    const retainedLicenseText = await readFile(path.join(
      outputDirectory,
      'THIRD_PARTY_LICENSES.txt',
    ))
    if (
      !retainedLicenseReport.equals(Buffer.from(regeneratedLicenses.reportBytes))
      || !retainedLicenseText.equals(Buffer.from(regeneratedLicenses.textBytes))
    ) throw new TypeError('License evidence does not match independent regeneration')

    const retainedSBOM = (await readCanonicalJSON(path.join(
      outputDirectory,
      'web-ide-karel-0.2.0.cdx.json',
    ))).value
    const sbomInputs = {
      packageManifest,
      inspection: regeneratedInspection.report,
      licenseReport: regeneratedLicenses.report,
      webIDEEvidence: { report: candidateVerification },
    }
    validateCycloneDx(retainedSBOM, sbomInputs)
    if (
      canonicalJSONString(retainedSBOM)
      !== canonicalJSONString(generateCycloneDx(sbomInputs))
    ) throw new TypeError('SBOM does not match independent regeneration')

    const validationInputValue = (await readCanonicalJSONBounded(
      validationPath,
      4 * 1024 * 1024,
      'Karel validation input',
    )).value
    const validation = await materializeValidationEvidence({
      input: validationInputValue,
      outputDirectory,
      sourceCommit: source.commit,
      candidateSha256: regeneratedInspection.report.tarball.sha256,
      webIDECandidateSha256: webIDEEvidence.report.artifact.sha256,
      webIDESourceCommit: webIDEEvidence.report.artifactManifest.source.commit,
    })
    const revalidatedValidation = await validateMaterializedValidationEvidence({
      outputDirectory,
      sourceCommit: source.commit,
      candidateSha256: regeneratedInspection.report.tarball.sha256,
      webIDECandidateSha256: webIDEEvidence.report.artifact.sha256,
      webIDESourceCommit: webIDEEvidence.report.artifactManifest.source.commit,
    })
    if (
      canonicalJSONString(validation.summary)
      !== canonicalJSONString(revalidatedValidation.summary)
      || canonicalJSONString(validation.reports)
      !== canonicalJSONString(revalidatedValidation.reports)
    ) throw new TypeError('Staged validation evidence changed after materialization')

    await writeFile(
      path.join(outputDirectory, 'web-ide-final-verification.json'),
      canonicalJSONString(webIDEEvidence.report),
      { encoding: 'utf8', flag: 'wx' },
    )
    const manifest = await createArtifactManifest({
      outputDirectory,
      configuration,
      source,
      packageManifest,
      sourceFiles,
      inspection: regeneratedInspection.report,
      determinism,
      webIDEEvidence,
    })
    const manifestBytes = canonicalJSONString(manifest)
    await writeFile(
      path.join(outputDirectory, 'artifact-manifest.json'),
      manifestBytes,
      { encoding: 'utf8', flag: 'wx' },
    )
    const manifestSha256 = sha256Bytes(Buffer.from(manifestBytes))
    await writeFile(
      path.join(outputDirectory, 'artifact-manifest.json.sha256'),
      `${manifestSha256}  artifact-manifest.json\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    if (
      JSON.stringify(sortStrings(await readdir(outputDirectory)))
      !== JSON.stringify(manifest.distribution.intendedAssets)
    ) throw new TypeError('Final evidence output has missing or unexpected files')
    return { manifestSha256 }
  },
  {
    beforePublish: async () => {
      const prepublicationSource = await verifyReleaseSourceState(configuration)
      assertReleaseSourceStateUnchanged(source, prepublicationSource)
    },
  },
)

process.stdout.write(
  `Finalized Karel release evidence manifest SHA-256 ${transaction.result.manifestSha256}\n`,
)
