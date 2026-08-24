import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  assertNonEmptyString,
  sha256Bytes,
  sha512IntegrityBytes,
  sortStrings,
} from './release-utils.mjs'

export const PACKAGE_TAR_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
  entries: 20_000,
  pathBytes: 1_024,
  paxBytes: 64 * 1024,
  paxRecords: 32,
  uncompressedBytes: 256 * 1024 * 1024,
})

export const EXPECTED_KAREL_PACKAGE_FILES = Object.freeze([
  'LICENSE.md',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'dist/KarelPanel.d.ts',
  'dist/KarelWorldView.d.ts',
  'dist/assets.d.ts',
  'dist/comparison.d.ts',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/playback-controller.d.ts',
  'dist/plugin.d.ts',
  'dist/protocol.d.ts',
  'dist/session-store.d.ts',
  'dist/styles.css',
  'dist/timeline.d.ts',
  'dist/types.d.ts',
  'dist/world-contract.d.ts',
  'dist/world.d.ts',
  'docs/architecture.md',
  'docs/publishing-readiness.md',
  'docs/testing.md',
  'package.json',
  'python/karel.py',
  'python/karel_world_contract.py',
  'python/starter.py',
  'worlds/default.json',
])

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const EXPECTED_KAREL_SCRIPTS = {
  build: 'npm run build:library && npm run build:example',
  'build:library': 'vite build',
  'build:example': 'tsc -p examples/basic/tsconfig.json && vite build --config examples/basic/vite.config.ts',
  typecheck: 'tsc -b',
  lint: 'eslint .',
  test: 'npm run test:ts && npm run test:python',
  'test:ts': "vitest run --exclude 'tests/browser/**'",
  'check:python': 'python3 scripts/check-python-version.py',
  'test:python': "npm run check:python && python3 -m unittest discover -s tests/python -p '*_test.py'",
  'test:browser': 'playwright test',
  'test:release': 'vitest run tests/release',
  'test:packed-production': 'node scripts/validate-packed-production-consumer.mjs',
  'check:production-environment': 'node scripts/check-production-validation-environment.mjs',
  'audit:full': 'npm audit --audit-level=low',
  'audit:production': 'npm audit --omit=dev --audit-level=low',
  'pack:check': 'npm pack --dry-run',
  'release:candidate': 'node scripts/release/generate-release-candidate.mjs',
  'release:capture-gate': 'node scripts/release/capture-validation-gate.mjs',
  'release:finalize': 'node scripts/release/finalize-release-evidence.mjs',
  validate: 'npm run lint && npm run test && npm run typecheck && npm run build && npm run pack:check',
  'validate:production': 'npm run check:production-environment && npm run validate && npm run test:browser && npm run audit:full && npm run audit:production && npm run test:packed-production',
}

const EXPECTED_KAREL_MANIFEST_KEYS = [
  'name',
  'version',
  'private',
  'description',
  'type',
  'license',
  'repository',
  'homepage',
  'bugs',
  'engines',
  'files',
  'exports',
  'sideEffects',
  'scripts',
  'peerDependencies',
  'devDependencies',
  'packageManager',
]

