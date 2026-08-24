import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertExternalInputFile,
  assertSha256,
  hashFile,
  readBoundedFile,
  readCanonicalJSON,
  sha256Bytes,
  writeCanonicalJSON,
} from './release-utils.mjs'
import {
  EXPECTED_VALIDATION_GATES,
  VALIDATION_GATE_SPECS,
  VALIDATION_INHERITED_ENVIRONMENT_KEYS,
  VALIDATION_TERMINATION_GRACE_MS,
} from './validation-contract.mjs'
import { assertNoUnsafeLocalPaths } from './validation-log-normalization.mjs'

export { EXPECTED_VALIDATION_GATES } from './validation-contract.mjs'

const MAX_VALIDATION_LOG_BYTES = 32 * 1024 * 1024
const MAX_VALIDATION_RECEIPT_BYTES = 64 * 1024
const MAX_TOTAL_VALIDATION_LOG_BYTES = 128 * 1024 * 1024

function expectedLogFilename(gateId) {
  return `validation-${gateId}.log`
}

function expectedReceiptFilename(gateId) {
  return `validation-${gateId}.receipt.json`
}

function validateIdentity(
  value,
  {
    sourceCommit,
    candidateSha256,
    webIDECandidateSha256,
    webIDESourceCommit,
  },
  location,
  schemaVersion = 1,
) {
  if (
    value.schemaVersion !== schemaVersion
    || value.package !== '@web-ide/karel@0.3.0'
  ) {
    throw new TypeError(`Unsupported Karel ${location} identity`)
  }
  if (value.sourceCommit !== sourceCommit) {
    throw new TypeError(`${location} sourceCommit does not match the candidate`)
  }
  if (
    typeof value.webIDESourceCommit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(value.webIDESourceCommit)
    || value.webIDESourceCommit !== webIDESourceCommit
  ) throw new TypeError(`${location} webIDESourceCommit does not match the peer`)
  for (const [field, expected] of [
    ['candidateSha256', candidateSha256],
    ['webIDECandidateSha256', webIDECandidateSha256],
  ]) {
    assertSha256(value[field], `${location}.${field}`)
    if (value[field] !== expected) {
      throw new TypeError(`${location} ${field} does not match the candidate pair`)
    }
  }
}

function validateExternalFileRecord(record, expectedName, maximumBytes, location) {
  assertExactKeys(record, [
    'path', 'fileName', 'size', 'sha256',
  ], [], location)
  if (record.fileName !== expectedName) {
    throw new TypeError(`${location} has an unexpected filename`)
  }
  if (
    !Number.isSafeInteger(record.size)
    || record.size <= 0
    || record.size > maximumBytes
  ) throw new TypeError(`${location} size is invalid`)
  assertSha256(record.sha256, `${location}.sha256`)
}

function validateRetainedFileRecord(record, expectedName, location) {
  assertExactKeys(record, ['fileName', 'size', 'sha256'], [], location)
  if (record.fileName !== expectedName) {
    throw new TypeError(`${location} filename changed`)
  }
  if (!Number.isSafeInteger(record.size) || record.size <= 0) {
    throw new TypeError(`${location} size is invalid`)
  }
  assertSha256(record.sha256, `${location}.sha256`)
}

