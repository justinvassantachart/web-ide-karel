import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExternalInputFile,
  repositoryRoot,
  sha256Bytes,
  withAtomicOutputDirectory,
  writeCanonicalJSON,
} from './release-utils.mjs'
import { verifyReleaseSourceState } from './source-state.mjs'
import { validateValidationLogBytes } from './validation-evidence.mjs'
import {
  runCapturedGateProcess,
  scrubbedValidationEnvironment,
} from './validation-gate-runner.mjs'
import { normalizeValidationLogBytes } from './validation-log-normalization.mjs'
import {
  exactSuccessorPairCompatibilityEvidence,
  formatWebIDECompatibilityReceipt,
  WEB_IDE_GATE_RECEIPT_PREFIX,
  WEB_IDE_SUCCESSOR_COMPATIBILITY_EMITTER,
} from './web-compatibility-receipt.mjs'

const EMITTER_SOURCE = Object.freeze({
  nodeVersion: '24.11.1',
  npmVersion: '11.6.2',
  sourceRepository: 'https://github.com/justinvassantachart/web-ide-karel.git',
  sourceTag:
    'web-ide-karel-compatibility-gate-v2-web-ide-v0.3.1-source',
})
const GATE_TIMEOUT_MS = 90 * 1000
const TERMINATION_GRACE_MS = 5 * 1000
const LOG_FILENAME = 'karel-compatibility.log'
const CAPTURE_FILENAME = 'karel-compatibility.capture.json'

const outputInput = process.env.KAREL_WEB_IDE_COMPATIBILITY_OUTPUT_DIR
const karelTarballInput = process.env.KAREL_RELEASE_KAREL_TARBALL
const karelManifestInput = process.env.KAREL_RELEASE_KAREL_ARTIFACT_MANIFEST
const karelStateInput = process.env.KAREL_RELEASE_KAREL_CANDIDATE_STATE
const karelReceiptInput = process.env.KAREL_RELEASE_KAREL_RELEASE_RECEIPT
const webTarballInput = process.env.KAREL_RELEASE_WEB_IDE_TARBALL
const webStateInput = process.env.KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE
for (const [name, value] of [
  ['KAREL_WEB_IDE_COMPATIBILITY_OUTPUT_DIR', outputInput],
  ['KAREL_RELEASE_KAREL_TARBALL', karelTarballInput],
  ['KAREL_RELEASE_KAREL_ARTIFACT_MANIFEST', karelManifestInput],
  ['KAREL_RELEASE_KAREL_CANDIDATE_STATE', karelStateInput],
  ['KAREL_RELEASE_KAREL_RELEASE_RECEIPT', karelReceiptInput],
  ['KAREL_RELEASE_WEB_IDE_TARBALL', webTarballInput],
  ['KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE', webStateInput],
]) {
  if (!value) throw new TypeError(`${name} is required`)
}

const [karelTarballPath, karelManifestPath, karelStatePath, karelReceiptPath,
  webTarballPath, webStatePath] = await Promise.all([
  assertExternalInputFile(karelTarballInput, 'Karel immutable release tarball'),
  assertExternalInputFile(karelManifestInput, 'Karel immutable artifact manifest'),
  assertExternalInputFile(karelStateInput, 'Karel immutable candidate state'),
  assertExternalInputFile(karelReceiptInput, 'Karel immutable release receipt'),
  assertExternalInputFile(webTarballInput, 'Web IDE successor candidate tarball'),
  assertExternalInputFile(webStateInput, 'Web IDE successor candidate state'),
])
const source = await verifyReleaseSourceState(EMITTER_SOURCE)
const pair = await exactSuccessorPairCompatibilityEvidence({
  webIDECandidateStatePath: webStatePath,
  webIDETarballPath: webTarballPath,
  karelArtifactManifestPath: karelManifestPath,
  karelCandidateStatePath: karelStatePath,
  karelReleaseReceiptPath: karelReceiptPath,
  karelTarballPath,
})
const expectedFooter = formatWebIDECompatibilityReceipt(pair.receipt)

function validateSuccessorLog(logBytes) {
  validateValidationLogBytes(
    logBytes,
    'web-ide-successor-compatibility',
    {
      webIDECandidateSha256: pair.receipt.candidateSha256,
      webIDESourceCommit: pair.receipt.sourceCommit,
    },
  )
  const text = logBytes.toString('utf8')
  const first = text.indexOf(WEB_IDE_GATE_RECEIPT_PREFIX)
  if (
    first === -1
    || first !== text.lastIndexOf(WEB_IDE_GATE_RECEIPT_PREFIX)
    || text.slice(first) !== expectedFooter
    || (first > 0 && text[first - 1] !== '\n')
  ) throw new TypeError('Successor compatibility log has no unique exact final receipt')
  const receiptText = text.slice(first + WEB_IDE_GATE_RECEIPT_PREFIX.length)
  const receipt = JSON.parse(receiptText)
  if (
    canonicalJSONString(receipt) !== receiptText
    || receipt.package !== 'web-ide@0.3.1'
    || receipt.emitter !== WEB_IDE_SUCCESSOR_COMPATIBILITY_EMITTER
  ) throw new TypeError('Successor compatibility receipt is not canonical and exact')
}