const FORBIDDEN_PACKED_TEXT = Object.freeze([
  Object.freeze([/\/(?:Users|home)\/[A-Za-z0-9._-]+\//u, 'absolute developer path']),
  Object.freeze([/[A-Za-z]:\\Users\\/u, 'absolute Windows developer path']),
  Object.freeze([/<repository>\//u, 'release provenance placeholder']),
  Object.freeze([/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u, 'private key']),
  Object.freeze([/AKIA[0-9A-Z]{16}/u, 'AWS access key']),
  Object.freeze([/gh[pousr]_[A-Za-z0-9_]{20,}/u, 'GitHub token']),
  Object.freeze([/github_pat_[A-Za-z0-9_]{20,}/u, 'GitHub fine-grained token']),
  Object.freeze([/npm_[A-Za-z0-9]{20,}/u, 'npm token']),
  Object.freeze([/xox[baprs]-[A-Za-z0-9-]{10,}/u, 'Slack token']),
  Object.freeze([/AIza[0-9A-Za-z_-]{30,}/u, 'Google API key']),
  Object.freeze([/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u, 'JWT']),
  Object.freeze([/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu, 'bearer token']),
  Object.freeze([
    /\b(?:Proxy-)?Authorization\b["']?\s*:\s*["']?Basic\s+[A-Za-z0-9+/]{4,}={0,2}(?=["'\s,}\]]|$)/imu,
    'Basic authorization credential',
  ]),
  Object.freeze([
    /\b(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:access[_-]?token|api[_-]?key|auth[_-]?token|client[_-]?secret|github[_-]?token|npm[_-]?token|password|passwd|secret|token)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/iu,
    'credential assignment',
  ]),
  Object.freeze([/(?:https?|ssh):\/\/[^\s/:@]+:[^\s/@]+@/u, 'credential-bearing URL']),
  Object.freeze([/(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/u, 'service token']),
])

function tarString(bytes, start, length, location) {
  const field = bytes.subarray(start, start + length)
  const nul = field.indexOf(0)
  if (
    nul !== -1
    && !field.subarray(nul + 1).every((byte) => byte === 0)
  ) {
    throw new TypeError(`Tar ${location} has nonzero bytes after its terminator`)
  }
  return utf8Decoder.decode(field.subarray(0, nul === -1 ? field.length : nul))
}

function tarOctal(
  bytes,
  start,
  length,
  location,
  { allowEmpty = false, checksum = false } = {},
) {
  const field = bytes.subarray(start, start + length)
  if ((field[0] & 0x80) !== 0) {
    throw new TypeError(`Unsupported base-256 tar ${location}`)
  }
  const nul = field.indexOf(0)
  if (nul !== -1) {
    const trailing = field.subarray(nul + 1)
    const allowed = checksum
      ? trailing.every((byte) => byte === 0 || byte === 0x20)
      : trailing.every((byte) => byte === 0)
    if (!allowed) {
      throw new TypeError(`Tar ${location} has nonzero bytes after its terminator`)
    }
  }
  const valueBytes = field.subarray(0, nul === -1 ? field.length : nul)
  if (!valueBytes.every((byte) => (
    byte === 0x20 || (byte >= 0x30 && byte <= 0x37)
  ))) {
    throw new TypeError(`Invalid tar ${location}`)
  }
  const value = Buffer.from(valueBytes).toString('ascii').trim()
  if (allowEmpty && value === '') return 0
  if (!/^[0-7]+$/u.test(value)) {
    throw new TypeError(`Invalid tar ${location}: ${JSON.stringify(value)}`)
  }
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`Tar ${location} is not a safe integer`)
  }
  return parsed
}

function verifyHeaderChecksum(header, offset) {
  const expected = tarOctal(
    header,
    148,
    8,
    `checksum at byte ${offset}`,
    { checksum: true },
  )
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (actual !== expected) {
    throw new TypeError(`Tar header checksum mismatch at byte ${offset}`)
  }
}

function assertZeroBytes(bytes, start, length, location) {
  if (!bytes.subarray(start, start + length).every((byte) => byte === 0)) {
    throw new TypeError(`Tar ${location} must contain only zero bytes`)
  }
}

function assertNoSensitiveMetadata(text, location) {
  for (const [pattern, label] of FORBIDDEN_PACKED_TEXT) {
    if (pattern.test(text)) {
      throw new TypeError(`Tar metadata ${location} contains a ${label}`)
    }
  }
}

function parsePax(bytes, location, limits) {
  if (bytes.length > limits.paxBytes) {
    throw new TypeError(`PAX metadata exceeds the size limit in ${location}`)
  }
  const attributes = {}
  let offset = 0
  let recordCount = 0
  while (offset < bytes.length) {
    recordCount += 1
    if (recordCount > limits.paxRecords) {
      throw new TypeError(`PAX metadata has too many records in ${location}`)
    }
    const space = bytes.indexOf(0x20, offset)
    if (space === -1) throw new TypeError(`Malformed PAX length in ${location}`)
    const lengthText = bytes.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      throw new TypeError(`Malformed PAX length in ${location}`)
    }
    const length = Number(lengthText)
    const end = offset + length
    if (
      !Number.isSafeInteger(length)
      || end > bytes.length
      || bytes[end - 1] !== 0x0a
    ) {
      throw new TypeError(`Invalid PAX record bounds in ${location}`)
    }
    const record = utf8Decoder.decode(bytes.subarray(space + 1, end - 1))
    assertNoSensitiveMetadata(record, location)
    const equals = record.indexOf('=')
    if (equals <= 0) throw new TypeError(`Malformed PAX record in ${location}`)
    const key = record.slice(0, equals)
    if (key !== 'path') {
      throw new TypeError(`Unsupported PAX attribute ${key} in ${location}`)
    }
    if (key in attributes) {
      throw new TypeError(`Duplicate PAX attribute ${key} in ${location}`)
    }
    attributes[key] = record.slice(equals + 1)
    offset = end
  }
  if (recordCount === 0) {
    throw new TypeError(`PAX metadata is empty in ${location}`)
  }
  return attributes
}

