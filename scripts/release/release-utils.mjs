import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJSONString } from './canonical-json.mjs'

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

export async function readJSON(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Could not read JSON file ${filePath}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Could not parse JSON file ${filePath}`, { cause: error })
  }
}

export async function readBoundedFile(filePath, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError('Bounded-file maximum must be a positive safe integer')
  }
  const before = await stat(filePath)
  if (!before.isFile() || before.size > maximumBytes) {
    throw new TypeError(`${label} exceeds its file size limit`)
  }
  const bytes = await readFile(filePath)
  const after = await stat(filePath)
  if (
    bytes.length !== before.size
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
  ) throw new TypeError(`${label} changed while it was read`)
  return bytes
}

export async function readCanonicalJSON(filePath) {
  const bytes = await readFile(filePath)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(Buffer.from(canonicalJSONString(value)))) {
    throw new TypeError(`JSON file is not canonical: ${filePath}`)
  }
  return { bytes, value }
}

export async function readCanonicalJSONBounded(
  filePath,
  maximumBytes,
  label,
) {
  const bytes = await readBoundedFile(filePath, maximumBytes, label)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!bytes.equals(Buffer.from(canonicalJSONString(value)))) {
    throw new TypeError(`JSON file is not canonical: ${filePath}`)
  }
  return { bytes, value }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha512IntegrityBytes(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export async function hashFile(filePath, algorithm = 'sha256') {
  const hash = createHash(algorithm)
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, digest: hash.digest('hex') }
}

export function assertExactKeys(value, required, optional, location) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${location} has unknown field ${key}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${location} is missing required field ${key}`)
  }
}

export function assertNonEmptyString(value, location) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${location} must be a non-empty string`)
  }
  return value
}

export function assertSha256(value, location) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${location} must be lowercase SHA-256 hex`)
  }
  return value
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/')
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

async function externalPath(inputPath, label, expectedType) {
  if (!path.isAbsolute(inputPath)) throw new TypeError(`${label} must be absolute`)
  const resolved = path.resolve(inputPath)
  const directInfo = await lstat(resolved)
  if (directInfo.isSymbolicLink()) {
    throw new TypeError(`${label} must not be a symbolic link`)
  }
  const canonical = await realpath(resolved)
  if (canonical === repositoryRoot || isPathInside(repositoryRoot, canonical)) {
    throw new TypeError(`${label} must be outside the repository`)
  }
  const info = await stat(canonical)
  if (!info[expectedType]()) throw new TypeError(`${label} has the wrong filesystem type`)
  return canonical
}

export async function assertExternalInputFile(inputPath, label) {
  return await externalPath(inputPath, label, 'isFile')
}

export async function assertExternalInputDirectory(inputPath, label) {
  return await externalPath(inputPath, label, 'isDirectory')
}

export async function assertNewExternalOutputPath(outputDirectory) {
  if (!path.isAbsolute(outputDirectory)) {
    throw new TypeError('Release output directory must be absolute')
  }
  const resolved = path.resolve(outputDirectory)
  if (resolved === repositoryRoot || isPathInside(repositoryRoot, resolved)) {
    throw new TypeError('Release output directory must be outside the repository')
  }
  const parent = await externalPath(
    path.dirname(resolved),
    'Release output parent directory',
    'isDirectory',
  )
  const target = path.join(parent, path.basename(resolved))
  await assertPathAbsent(target, 'Release output path must not already exist')
  return target
}

async function assertPathAbsent(target, message) {
  try {
    await lstat(target)
    throw new TypeError(message)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function moveDirectoryNoReplace(stage, target) {
  const stagedIdentity = await lstat(stage)
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/mv', ['-h', '-n', stage, target], {
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  if (result.code !== 0) {
    throw new Error(
      `/bin/mv -h -n could not publish release evidence (${result.signal ?? result.code}): ${result.stderr.trimEnd()}`,
    )
  }
  try {
    await lstat(stage)
    throw new TypeError('Release output path appeared while evidence was staged')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const publishedIdentity = await lstat(target)
  if (
    publishedIdentity.dev !== stagedIdentity.dev
    || publishedIdentity.ino !== stagedIdentity.ino
    || !publishedIdentity.isDirectory()
  ) {
    const nestedStage = path.join(target, path.basename(stage))
    const nestedIdentity = await lstat(nestedStage)
    if (
      nestedIdentity.dev !== stagedIdentity.dev
      || nestedIdentity.ino !== stagedIdentity.ino
      || !nestedIdentity.isDirectory()
    ) throw new TypeError('Release output publication did not preserve the staged directory')
    await rm(nestedStage, { recursive: true, force: true })
    throw new TypeError('Release output path appeared while evidence was staged')
  }
}

export async function withAtomicOutputDirectory(
  outputDirectory,
  operation,
  { beforePublish } = {},
) {
  if (beforePublish !== undefined && typeof beforePublish !== 'function') {
    throw new TypeError('Atomic output beforePublish hook must be a function')
  }
  const target = await assertNewExternalOutputPath(outputDirectory)
  const stage = await mkdtemp(path.join(
    path.dirname(target),
    `.${path.basename(target)}.staging-`,
  ))
  let published = false
  try {
    const result = await operation(stage)
    await assertPathAbsent(
      target,
      'Release output path appeared while evidence was staged',
    )
    await beforePublish?.()
    await moveDirectoryNoReplace(stage, target)
    published = true
    return { outputDirectory: target, result }
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true })
  }
}

export async function writeCanonicalJSON(filePath, value) {
  await writeFile(filePath, canonicalJSONString(value), {
    encoding: 'utf8',
    flag: 'wx',
  })
}

export function sortStrings(values) {
  return [...values].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
}

export function isolatedNpmEnvironment(
  baseEnvironment,
  cacheRoot,
  sourceEpoch,
  {
    homeRoot,
    temporaryRoot,
    userConfigPath,
    globalConfigPath,
  },
) {
  const environment = {}
  const permittedInherited = new Set([
    'all_proxy',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'node_extra_ca_certs',
    'path',
    'ssl_cert_file',
  ])
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const normalized = key.toLowerCase()
    if (
      permittedInherited.has(normalized)
      && value !== undefined
    ) environment[key] = value
  }
  return {
    ...environment,
    CI: 'true',
    HOME: homeRoot,
    LANG: 'C',
    LC_ALL: 'C',
    NO_UPDATE_NOTIFIER: '1',
    SOURCE_DATE_EPOCH: String(sourceEpoch),
    TMPDIR: temporaryRoot,
    TZ: 'UTC',
    npm_config_cache: cacheRoot,
    npm_config_audit: 'false',
    npm_config_engine_strict: 'true',
    npm_config_fund: 'false',
    npm_config_globalconfig: globalConfigPath,
    npm_config_ignore_scripts: 'true',
    npm_config_strict_peer_deps: 'true',
    npm_config_userconfig: userConfigPath,
  }
}