function validateReceipt(
  receipt,
  {
    gateId,
    log,
    sourceCommit,
    candidateSha256,
    webIDECandidateSha256,
    webIDESourceCommit,
  },
) {
  assertExactKeys(receipt, [
    'schemaVersion',
    'receiptKind',
    'package',
    'sourceCommit',
    'candidateSha256',
    'webIDECandidateSha256',
    'webIDESourceCommit',
    'gate',
    'environment',
    'log',
  ], [], `validation gate ${gateId} capture receipt`)
  validateIdentity(
    receipt,
    {
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    },
    `validation gate ${gateId} capture receipt`,
    2,
  )
  if (receipt.receiptKind !== 'karel-release-validation-gate-capture') {
    throw new TypeError(`Validation gate ${gateId} receipt kind is wrong`)
  }
  const spec = VALIDATION_GATE_SPECS.get(gateId)
  assertExactKeys(receipt.gate, [
    'id',
    'command',
    'executable',
    'argv',
    'exitCode',
    'timeoutMs',
    'terminationGraceMs',
  ], [], `validation gate ${gateId} receipt gate`)
  if (
    receipt.gate.id !== gateId
    || receipt.gate.command !== spec.command
    || receipt.gate.executable !== spec.receiptExecutable
    || canonicalJSONString(receipt.gate.argv)
      !== canonicalJSONString(spec.receiptArgv)
    || receipt.gate.exitCode !== 0
    || receipt.gate.timeoutMs !== spec.timeoutMs
    || receipt.gate.terminationGraceMs !== VALIDATION_TERMINATION_GRACE_MS
  ) throw new TypeError(`Validation gate ${gateId} receipt is not an exact successful capture`)
  assertExactKeys(receipt.environment, [
    'policy', 'inheritedKeys',
  ], [], `validation gate ${gateId} receipt environment`)
  if (
    receipt.environment.policy !== 'normalized-release-gate-v2'
    || !Array.isArray(receipt.environment.inheritedKeys)
    || new Set(receipt.environment.inheritedKeys).size
      !== receipt.environment.inheritedKeys.length
    || canonicalJSONString(receipt.environment.inheritedKeys)
      !== canonicalJSONString([...receipt.environment.inheritedKeys].sort())
    || receipt.environment.inheritedKeys.some((key) => (
      !VALIDATION_INHERITED_ENVIRONMENT_KEYS.includes(key)
    ))
  ) throw new TypeError(`Validation gate ${gateId} receipt environment is not scrubbed`)
  validateRetainedFileRecord(
    receipt.log,
    expectedLogFilename(gateId),
    `validation gate ${gateId} receipt log`,
  )
  if (canonicalJSONString(receipt.log) !== canonicalJSONString(log)) {
    throw new TypeError(
      `Validation gate ${gateId} receipt does not bind its normalized capture log`,
    )
  }
  return receipt
}

export function validateValidationInput(
  input,
  {
    sourceCommit,
    candidateSha256,
    webIDECandidateSha256,
    webIDESourceCommit,
  },
) {
  assertExactKeys(input, [
    'schemaVersion',
    'package',
    'sourceCommit',
    'candidateSha256',
    'webIDECandidateSha256',
    'webIDESourceCommit',
    'gates',
  ], [], 'validation input')
  validateIdentity(
    input,
    {
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    },
    'validation input',
  )
  if (!Array.isArray(input.gates) || input.gates.length !== EXPECTED_VALIDATION_GATES.size) {
    throw new TypeError('Validation input has an incomplete gate set')
  }
  const remaining = new Map(EXPECTED_VALIDATION_GATES)
  let totalLogBytes = 0
  for (const [index, gate] of input.gates.entries()) {
    assertExactKeys(gate, [
      'id', 'command', 'log', 'receipt',
    ], [], `validation input gates[${index}]`)
    if (!remaining.has(gate.id)) {
      throw new TypeError(`Unexpected or duplicate validation gate ${String(gate.id)}`)
    }
    if (gate.command !== remaining.get(gate.id)) {
      throw new TypeError(`Validation gate ${gate.id} command is not exact`)
    }
    validateExternalFileRecord(
      gate.log,
      expectedLogFilename(gate.id),
      MAX_VALIDATION_LOG_BYTES,
      `validation input gates[${index}].log`,
    )
    validateExternalFileRecord(
      gate.receipt,
      expectedReceiptFilename(gate.id),
      MAX_VALIDATION_RECEIPT_BYTES,
      `validation input gates[${index}].receipt`,
    )
    totalLogBytes += gate.log.size
    remaining.delete(gate.id)
  }
  if (totalLogBytes > MAX_TOTAL_VALIDATION_LOG_BYTES) {
    throw new TypeError('Validation logs exceed the total size limit')
  }
  return input
}