function assertSafeArchivePath(archivePath) {
  const hasControlCharacter = [...archivePath].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
  if (
    hasControlCharacter
    || archivePath.includes('\\')
    || archivePath.startsWith('/')
  ) {
    throw new TypeError(`Unsafe tar path ${JSON.stringify(archivePath)}`)
  }
  const parts = archivePath.split('/')
  if (
    parts[0] !== 'package'
    || parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`Tar entry is outside package/: ${JSON.stringify(archivePath)}`)
  }
  if (archivePath.normalize('NFC') !== archivePath) {
    throw new TypeError(`Tar path is not NFC normalized: ${JSON.stringify(archivePath)}`)
  }
}

export function readPackageTarball(tarballBytes, limitOverrides = {}) {
  if (!Buffer.isBuffer(tarballBytes) || tarballBytes.length === 0) {
    throw new TypeError('Package tarball must be a non-empty Buffer')
  }
  const limits = { ...PACKAGE_TAR_LIMITS, ...limitOverrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid package tar limit ${name}`)
    }
  }
  if (tarballBytes.length > limits.compressedBytes) {
    throw new TypeError('Compressed package tarball exceeds the size limit')
  }
  const tar = gunzipSync(tarballBytes, { maxOutputLength: limits.uncompressedBytes })
  const entries = []
  let nextPax = {}
  let offset = 0
  let sawEnd = false
  let headerCount = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > tar.length
        || !tar.subarray(offset, offset + 1024).every((byte) => byte === 0)
      ) {
        throw new TypeError('Tarball must end with two zero header blocks')
      }
      sawEnd = true
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new TypeError('Tarball contains data after its end marker')
      }
      break
    }
    headerCount += 1
    if (headerCount > limits.entries) {
      throw new TypeError('Package tarball has too many entries')
    }
    verifyHeaderChecksum(header, offset)
    const name = tarString(header, 0, 100, `name at byte ${offset}`)
    const mode = tarOctal(header, 100, 8, `mode at byte ${offset}`)
    const uid = tarOctal(header, 108, 8, `uid at byte ${offset}`, {
      allowEmpty: true,
    })
    const gid = tarOctal(header, 116, 8, `gid at byte ${offset}`, {
      allowEmpty: true,
    })
    const size = tarOctal(header, 124, 12, `size at byte ${offset}`)
    tarOctal(header, 136, 12, `mtime at byte ${offset}`, { allowEmpty: true })
    const linkName = tarString(header, 157, 100, `link name at byte ${offset}`)
    if (tarString(header, 257, 6, `magic at byte ${offset}`) !== 'ustar') {
      throw new TypeError(`Unsupported tar magic at byte ${offset}`)
    }
    if (tarString(header, 263, 2, `version at byte ${offset}`) !== '00') {
      throw new TypeError(`Unsupported tar version at byte ${offset}`)
    }
    const userName = tarString(header, 265, 32, `user name at byte ${offset}`)
    const groupName = tarString(header, 297, 32, `group name at byte ${offset}`)
    const deviceMajor = tarOctal(
      header,
      329,
      8,
      `device major at byte ${offset}`,
      { allowEmpty: true },
    )
    const deviceMinor = tarOctal(
      header,
      337,
      8,
      `device minor at byte ${offset}`,
      { allowEmpty: true },
    )
    const prefix = tarString(header, 345, 155, `prefix at byte ${offset}`)
    assertZeroBytes(header, 500, 12, `reserved header bytes at byte ${offset}`)
    const rawPath = prefix ? `${prefix}/${name}` : name
    if (Buffer.byteLength(rawPath, 'utf8') > limits.pathBytes) {
      throw new TypeError(`Raw tar path exceeds the length limit: ${JSON.stringify(rawPath)}`)
    }
    assertSafeArchivePath(rawPath)
    for (const [value, location] of [
      [rawPath, `path at byte ${offset}`],
      [linkName, `link name at byte ${offset}`],
      [userName, `user name at byte ${offset}`],
      [groupName, `group name at byte ${offset}`],
    ]) assertNoSensitiveMetadata(value, location)
    if (
      uid !== 0
      || gid !== 0
      || linkName !== ''
      || userName !== ''
      || groupName !== ''
      || deviceMajor !== 0
      || deviceMinor !== 0
    ) {
      throw new TypeError(`Tar header has unsupported identity or device metadata at byte ${offset}`)
    }
    if (size > limits.entryBytes) {
      throw new TypeError(`Tar entry exceeds the per-entry size limit at byte ${offset}`)
    }
    if ((mode & ~0o777) !== 0) {
      throw new TypeError(`Tar entry has forbidden special mode bits at byte ${offset}`)
    }
    const type = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const paddedDataEnd = dataStart + Math.ceil(size / 512) * 512
    if (dataEnd > tar.length || paddedDataEnd > tar.length) {
      throw new TypeError(`Tar entry exceeds archive at byte ${offset}`)
    }
    if (!tar.subarray(dataEnd, paddedDataEnd).every((byte) => byte === 0)) {
      throw new TypeError(`Tar entry has nonzero padding at byte ${offset}`)
    }
    const data = tar.subarray(dataStart, dataEnd)
    if (type === 'g') {
      throw new TypeError(`Global PAX metadata is forbidden at byte ${offset}`)
    } else if (type === 'x') {
      if (Object.keys(nextPax).length > 0) {
        throw new TypeError('Tarball contains unused PAX metadata before another PAX header')
      }
      if (mode !== 0o644) {
        throw new TypeError(`PAX metadata has unsafe mode at byte ${offset}`)
      }
      nextPax = parsePax(data, rawPath || `PAX at byte ${offset}`, limits)
    } else {
      const attributes = nextPax
      nextPax = {}
      const archivePath = attributes.path ?? rawPath
      if (Buffer.byteLength(archivePath, 'utf8') > limits.pathBytes) {
        throw new TypeError(`Tar path exceeds the length limit: ${JSON.stringify(archivePath)}`)
      }
      assertSafeArchivePath(archivePath)
      if (type !== '0') {
        throw new TypeError(
          `Forbidden tar entry type ${JSON.stringify(type)} at ${archivePath}`,
        )
      }
      if (mode !== 0o644) {
        throw new TypeError(`Packed regular file has unsafe mode at ${archivePath}`)
      }
      entries.push({
        archivePath,
        path: archivePath.slice('package/'.length),
        type: 'file',
        size,
        mode,
        sha256: sha256Bytes(data),
        bytes: Buffer.from(data),
      })
    }
    offset = paddedDataEnd
  }
  if (!sawEnd) throw new TypeError('Tarball has no zero end marker')
  if (Object.keys(nextPax).length > 0) {
    throw new TypeError('Tarball ends with unused PAX metadata')
  }

  const exact = new Set()
  const folded = new Map()
  for (const entry of entries) {
    if (exact.has(entry.path)) throw new TypeError(`Duplicate tar path ${entry.path}`)
    exact.add(entry.path)
    const foldedPath = entry.path.normalize('NFC').toLocaleLowerCase('en-US')
    const previous = folded.get(foldedPath)
    if (previous && previous !== entry.path) {
      throw new TypeError(`Case-colliding tar paths: ${previous} and ${entry.path}`)
    }
    folded.set(foldedPath, entry.path)
  }
  return entries
}

function collectExportTargets(value, location = 'exports') {
  if (typeof value === 'string') return [{ location, target: value }]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${location} contains an unsupported export target`)
  }
  return Object.entries(value).flatMap(([key, nested]) => (
    collectExportTargets(nested, `${location}.${key}`)
  ))
}