const transaction = await withAtomicOutputDirectory(
  outputInput,
  async (stage) => {
    const executionRoot = path.join(stage, '.execution')
    const temporaryRoot = path.join(executionRoot, 'tmp')
    const cacheRoot = path.join(executionRoot, 'npm-cache')
    const userConfig = path.join(executionRoot, 'user-npmrc')
    const globalConfig = path.join(executionRoot, 'global-npmrc')
    await mkdir(temporaryRoot, { recursive: true })
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(userConfig, '', { flag: 'wx' })
    await writeFile(globalConfig, '', { flag: 'wx' })
    const { environment, inheritedKeys } = scrubbedValidationEnvironment(
      process.env,
      {
        KAREL_CANDIDATE_TARBALL: karelTarballPath,
        KAREL_RELEASE_KAREL_ARTIFACT_MANIFEST: karelManifestPath,
        KAREL_RELEASE_KAREL_CANDIDATE_STATE: karelStatePath,
        KAREL_RELEASE_KAREL_RELEASE_RECEIPT: karelReceiptPath,
        KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE: webStatePath,
        KAREL_RELEASE_WEB_IDE_GATE_RECEIPT: '1',
        KAREL_RELEASE_WEB_IDE_SUCCESSOR: '0.3.1',
        WEB_IDE_CANDIDATE_TARBALL: webTarballPath,
      },
    )
    const startedAt = Date.now()
    const result = await runCapturedGateProcess({
      executable: process.execPath,
      argv: [path.join(repositoryRoot, 'scripts/validate-packed-production-consumer.mjs')],
      cwd: repositoryRoot,
      env: {
        ...environment,
        TMPDIR: temporaryRoot,
        npm_config_cache: cacheRoot,
        npm_config_globalconfig: globalConfig,
        npm_config_userconfig: userConfig,
      },
      timeoutMs: GATE_TIMEOUT_MS,
      terminationGraceMs: TERMINATION_GRACE_MS,
    })
    const wallClockMilliseconds = Date.now() - startedAt
    if (result.exitCode !== 0) {
      throw new Error(`Successor compatibility consumer failed with exit ${result.exitCode}`)
    }
    const logBytes = normalizeValidationLogBytes(result.logBytes, [
      { value: karelTarballPath, placeholder: '<karel-candidate>' },
      { value: karelManifestPath, placeholder: '<karel-artifact-manifest>' },
      { value: karelStatePath, placeholder: '<karel-candidate-state>' },
      { value: karelReceiptPath, placeholder: '<karel-release-receipt>' },
      { value: webTarballPath, placeholder: '<web-candidate>' },
      { value: webStatePath, placeholder: '<web-candidate-state>' },
      { value: temporaryRoot, placeholder: '<execution-root>' },
      { value: executionRoot, placeholder: '<execution-root>' },
      { value: stage, placeholder: '<gate-staging-root>' },
      { value: repositoryRoot, placeholder: '<repository-root>' },
      { value: path.dirname(repositoryRoot), placeholder: '<workspace-root>' },
      ...(environment.HOME
        ? [{ value: path.resolve(environment.HOME), placeholder: '<home>' }]
        : []),
    ])
    validateSuccessorLog(logBytes)
    const log = {
      fileName: LOG_FILENAME,
      size: logBytes.length,
      sha256: sha256Bytes(logBytes),
    }
    await rm(executionRoot, { recursive: true, force: true })
    await writeFile(path.join(stage, LOG_FILENAME), logBytes, { flag: 'wx' })
    await writeCanonicalJSON(path.join(stage, CAPTURE_FILENAME), {
      schemaVersion: 1,
      captureKind: 'karel-post-publication-web-ide-compatibility',
      emitter: WEB_IDE_SUCCESSOR_COMPATIBILITY_EMITTER,
      emitterSource: {
        commit: source.commit,
        tag: EMITTER_SOURCE.sourceTag,
      },
      immutableKarel: {
        candidateSha256: pair.karel.candidateSha256,
        sourceCommit: pair.karel.sourceCommit,
      },
      webIDECandidate: {
        candidateSha256: pair.receipt.candidateSha256,
        sourceCommit: pair.receipt.sourceCommit,
      },
      gate: {
        executable: 'node',
        argv: ['<repository-root>/scripts/validate-packed-production-consumer.mjs'],
        exitCode: result.exitCode,
        timeoutMs: GATE_TIMEOUT_MS,
        terminationGraceMs: TERMINATION_GRACE_MS,
        wallClockMilliseconds,
      },
      environment: {
        policy: 'normalized-release-gate-v2',
        inheritedKeys,
      },
      log,
    })
    return { log, wallClockMilliseconds }
  },
  { beforePublish: () => verifyReleaseSourceState(EMITTER_SOURCE) },
)

process.stdout.write(
  `Captured Web IDE 0.3.1 compatibility at ${transaction.outputDirectory} `
  + `in ${transaction.result.wallClockMilliseconds}ms; `
  + `${transaction.result.log.fileName} `
  + `sha256=${transaction.result.log.sha256}\n`,
)
