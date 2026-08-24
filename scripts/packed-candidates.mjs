import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'

import {
  validateProductionConsumerLock,
  validateProductionConsumerManifest,
} from './release/consumer-lock.mjs'

export const PACKED_CANDIDATE_SPECS = Object.freeze([
  Object.freeze({
    packageName: 'web-ide',
    expectedVersion: '0.3.0',
    reference: 'file:artifacts/web-ide.tgz',
    destination: 'artifacts/web-ide.tgz',
    lockPackagePath: 'node_modules/web-ide',
  }),
  Object.freeze({
    packageName: '@web-ide/karel',
    expectedVersion: '0.3.1',
    expectedWebIDEPeer: '>=0.3.0 <0.4.0',
    reference: 'file:artifacts/web-ide-karel.tgz',
    destination: 'artifacts/web-ide-karel.tgz',
    lockPackagePath: 'node_modules/@web-ide/karel',
  }),
])

async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function assertReference(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    )
  }
}

function assertSha512Integrity(integrity, label) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`${label} must be one canonical SHA-512 integrity`)
  }
  const encoded = integrity.slice('sha512-'.length)
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== encoded) {
    throw new Error(`${label} must be one canonical SHA-512 integrity`)
  }
}

export async function readPackedCandidateExpectations(consumerRoot) {
  const manifest = await readJSON(path.join(consumerRoot, 'package.json'))
  const lock = await readJSON(path.join(consumerRoot, 'package-lock.json'))
  const lockRoot = lock.packages['']

  const expectations = PACKED_CANDIDATE_SPECS.map((spec) => {
    assertReference(
      manifest.dependencies?.[spec.packageName],
      spec.reference,
      `package.json dependency ${spec.packageName}`,
    )
    assertReference(
      lockRoot.dependencies?.[spec.packageName],
      spec.reference,
      `package-lock.json root dependency ${spec.packageName}`,
    )
    const lockedPackage = lock.packages?.[spec.lockPackagePath]
    if (lockedPackage === undefined) {
      throw new Error(
        `package-lock.json is missing ${spec.lockPackagePath}`,
      )
    }
    assertReference(
      lockedPackage.resolved,
      spec.reference,
      `package-lock.json resolution ${spec.packageName}`,
    )
    assertReference(
      lockedPackage.version,
      spec.expectedVersion,
      `package-lock.json version ${spec.packageName}`,
    )
    if (spec.expectedWebIDEPeer !== undefined) {
      assertReference(
        lockedPackage.peerDependencies?.['web-ide'],
        spec.expectedWebIDEPeer,
        `package-lock.json Web IDE peer ${spec.packageName}`,
      )
    }
    assertSha512Integrity(
      lockedPackage.integrity,
      `package-lock.json integrity ${spec.packageName}`,
    )
    return Object.freeze({
      ...spec,
      expectedIntegrity: lockedPackage.integrity,
    })
  })
  validateProductionConsumerManifest(manifest)
  validateProductionConsumerLock(lock)
  return expectations
}

async function hashFile(file) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk)
    sha512.update(chunk)
    bytes += chunk.byteLength
  }
  return {
    bytes,
    sha256: sha256.digest('hex'),
    integrity: `sha512-${sha512.digest('base64')}`,
  }
}

export function isolatedNpmEnvironment(baseEnvironment, cacheRoot) {
  if (!path.isAbsolute(cacheRoot)) {
    throw new Error('The packed consumer npm cache path must be absolute')
  }
  const environment = {}
  const permitted = new Set([
    'all_proxy',
    'ci',
    'home',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'node_extra_ca_certs',
    'path',
    'ssl_cert_file',
    'tmpdir',
  ])
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (permitted.has(key.toLowerCase()) && value !== undefined) {
      environment[key] = value
    }
  }
  return {
    ...environment,
    CI: 'true',
    LANG: 'C',
    LC_ALL: 'C',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_audit: 'false',
    npm_config_cache: cacheRoot,
    npm_config_engine_strict: 'true',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_strict_peer_deps: 'true',
  }
}

export async function reportAndCleanupPackedConsumer({
  keepTemporary,
  report,
  cleanup,
  onRetained,
}) {
  if (
    typeof report !== 'function'
    || typeof cleanup !== 'function'
    || typeof onRetained !== 'function'
  ) {
    throw new Error('Packed consumer finalization callbacks are required')
  }

  let reportError
  try {
    await report()
  } catch (error) {
    reportError = error
  }

  let finalizationError
  try {
    if (keepTemporary) await onRetained()
    else await cleanup()
  } catch (error) {
    finalizationError = error
  }

  if (reportError !== undefined && finalizationError !== undefined) {
    throw new AggregateError(
      [reportError, finalizationError],
      'Packed consumer evidence reporting and finalization both failed',
    )
  }
  if (reportError !== undefined) throw reportError
  if (finalizationError !== undefined) throw finalizationError
}

async function removeDestinations(consumerRoot) {
  const results = await Promise.allSettled(PACKED_CANDIDATE_SPECS.map((spec) =>
    rm(path.join(consumerRoot, spec.destination), { force: true })))
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Packed candidate cleanup failed')
  }
}

async function validateCandidatePaths(consumerRoot, candidates) {
  const resolved = new Map()
  for (const spec of PACKED_CANDIDATE_SPECS) {
    const candidate = candidates?.[spec.packageName]
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new Error(
        `${spec.packageName} candidate tarball must be an absolute path`,
      )
    }
    const destination = path.join(consumerRoot, spec.destination)
    if (path.resolve(candidate) === path.resolve(destination)) {
      throw new Error(
        `${spec.packageName} candidate tarball must not be its consumer destination`,
      )
    }
    let candidateStat
    try {
      candidateStat = await stat(candidate)
    } catch {
      throw new Error(
        `${spec.packageName} candidate tarball is not a readable regular file: ${candidate}`,
      )
    }
    if (!candidateStat.isFile()) {
      throw new Error(
        `${spec.packageName} candidate tarball is not a readable regular file: ${candidate}`,
      )
    }
    resolved.set(spec.packageName, candidate)
  }
  return resolved
}

export async function withVerifiedPackedCandidates({
  consumerRoot,
  candidates,
  consume,
}) {
  if (!path.isAbsolute(consumerRoot)) {
    throw new Error('Packed consumer root must be an absolute path')
  }
  if (typeof consume !== 'function') {
    throw new Error('A packed candidate consumer callback is required')
  }
  const candidatePaths = await validateCandidatePaths(consumerRoot, candidates)
  await mkdir(path.join(consumerRoot, 'artifacts'), { recursive: true })
  await removeDestinations(consumerRoot)

  try {
    const expectations = await readPackedCandidateExpectations(consumerRoot)
    const verified = []
    for (const expectation of expectations) {
      const sourcePath = candidatePaths.get(expectation.packageName)
      const destinationPath = path.join(
        consumerRoot,
        expectation.destination,
      )
      await copyFile(sourcePath, destinationPath)
      const digest = await hashFile(destinationPath)
      if (digest.integrity !== expectation.expectedIntegrity) {
        throw new Error(
          `${expectation.packageName} copied candidate integrity mismatch: expected ${expectation.expectedIntegrity}, found ${digest.integrity}`,
        )
      }
      verified.push(Object.freeze({
        ...expectation,
        sourcePath,
        destinationPath,
        bytes: digest.bytes,
        sha256: digest.sha256,
        integrity: digest.integrity,
      }))
    }
    return await consume(Object.freeze(verified))
  } catch (error) {
    await removeDestinations(consumerRoot)
    throw error
  }
}
