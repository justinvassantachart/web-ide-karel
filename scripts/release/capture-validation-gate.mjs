import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { validateCandidateState } from './candidate-evidence.mjs'
import { canonicalJSONString } from './canonical-json.mjs'
import {
  validateProductionConsumerLock,
  validateProductionConsumerManifest,
} from './consumer-lock.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import {
  assertExternalInputFile,
  readBoundedFile,
  readCanonicalJSONBounded,
  repositoryRoot,
  sha256Bytes,
  sha512IntegrityBytes,
} from './release-utils.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'
import {
  candidateIdentityForConfiguration,
  validateWebIDECandidateState,
} from './web-ide-candidate-evidence.mjs'
import {
  captureValidationGate,
  scrubbedValidationEnvironment,
} from './validation-gate-runner.mjs'

const gateId = process.env.KAREL_RELEASE_GATE_ID
const outputInput = process.env.KAREL_RELEASE_GATE_OUTPUT_DIR
const karelTarballInput = process.env.KAREL_RELEASE_KAREL_TARBALL
const karelStateInput = process.env.KAREL_RELEASE_KAREL_CANDIDATE_STATE
const webTarballInput = process.env.KAREL_RELEASE_WEB_IDE_TARBALL
const webStateInput = process.env.KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE
const webManifestInput = process.env.KAREL_RELEASE_WEB_IDE_MANIFEST
if (!gateId) throw new TypeError('KAREL_RELEASE_GATE_ID is required')
if (!outputInput) throw new TypeError('KAREL_RELEASE_GATE_OUTPUT_DIR is required')
if (!karelTarballInput) throw new TypeError('KAREL_RELEASE_KAREL_TARBALL is required')
if (!karelStateInput) throw new TypeError('KAREL_RELEASE_KAREL_CANDIDATE_STATE is required')
if (!webTarballInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_TARBALL is required')
if (!webStateInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE is required')
if (gateId === 'web-ide-peer-evidence' && !webManifestInput) {
  throw new TypeError('KAREL_RELEASE_WEB_IDE_MANIFEST is required for Web evidence')
}

const configuration = await loadReleaseConfiguration()
const source = await verifyReleaseSourceState(configuration)
const karelTarballPath = await assertExternalInputFile(
  karelTarballInput,
  'Karel validation candidate tarball',
)
const karelStatePath = await assertExternalInputFile(
  karelStateInput,
  'Karel validation candidate state',
)
const webTarballPath = await assertExternalInputFile(
  webTarballInput,
  'Web IDE validation candidate tarball',
)
const webStatePath = await assertExternalInputFile(
  webStateInput,
  'Web IDE validation candidate state',
)
const webManifestPath = gateId === 'web-ide-peer-evidence'
  ? await assertExternalInputFile(
      webManifestInput,
      'Web IDE validation artifact manifest',
    )
  : undefined
if (
  path.basename(karelTarballPath) !== configuration.releaseAssetFilename
  || path.basename(karelStatePath) !== 'candidate-state.json'
  || path.basename(webTarballPath) !== configuration.webIDE.releaseAssetFilename
  || path.basename(webStatePath) !== 'candidate-state.json'
) throw new TypeError('Validation gate candidate filenames are not exact')

const karelTarballBytes = await readBoundedFile(
  karelTarballPath,
  64 * 1024 * 1024,
  'Karel validation candidate tarball',
)
const webTarballBytes = await readBoundedFile(
  webTarballPath,
  64 * 1024 * 1024,
  'Web IDE validation candidate tarball',
)
const { value: karelState } = await readCanonicalJSONBounded(
  karelStatePath,
  4 * 1024 * 1024,
  'Karel validation candidate state',
)
validateCandidateState(karelState, { configuration, source })
const karelCandidateSha256 = sha256Bytes(karelTarballBytes)
const karelArtifact = karelState.artifacts.find(
  (artifact) => artifact.fileName === configuration.releaseAssetFilename,
)
if (
  karelArtifact?.size !== karelTarballBytes.length
  || karelArtifact.sha256 !== karelCandidateSha256
) throw new TypeError('Karel validation tarball does not match its candidate state')
const webCandidateSha256 = sha256Bytes(webTarballBytes)
const { value: webState } = await readCanonicalJSONBounded(
  webStatePath,
  4 * 1024 * 1024,
  'Web IDE validation candidate state',
)
validateWebIDECandidateState(
  webState,
  'final',
  configuration.webIDE.sourceTag,
  candidateIdentityForConfiguration(configuration),
)
const webArtifact = webState.artifacts.find(
  (artifact) => artifact.fileName === configuration.webIDE.releaseAssetFilename,
)
if (
  webArtifact?.size !== webTarballBytes.length
  || webArtifact.sha256 !== webCandidateSha256
) throw new TypeError('Web IDE validation tarball does not match its candidate state')

const consumerManifest = JSON.parse(await readFile(path.join(
  repositoryRoot,
  'tests/production/consumer/package.json',
), 'utf8'))
const consumerLock = JSON.parse(await readFile(path.join(
  repositoryRoot,
  'tests/production/consumer/package-lock.json',
), 'utf8'))
validateProductionConsumerManifest(consumerManifest)
validateProductionConsumerLock(consumerLock, {
  karelIntegrity: sha512IntegrityBytes(karelTarballBytes),
  webIDEIntegrity: sha512IntegrityBytes(webTarballBytes),
  requireKarelIntegrity: true,
  requireWebIDEIntegrity: true,
})

let reproducibilityDirectory
const result = await captureValidationGate({
  gateId,
  outputDirectory: outputInput,
  sourceCommit: source.commit,
  candidateSha256: karelCandidateSha256,
  webIDECandidateSha256: webCandidateSha256,
  webIDESourceCommit: webState.source.commit,
  cwd: repositoryRoot,
  normalizationPaths: [
    { value: karelTarballPath, placeholder: '<karel-candidate>' },
    { value: karelStatePath, placeholder: '<karel-candidate-state>' },
    { value: webTarballPath, placeholder: '<web-candidate>' },
    { value: webStatePath, placeholder: '<web-candidate-state>' },
    ...(webManifestPath
      ? [{
          value: webManifestPath,
          placeholder: '<web-artifact-manifest>',
        }]
      : []),
  ],
  environmentFactory: async (stage) => {
    const explicit = {}
    if (['validate-production', 'packed-exact-pair'].includes(gateId)) {
      Object.assign(explicit, {
        WEB_IDE_CANDIDATE_TARBALL: webTarballPath,
        KAREL_CANDIDATE_TARBALL: karelTarballPath,
      })
    }
    if (gateId === 'packed-exact-pair') {
      Object.assign(explicit, {
        KAREL_RELEASE_WEB_IDE_GATE_RECEIPT: '1',
        KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE: webStatePath,
        KAREL_RELEASE_KAREL_CANDIDATE_STATE: karelStatePath,
      })
    }
    if (gateId === 'reproducibility') {
      reproducibilityDirectory = path.join(stage, 'reproduced-candidate')
      Object.assign(explicit, {
        KAREL_RELEASE_MODE: 'final',
        KAREL_RELEASE_OUTPUT_DIR: reproducibilityDirectory,
        KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE: webStatePath,
        KAREL_RELEASE_WEB_IDE_TARBALL: webTarballPath,
      })
    }
    if (gateId === 'web-ide-peer-evidence') {
      Object.assign(explicit, {
        KAREL_RELEASE_WEB_IDE_MANIFEST: webManifestPath,
        KAREL_RELEASE_WEB_IDE_TARBALL: webTarballPath,
      })
    }
    return scrubbedValidationEnvironment(process.env, explicit)
  },
  afterRun: async ({ result: execution }) => {
    if (gateId !== 'reproducibility') return
    try {
      if (execution.exitCode === 0) {
        const reproducedTar = await readBoundedFile(
          path.join(reproducibilityDirectory, configuration.releaseAssetFilename),
          64 * 1024 * 1024,
          'Reproduced Karel candidate tarball',
        )
        const reproducedState = (await readCanonicalJSONBounded(
          path.join(reproducibilityDirectory, 'candidate-state.json'),
          4 * 1024 * 1024,
          'Reproduced Karel candidate state',
        )).value
        validateCandidateState(reproducedState, { configuration, source })
        if (
          !reproducedTar.equals(karelTarballBytes)
          || canonicalJSONString(reproducedState.source)
            !== canonicalJSONString(karelState.source)
        ) {
          throw new TypeError(
            'Reproducibility gate did not reproduce the exact Karel candidate',
          )
        }
      }
    } finally {
      await rm(reproducibilityDirectory, { recursive: true, force: true })
    }
  },
})
process.stdout.write(
  `Captured ${gateId} release validation gate with exit ${result.exitCode} at ${result.outputDirectory}\n`,
)
if (result.exitCode !== 0) process.exitCode = 1