export function validateValidationLogBytes(
  sourceBytes,
  gateId,
  { webIDECandidateSha256, webIDESourceCommit },
) {
  let sourceText
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
  } catch (error) {
    throw new TypeError(`Validation gate ${gateId} log is not UTF-8`, {
      cause: error,
    })
  }
  const inspectableSourceText = assertNoUnsafeLocalPaths(
    sourceText,
    `Validation gate ${gateId} log`,
  )
  if (
    inspectableSourceText.length === 0
    || inspectableSourceText.includes('\0')
    || /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u.test(inspectableSourceText)
    || /gh[pousr]_[A-Za-z0-9_]{20,}/u.test(inspectableSourceText)
    || /github_pat_[A-Za-z0-9_]{20,}/u.test(inspectableSourceText)
    || /AKIA[0-9A-Z]{16}/u.test(inspectableSourceText)
    || /npm_[A-Za-z0-9]{20,}/u.test(inspectableSourceText)
    || /xox[baprs]-[A-Za-z0-9-]{10,}/u.test(inspectableSourceText)
    || /AIza[0-9A-Za-z_-]{30,}/u.test(inspectableSourceText)
    || /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/u.test(inspectableSourceText)
    || /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(inspectableSourceText)
    || /(?:authorization|proxy-authorization):\s*(?:bearer|basic)\s+\S+/iu.test(inspectableSourceText)
    || /(?:https?|ssh):\/\/[^\s/:@]+:[^\s/@]+@/u.test(inspectableSourceText)
  ) throw new TypeError(`Validation gate ${gateId} log contains unsafe text`)
  if (gateId === 'packed-exact-pair') {
    const prefix = '@@WEB_IDE_RELEASE_GATE_RECEIPT@@'
    const prefixIndex = sourceText.indexOf(prefix)
    if (
      prefixIndex === -1
      || prefixIndex !== sourceText.lastIndexOf(prefix)
      || (prefixIndex > 0 && sourceText[prefixIndex - 1] !== '\n')
    ) throw new TypeError('Packed exact-pair log has no unique final Web IDE receipt')
    const receiptText = sourceText.slice(prefixIndex + prefix.length)
    const webReceipt = JSON.parse(receiptText)
    if (canonicalJSONString(webReceipt) !== receiptText) {
      throw new TypeError('Packed exact-pair Web IDE receipt is not canonical or final')
    }
    assertExactKeys(webReceipt, [
      'schemaVersion',
      'receiptKind',
      'mode',
      'package',
      'gateId',
      'sourceCommit',
      'candidateSha256',
      'command',
      'exitCode',
      'emitter',
    ], [], 'packed exact-pair Web IDE receipt')
    if (
      webReceipt.schemaVersion !== 2
      || webReceipt.receiptKind !== 'web-ide-release-validation-gate'
      || webReceipt.mode !== 'release-gate'
      || webReceipt.package !== 'web-ide@0.3.0'
      || webReceipt.gateId !== 'karel-compatibility'
      || webReceipt.sourceCommit !== webIDESourceCommit
      || webReceipt.candidateSha256 !== webIDECandidateSha256
      || webReceipt.command !== 'Karel exact-candidate compatibility gate'
      || webReceipt.exitCode !== 0
      || webReceipt.emitter !== 'karel:release-compatibility-gate@2'
    ) throw new TypeError('Packed exact-pair Web IDE receipt identity is wrong')
  }
}

async function readExactExternalEvidence(
  record,
  { label, maximumBytes, canonicalJSON = false },
) {
  const sourcePath = await assertExternalInputFile(record.path, label)
  const bytes = await readBoundedFile(sourcePath, maximumBytes, label)
  if (bytes.length !== record.size || sha256Bytes(bytes) !== record.sha256) {
    throw new TypeError(`${label} bytes do not match the validation input`)
  }
  if (canonicalJSON) {
    const value = JSON.parse(bytes.toString('utf8'))
    if (!bytes.equals(Buffer.from(canonicalJSONString(value)))) {
      throw new TypeError(`${label} is not canonical JSON`)
    }
    return { bytes, sourcePath, value }
  }
  return { bytes, sourcePath }
}

export async function materializeValidationEvidence({
  input,
  outputDirectory,
  sourceCommit,
  candidateSha256,
  webIDECandidateSha256,
  webIDESourceCommit,
}) {
  validateValidationInput(
    input,
    {
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    },
  )
  const canonicalSources = new Set()
  const gates = []
  const reports = []
  for (const [gateId, command] of EXPECTED_VALIDATION_GATES) {
    const gate = input.gates.find((candidate) => candidate.id === gateId)
    const logSource = await readExactExternalEvidence(gate.log, {
      label: `Validation gate ${gateId} log`,
      maximumBytes: MAX_VALIDATION_LOG_BYTES,
    })
    const receiptSource = await readExactExternalEvidence(gate.receipt, {
      label: `Validation gate ${gateId} receipt`,
      maximumBytes: MAX_VALIDATION_RECEIPT_BYTES,
      canonicalJSON: true,
    })
    for (const sourcePath of [logSource.sourcePath, receiptSource.sourcePath]) {
      if (canonicalSources.has(sourcePath)) {
        throw new TypeError('Validation gates must not reuse evidence files')
      }
      canonicalSources.add(sourcePath)
    }
    validateValidationLogBytes(logSource.bytes, gateId, {
      webIDECandidateSha256,
      webIDESourceCommit,
    })
    const log = {
      fileName: expectedLogFilename(gateId),
      size: logSource.bytes.length,
      sha256: sha256Bytes(logSource.bytes),
    }
    const receipt = validateReceipt(receiptSource.value, {
      gateId,
      log,
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    })
    const receiptRecord = {
      fileName: expectedReceiptFilename(gateId),
      size: receiptSource.bytes.length,
      sha256: sha256Bytes(receiptSource.bytes),
    }
    await writeFile(
      path.join(outputDirectory, log.fileName),
      logSource.bytes,
      { flag: 'wx' },
    )
    await writeFile(
      path.join(outputDirectory, receiptRecord.fileName),
      receiptSource.bytes,
      { flag: 'wx' },
    )
    for (const record of [log, receiptRecord]) {
      const destinationHash = await hashFile(
        path.join(outputDirectory, record.fileName),
      )
      if (
        destinationHash.size !== record.size
        || destinationHash.digest !== record.sha256
      ) throw new TypeError(`Validation gate ${gateId} staged evidence changed`)
    }
    gates.push({
      id: gateId,
      command,
      result: 'pass',
      exitCode: receipt.gate.exitCode,
      log,
      receipt: receiptRecord,
    })
    reports.push(
      { kind: `validation-log:${gateId}`, ...log },
      { kind: `validation-receipt:${gateId}`, ...receiptRecord },
    )
  }
  const summary = {
    schemaVersion: 1,
    package: '@web-ide/karel@0.3.0',
    sourceCommit,
    candidateSha256,
    webIDECandidateSha256,
    webIDESourceCommit,
    result: 'pass',
    gates,
  }
  await writeCanonicalJSON(path.join(outputDirectory, 'validation-summary.json'), summary)
  return { summary, reports }
}

