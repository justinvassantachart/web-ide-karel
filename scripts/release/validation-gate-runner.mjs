import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  sha256Bytes,
  withAtomicOutputDirectory,
  writeCanonicalJSON,
} from './release-utils.mjs'
import {
  VALIDATION_GATE_SPECS,
  VALIDATION_INHERITED_ENVIRONMENT_KEYS,
  VALIDATION_TERMINATION_GRACE_MS,
} from './validation-contract.mjs'
import { validateValidationLogBytes } from './validation-evidence.mjs'
import { normalizeValidationLogBytes } from './validation-log-normalization.mjs'

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024
const KILL_SETTLEMENT_TIMEOUT_MS = 5 * 1000
const PROCESS_GROUP_POLL_MS = 20

function assertPositiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGroupExit(processGroupId, deadline) {
  while (processGroupExists(processGroupId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('Validation gate process group did not settle after SIGKILL')
    }
    await delay(Math.min(PROCESS_GROUP_POLL_MS, remaining))
  }
}

async function waitForChildClose(childClose, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error('Validation gate child did not settle after SIGKILL')
  }
  let timer
  try {
    await Promise.race([
      childClose,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Validation gate child did not settle after SIGKILL'))
        }, remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function terminateProcessTree(child, childClose, terminationGraceMs) {
  const processGroupId = child.pid
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('Validation gate child has no process-group identifier')
  }
  const cleanupErrors = []
  try {
    signalProcessGroup(processGroupId, 'SIGTERM')
  } catch (error) {
    cleanupErrors.push(error)
  }
  await delay(terminationGraceMs)
  try {
    if (processGroupExists(processGroupId)) {
      signalProcessGroup(processGroupId, 'SIGKILL')
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  const deadline = Date.now() + KILL_SETTLEMENT_TIMEOUT_MS
  try {
    await waitForProcessGroupExit(processGroupId, deadline)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await waitForChildClose(childClose, deadline)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Validation gate process tree did not settle cleanly',
    )
  }
}

export function scrubbedValidationEnvironment(
  baseEnvironment = process.env,
  explicitEnvironment = {},
) {
  const environment = {}
  const inheritedKeys = []
  for (const expectedKey of VALIDATION_INHERITED_ENVIRONMENT_KEYS) {
    const matches = Object.keys(baseEnvironment).filter(
      (key) => key.toUpperCase() === expectedKey,
    )
    if (matches.length > 1) {
      throw new TypeError(`Validation environment duplicates ${expectedKey}`)
    }
    if (matches.length === 1 && baseEnvironment[matches[0]] !== undefined) {
      environment[expectedKey] = baseEnvironment[matches[0]]
      inheritedKeys.push(expectedKey)
    }
  }
  Object.assign(environment, {
    CI: 'true',
    LANG: 'C',
    LC_ALL: 'C',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_audit: 'false',
    npm_config_engine_strict: 'true',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_strict_peer_deps: 'true',
    ...explicitEnvironment,
  })
  return { environment, inheritedKeys: inheritedKeys.sort() }
}

export async function runCapturedGateProcess({
  executable,
  argv,
  cwd,
  env,
  timeoutMs,
  terminationGraceMs = VALIDATION_TERMINATION_GRACE_MS,
}) {
  assertPositiveDuration(timeoutMs, 'Validation gate wall-clock timeout')
  assertPositiveDuration(
    terminationGraceMs,
    'Validation gate termination grace period',
  )
  if (process.platform === 'win32') {
    throw new TypeError('Validation gate capture requires POSIX process groups')
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    let size = 0
    let terminating = false
    let settled = false
    let closeChild
    const childClose = new Promise((resolveClose) => { closeChild = resolveClose })
    let wallClockTimer
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(wallClockTimer)
      settle(value)
    }
    const terminate = (reason) => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(wallClockTimer)
      void terminateProcessTree(child, childClose, terminationGraceMs).then(
        () => finish(reject, reason),
        (cleanupError) => finish(reject, new AggregateError(
          [reason, cleanupError],
          `${reason.message}; validation gate process-tree cleanup failed`,
        )),
      )
    }
    const capture = (chunk) => {
      if (size > MAX_CAPTURE_BYTES) return
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_CAPTURE_BYTES) {
        terminate(new TypeError(
          'Validation gate output exceeded the capture limit',
        ))
        return
      }
      chunks.push(bytes)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code, signal) => {
      closeChild()
      if (terminating || settled) return
      if (code === null) {
        terminate(new Error(`Validation gate terminated by ${String(signal)}`))
        return
      }
      finish(resolve, { exitCode: code, logBytes: Buffer.concat(chunks) })
    })
    wallClockTimer = setTimeout(() => {
      terminate(new Error(
        `Validation gate exceeded its ${timeoutMs}ms wall-clock timeout`,
      ))
    }, timeoutMs)
  })
}