export function scanPackedTextEntry(entry, { packageKind = 'karel' } = {}) {
  if (
    /(?:^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/iu.test(entry.path)
    || /\.(?:der|key|map|p12|pem|pfx)$/iu.test(entry.path)
  ) {
    throw new TypeError(`Packed file has a forbidden sensitive or binary name: ${entry.path}`)
  }
  if (!/\.(?:css|d\.ts|js|json|md|py|txt)$/u.test(entry.path)) {
    throw new TypeError(`Packed file has an unreviewed binary or text type: ${entry.path}`)
  }
  const text = utf8Decoder.decode(entry.bytes)
  if (text.includes('\0')) {
    throw new TypeError(`Packed ${entry.path} contains a NUL byte`)
  }
  const forbidden = [...FORBIDDEN_PACKED_TEXT]
  if (packageKind === 'karel' && /\.(?:d\.ts|js)$/u.test(entry.path)) {
    forbidden.push(
      [/(?:from\s*|import\s*\()\s*['"]@\//u, 'unresolved internal alias import'],
      [/['"]web-ide\/(?:src|dist)(?:\/|['"])/u, 'Web IDE internal import'],
      [/['"]\.\.\/web-ide(?:\/|['"])/u, 'sibling Web IDE import'],
    )
  }
  for (const [pattern, label] of forbidden) {
    if (pattern.test(text)) {
      throw new TypeError(`Packed ${entry.path} contains a ${label}`)
    }
  }
}

function pathSafeBasename(value) {
  if (
    value.includes('/')
    || value.includes('\\')
    || value === '.'
    || value === '..'
  ) return null
  return value
}

export function validateNpmPackResult(packResult, tarballBytes) {
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new TypeError('npm pack JSON must describe exactly one package')
  }
  const item = packResult[0]
  assertExactKeys(item, [
    'id',
    'name',
    'version',
    'size',
    'unpackedSize',
    'shasum',
    'integrity',
    'filename',
    'files',
    'entryCount',
    'bundled',
  ], [], 'npm pack result')
  for (const field of ['id', 'name', 'version', 'shasum', 'integrity', 'filename']) {
    assertNonEmptyString(item[field], `npm pack result.${field}`)
  }
  if (item.id !== `${item.name}@${item.version}`) {
    throw new TypeError('npm pack id does not match name/version')
  }
  if (item.filename !== pathSafeBasename(item.filename)) {
    throw new TypeError('npm pack filename is unsafe')
  }
  if (
    !Number.isSafeInteger(item.size)
    || !Number.isSafeInteger(item.unpackedSize)
    || !Number.isSafeInteger(item.entryCount)
  ) throw new TypeError('npm pack sizes and entry count must be safe integers')
  if (!/^[a-f0-9]{40}$/u.test(item.shasum)) {
    throw new TypeError('npm pack shasum is malformed')
  }
  if (!Array.isArray(item.files) || !Array.isArray(item.bundled)) {
    throw new TypeError('npm pack files and bundled fields must be arrays')
  }
  if (item.bundled.length !== 0) {
    throw new TypeError('npm pack unexpectedly contains bundled dependencies')
  }
  if (item.size !== tarballBytes.length) {
    throw new TypeError('npm pack byte size does not match tarball')
  }
  const sha1 = createHash('sha1').update(tarballBytes).digest('hex')
  if (item.shasum !== sha1) throw new TypeError('npm pack SHA-1 does not match tarball')
  if (item.integrity !== sha512IntegrityBytes(tarballBytes)) {
    throw new TypeError('npm pack SHA-512 integrity does not match tarball')
  }
  return item
}

function inspectKarelTarball(tarballBytes, { expectedManifest } = {}) {
  const entries = readPackageTarball(tarballBytes)
  const files = entries
  const byPath = new Map(files.map((entry) => [entry.path, entry]))
  const manifestEntry = byPath.get('package.json')
  if (!manifestEntry) throw new TypeError('Packed package has no package.json')
  const manifest = JSON.parse(utf8Decoder.decode(manifestEntry.bytes))
  assertExactKeys(
    manifest,
    EXPECTED_KAREL_MANIFEST_KEYS,
    [],
    'packed Karel package manifest',
  )
  if (
    manifest.name !== '@web-ide/karel'
    || manifest.version !== '0.3.0'
    || manifest.private !== true
    || manifest.license !== 'MIT'
  ) throw new TypeError('Packed Karel package identity, private flag, or license changed')
  const forbiddenLifecycleScripts = [
    'preinstall',
    'install',
    'postinstall',
    'prepack',
    'prepare',
    'postpack',
    'publish',
    'prepublish',
    'prepublishOnly',
  ]
  if (forbiddenLifecycleScripts.some((name) => name in manifest.scripts)) {
    throw new TypeError('Packed Karel package declares a forbidden lifecycle script')
  }
  const expectedScripts = expectedManifest?.scripts ?? EXPECTED_KAREL_SCRIPTS
  if (
    manifest.type !== 'module'
    || manifest.description
      !== 'A host-registered Karel companion plugin for Web IDE and generic Python runtime sessions.'
    || canonicalJSONString(manifest.engines)
      !== canonicalJSONString({ node: '>=20', python: '>=3.10' })
    || canonicalJSONString(manifest.sideEffects)
      !== canonicalJSONString(['*.css'])
    || canonicalJSONString(manifest.scripts)
      !== canonicalJSONString(expectedScripts)
    || manifest.packageManager !== 'npm@11.6.2'
  ) throw new TypeError('Packed Karel package behavior or engine policy changed')
  if (
    expectedManifest !== undefined
    && canonicalJSONString(manifest) !== canonicalJSONString(expectedManifest)
  ) throw new TypeError('Packed Karel manifest differs from the exact committed source manifest')
  const expectedPeers = {
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
    'web-ide': '>=0.3.0 <0.4.0',
  }
  if (JSON.stringify(manifest.peerDependencies) !== JSON.stringify(expectedPeers)) {
    throw new TypeError('Packed Karel peer dependency contract changed')
  }
  const expectedFiles = [
    'dist',
    'python/karel.py',
    'python/karel_world_contract.py',
    'python/starter.py',
    'worlds/default.json',
    'README.md',
    'SECURITY.md',
    'docs',
    'LICENSE.md',
    'THIRD_PARTY_NOTICES.md',
  ]
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw new TypeError('Packed Karel files allowlist changed')
  }
  if (
    JSON.stringify(sortStrings(files.map((file) => file.path)))
    !== JSON.stringify(EXPECTED_KAREL_PACKAGE_FILES)
  ) {
    throw new TypeError('Packed file inventory differs from the exact Karel allowlist')
  }
  for (const { location, target } of collectExportTargets(manifest.exports)) {
    if (!target.startsWith('./') || target.includes('..') || target.includes('\\')) {
      throw new TypeError(`${location} has unsafe target ${JSON.stringify(target)}`)
    }
    if (!byPath.has(target.slice(2))) {
      throw new TypeError(`${location} targets missing packed file ${target}`)
    }
  }
  for (const entry of files) scanPackedTextEntry(entry)

  return {
    entries,
    manifest,
    report: {
      schemaVersion: 1,
      package: '@web-ide/karel@0.3.0',
      result: 'pass',
      tarball: {
        filename: 'web-ide-karel-0.3.0.tgz',
        size: tarballBytes.length,
        sha256: sha256Bytes(tarballBytes),
        sha512Integrity: sha512IntegrityBytes(tarballBytes),
      },
      checks: {
        bundledDependencies: [],
        exportsResolved: true,
        internalPathAndSecretScanPassed: true,
        licenseAndRequiredFilesPresent: true,
        npmPackJsonMatched: true,
        pathsSafeAndCaseUnique: true,
        regularFilesOnly: true,
      },
      files: files
        .map(({ path, size, mode, sha256 }) => ({ path, size, mode, sha256 }))
        .sort((left, right) => (
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0
        )),
    },
  }
}

export function inspectExistingPackedPackage(tarballBytes, options = {}) {
  return inspectKarelTarball(tarballBytes, options)
}

export function inspectPackedPackage(packResult, tarballBytes, options = {}) {
  const pack = validateNpmPackResult(packResult, tarballBytes)
  const inspection = inspectKarelTarball(tarballBytes, options)
  const files = inspection.entries
  if (pack.name !== '@web-ide/karel' || pack.version !== '0.3.0') {
    throw new TypeError('npm pack Karel identity changed')
  }
  if (pack.entryCount !== files.length) {
    throw new TypeError('npm pack entry count does not match tar inventory')
  }
  if (pack.unpackedSize !== files.reduce((total, entry) => total + entry.size, 0)) {
    throw new TypeError('npm pack unpacked size does not match tar inventory')
  }
  const npmFiles = pack.files.map((file, index) => {
    assertExactKeys(file, ['path', 'size', 'mode'], [], `npm pack files[${index}]`)
    assertNonEmptyString(file.path, `npm pack files[${index}].path`)
    return file
  })
  if (
    JSON.stringify(sortStrings(npmFiles.map((file) => file.path)))
    !== JSON.stringify(sortStrings(files.map((file) => file.path)))
  ) throw new TypeError('npm pack JSON file list does not match tar inventory')
  const byPath = new Map(files.map((entry) => [entry.path, entry]))
  for (const file of npmFiles) {
    const entry = byPath.get(file.path)
    if (entry.size !== file.size || entry.mode !== file.mode) {
      throw new TypeError(`npm pack metadata mismatch for ${file.path}`)
    }
  }
  if (
    pack.filename !== inspection.report.tarball.filename
    || pack.integrity !== inspection.report.tarball.sha512Integrity
  ) throw new TypeError('npm pack tarball identity changed')
  return inspection
}