export async function validateMaterializedValidationEvidence({
  outputDirectory,
  sourceCommit,
  candidateSha256,
  webIDECandidateSha256,
  webIDESourceCommit,
}) {
  const summary = (await readCanonicalJSON(path.join(
    outputDirectory,
    'validation-summary.json',
  ))).value
  assertExactKeys(summary, [
    'schemaVersion',
    'package',
    'sourceCommit',
    'candidateSha256',
    'webIDECandidateSha256',
    'webIDESourceCommit',
    'result',
    'gates',
  ], [], 'materialized validation summary')
  validateIdentity(
    summary,
    {
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    },
    'validation summary',
  )
  if (
    summary.result !== 'pass'
    || !Array.isArray(summary.gates)
    || summary.gates.length !== EXPECTED_VALIDATION_GATES.size
  ) throw new TypeError('Materialized validation summary is not an exact pass record')
  const reports = []
  for (const [index, [gateId, command]] of [...EXPECTED_VALIDATION_GATES].entries()) {
    const gate = summary.gates[index]
    assertExactKeys(gate, [
      'id', 'command', 'result', 'exitCode', 'log', 'receipt',
    ], [], `materialized validation summary gates[${index}]`)
    if (
      gate.id !== gateId
      || gate.command !== command
      || gate.result !== 'pass'
      || gate.exitCode !== 0
    ) throw new TypeError(`Materialized validation gate ${gateId} changed`)
    const logBytes = await readBoundedFile(
      path.join(outputDirectory, expectedLogFilename(gateId)),
      MAX_VALIDATION_LOG_BYTES,
      `Materialized validation gate ${gateId} log`,
    )
    validateValidationLogBytes(logBytes, gateId, {
      webIDECandidateSha256,
      webIDESourceCommit,
    })
    const expectedLog = {
      fileName: expectedLogFilename(gateId),
      size: logBytes.length,
      sha256: sha256Bytes(logBytes),
    }
    validateRetainedFileRecord(gate.log, expectedLog.fileName, `gate ${gateId} log`)
    if (canonicalJSONString(gate.log) !== canonicalJSONString(expectedLog)) {
      throw new TypeError(`Materialized validation gate ${gateId} log changed`)
    }
    const receiptFileName = expectedReceiptFilename(gateId)
    const receiptResult = await readCanonicalJSON(path.join(
      outputDirectory,
      receiptFileName,
    ))
    validateReceipt(receiptResult.value, {
      gateId,
      log: expectedLog,
      sourceCommit,
      candidateSha256,
      webIDECandidateSha256,
      webIDESourceCommit,
    })
    const expectedReceiptRecord = {
      fileName: receiptFileName,
      size: receiptResult.bytes.length,
      sha256: sha256Bytes(receiptResult.bytes),
    }
    validateRetainedFileRecord(
      gate.receipt,
      receiptFileName,
      `gate ${gateId} receipt`,
    )
    if (canonicalJSONString(gate.receipt) !== canonicalJSONString(expectedReceiptRecord)) {
      throw new TypeError(`Materialized validation gate ${gateId} receipt changed`)
    }
    reports.push(
      { kind: `validation-log:${gateId}`, ...expectedLog },
      { kind: `validation-receipt:${gateId}`, ...expectedReceiptRecord },
    )
  }
  return { summary, reports }
}