export async function captureValidationGate({
  gateId,
  outputDirectory,
  sourceCommit,
  candidateSha256,
  webIDECandidateSha256,
  webIDESourceCommit,
  cwd,
  normalizationPaths = [],
  environmentFactory,
  afterRun,
  execute = runCapturedGateProcess,
}) {
  const spec = VALIDATION_GATE_SPECS.get(gateId)
  if (!spec) throw new TypeError(`Unknown release validation gate ${String(gateId)}`)
  const transaction = await withAtomicOutputDirectory(
    outputDirectory,
    async (stage) => {
      const executionRoot = path.join(stage, '.execution')
      const cacheRoot = path.join(executionRoot, 'npm-cache')
      const temporaryRoot = path.join(executionRoot, 'tmp')
      const userConfig = path.join(executionRoot, 'user-npmrc')
      const globalConfig = path.join(executionRoot, 'global-npmrc')
      await mkdir(cacheRoot, { recursive: true })
      await mkdir(temporaryRoot, { recursive: false })
      await writeFile(userConfig, '', { flag: 'wx' })
      await writeFile(globalConfig, '', { flag: 'wx' })
      const {
        environment,
        inheritedKeys,
      } = await environmentFactory(stage)
      const capturedResult = await execute({
        executable: spec.spawnExecutable,
        argv: spec.spawnArgv,
        cwd,
        env: {
          ...environment,
          TMPDIR: temporaryRoot,
          npm_config_cache: cacheRoot,
          npm_config_globalconfig: globalConfig,
          npm_config_userconfig: userConfig,
        },
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: VALIDATION_TERMINATION_GRACE_MS,
      })
      if (
        !Buffer.isBuffer(capturedResult.logBytes)
        || capturedResult.logBytes.length === 0
        || capturedResult.logBytes.length > MAX_CAPTURE_BYTES
      ) {
        throw new TypeError('Validation gate capture produced an invalid log size')
      }
      if (
        !Number.isSafeInteger(capturedResult.exitCode)
        || capturedResult.exitCode < 0
        || capturedResult.exitCode > 255
      ) throw new TypeError('Validation gate capture produced an invalid exit code')
      const replacements = [
        ...normalizationPaths,
        { value: temporaryRoot, placeholder: '<execution-root>' },
        { value: executionRoot, placeholder: '<execution-root>' },
        { value: stage, placeholder: '<gate-staging-root>' },
        { value: cwd, placeholder: '<repository-root>' },
        { value: path.dirname(cwd), placeholder: '<workspace-root>' },
        ...(environment.HOME
          ? [{ value: path.resolve(environment.HOME), placeholder: '<home>' }]
          : []),
      ]
      const result = {
        ...capturedResult,
        logBytes: normalizeValidationLogBytes(capturedResult.logBytes, replacements),
      }
      if (result.logBytes.length > MAX_CAPTURE_BYTES) {
        throw new TypeError('Normalized validation gate log exceeds the capture limit')
      }
      validateValidationLogBytes(result.logBytes, gateId, {
        webIDECandidateSha256,
        webIDESourceCommit,
      })
      if (afterRun) await afterRun({ stage, result })
      await rm(executionRoot, { recursive: true, force: true })
      const log = {
        fileName: `validation-${gateId}.log`,
        size: result.logBytes.length,
        sha256: sha256Bytes(result.logBytes),
      }
      const receipt = {
        schemaVersion: 2,
        receiptKind: 'karel-release-validation-gate-capture',
        package: '@web-ide/karel@0.3.0',
        sourceCommit,
        candidateSha256,
        webIDECandidateSha256,
        webIDESourceCommit,
        gate: {
          id: gateId,
          command: spec.command,
          executable: spec.receiptExecutable,
          argv: spec.receiptArgv,
          exitCode: result.exitCode,
          timeoutMs: spec.timeoutMs,
          terminationGraceMs: VALIDATION_TERMINATION_GRACE_MS,
        },
        environment: {
          policy: 'normalized-release-gate-v2',
          inheritedKeys,
        },
        log,
      }
      await writeFile(path.join(stage, log.fileName), result.logBytes, { flag: 'wx' })
      await writeCanonicalJSON(
        path.join(stage, `validation-${gateId}.receipt.json`),
        receipt,
      )
      const expectedFiles = [
        `validation-${gateId}.log`,
        `validation-${gateId}.receipt.json`,
      ].sort()
      if (JSON.stringify((await readdir(stage)).sort()) !== JSON.stringify(expectedFiles)) {
        throw new TypeError('Validation gate capture output has unexpected files')
      }
      return { exitCode: result.exitCode, receipt }
    },
  )
  return { ...transaction, ...transaction.result }
}
