import { canonicalJSONString } from './canonical-json.mjs'
import { assertExactKeys, sha256Bytes } from './release-utils.mjs'

export const EXPECTED_PRODUCTION_CONSUMER_MANIFEST = Object.freeze({
  name: 'web-ide-karel-packed-production-consumer',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: {
    typecheck: 'tsc -b',
    build: 'vite build',
    'test:production': 'playwright test --config playwright.config.ts',
  },
  dependencies: {
    '@web-ide/karel': 'file:artifacts/web-ide-karel.tgz',
    react: '19.2.8',
    'react-dom': '19.2.8',
    'web-ide': 'file:artifacts/web-ide.tgz',
  },
  devDependencies: {
    '@playwright/test': '1.62.1',
    '@types/node': '24.13.3',
    '@types/react': '19.2.18',
    '@types/react-dom': '19.2.4',
    '@vitejs/plugin-react': '5.2.0',
    buffer: '6.0.3',
    events: '3.3.0',
    'path-browserify': '1.0.1',
    process: '0.11.10',
    'stream-browserify': '3.0.0',
    typescript: '5.9.3',
    vite: '7.3.6',
    'vite-plugin-wasm': '3.6.0',
  },
  packageManager: 'npm@11.6.2',
})

const EXPECTED_LOCK_ROOT = Object.freeze({
  name: EXPECTED_PRODUCTION_CONSUMER_MANIFEST.name,
  version: EXPECTED_PRODUCTION_CONSUMER_MANIFEST.version,
  dependencies: EXPECTED_PRODUCTION_CONSUMER_MANIFEST.dependencies,
  devDependencies: EXPECTED_PRODUCTION_CONSUMER_MANIFEST.devDependencies,
})

const EXPECTED_WEB_IDE_LOCK_ENTRY = Object.freeze({
  version: '0.2.0',
  resolved: 'file:artifacts/web-ide.tgz',
  license: 'MIT',
  peer: true,
  workspaces: ['examples/basic', 'examples/plugin-demo'],
  dependencies: { 'debugger-sh': '0.3.15' },
  engines: { node: '^20.19.0 || >=22.12.0' },
  peerDependencies: {
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
  },
})

const EXPECTED_KAREL_LOCK_ENTRY = Object.freeze({
  version: '0.2.0',
  resolved: 'file:artifacts/web-ide-karel.tgz',
  license: 'MIT',
  engines: { node: '>=20', python: '>=3.10' },
  peerDependencies: {
    react: '^18.3.0 || ^19.0.0',
    'react-dom': '^18.3.0 || ^19.0.0',
    'web-ide': '>=0.2.0 <0.3.0',
  },
})

// This digest closes the complete reviewed npm v3 lock graph while permitting
// only the two private package artifact bytes to be rebound. Those two
// integrities are validated as canonical SHA-512 values and, in final mode,
// against the independently inspected tarballs below. Any package-key,
// transitive version, registry URL, Git reference, lifecycle flag, or other
// node-field change necessarily changes this digest.
const ARTIFACT_INTEGRITY_PLACEHOLDER
  = 'ARTIFACT-INTEGRITY-VALIDATED-SEPARATELY'
const EXPECTED_NORMALIZED_LOCK_SHA256
  = '0098fbf163ae5262ca010d476eedeb1dca074b3a8e59e8b5691695f4795cd287'

function assertSha512Integrity(value, location) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new TypeError(`${location} must be one canonical SHA-512 integrity`)
  }
  const encoded = value.slice('sha512-'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new TypeError(`${location} must be one canonical SHA-512 integrity`)
  }
}

function validateArtifactEntry(entry, expected, location) {
  assertExactKeys(
    entry,
    [...Object.keys(expected), 'integrity'],
    [],
    location,
  )
  const { integrity, ...identity } = entry
  assertSha512Integrity(integrity, `${location}.integrity`)
  if (canonicalJSONString(identity) !== canonicalJSONString(expected)) {
    throw new TypeError(`${location} identity differs from the locked release contract`)
  }
  return integrity
}

function validateReactEntries(packages) {
  const react = packages['node_modules/react']
  assertExactKeys(react, [
    'version', 'resolved', 'integrity', 'license', 'peer', 'engines',
  ], [], 'packed consumer React lock entry')
  if (
    react.version !== '19.2.8'
    || react.resolved
      !== 'https://registry.npmjs.org/react/-/react-19.2.8.tgz'
    || react.license !== 'MIT'
    || react.peer !== true
    || canonicalJSONString(react.engines)
      !== canonicalJSONString({ node: '>=0.10.0' })
  ) throw new TypeError('Packed consumer React lock entry differs from the exact contract')
  assertSha512Integrity(react.integrity, 'packed consumer React integrity')

  const reactDOM = packages['node_modules/react-dom']
  assertExactKeys(reactDOM, [
    'version', 'resolved', 'integrity', 'license', 'peer', 'dependencies',
    'peerDependencies',
  ], [], 'packed consumer React DOM lock entry')
  if (
    reactDOM.version !== '19.2.8'
    || reactDOM.resolved
      !== 'https://registry.npmjs.org/react-dom/-/react-dom-19.2.8.tgz'
    || reactDOM.license !== 'MIT'
    || reactDOM.peer !== true
    || canonicalJSONString(reactDOM.dependencies)
      !== canonicalJSONString({ scheduler: '^0.27.0' })
    || canonicalJSONString(reactDOM.peerDependencies)
      !== canonicalJSONString({ react: '^19.2.8' })
  ) throw new TypeError('Packed consumer React DOM lock entry differs from the exact contract')
  assertSha512Integrity(reactDOM.integrity, 'packed consumer React DOM integrity')
}

export function validateProductionConsumerManifest(manifest) {
  assertExactKeys(
    manifest,
    Object.keys(EXPECTED_PRODUCTION_CONSUMER_MANIFEST),
    [],
    'packed consumer manifest',
  )
  if (
    canonicalJSONString(manifest)
      !== canonicalJSONString(EXPECTED_PRODUCTION_CONSUMER_MANIFEST)
  ) throw new TypeError('Packed consumer manifest differs from the exact release contract')
  return manifest
}

export function validateProductionConsumerLock(
  lock,
  {
    webIDEIntegrity,
    karelIntegrity,
    requireWebIDEIntegrity = false,
    requireKarelIntegrity = false,
  } = {},
) {
  assertExactKeys(lock, [
    'name', 'version', 'lockfileVersion', 'requires', 'packages',
  ], [], 'packed consumer lockfile')
  if (
    lock.name !== EXPECTED_LOCK_ROOT.name
    || lock.version !== EXPECTED_LOCK_ROOT.version
    || lock.lockfileVersion !== 3
    || lock.requires !== true
    || !lock.packages
    || typeof lock.packages !== 'object'
    || Array.isArray(lock.packages)
  ) throw new TypeError('Packed consumer lockfile root identity is wrong')
  assertExactKeys(
    lock.packages[''],
    Object.keys(EXPECTED_LOCK_ROOT),
    [],
    'packed consumer lockfile root package',
  )
  if (
    canonicalJSONString(lock.packages[''])
      !== canonicalJSONString(EXPECTED_LOCK_ROOT)
  ) throw new TypeError('Packed consumer lock root differs from its exact manifest')

  const lockedWebIDEIntegrity = validateArtifactEntry(
    lock.packages['node_modules/web-ide'],
    EXPECTED_WEB_IDE_LOCK_ENTRY,
    'packed consumer Web IDE lock entry',
  )
  const lockedKarelIntegrity = validateArtifactEntry(
    lock.packages['node_modules/@web-ide/karel'],
    EXPECTED_KAREL_LOCK_ENTRY,
    'packed consumer Karel lock entry',
  )
  validateReactEntries(lock.packages)
  const normalizedLock = structuredClone(lock)
  normalizedLock.packages['node_modules/web-ide'].integrity
    = ARTIFACT_INTEGRITY_PLACEHOLDER
  normalizedLock.packages['node_modules/@web-ide/karel'].integrity
    = ARTIFACT_INTEGRITY_PLACEHOLDER
  const normalizedDigest = sha256Bytes(Buffer.from(
    canonicalJSONString(normalizedLock),
  ))
  if (normalizedDigest !== EXPECTED_NORMALIZED_LOCK_SHA256) {
    throw new TypeError(
      'Packed consumer complete transitive lock graph differs from the reviewed contract',
    )
  }
  if (requireWebIDEIntegrity && lockedWebIDEIntegrity !== webIDEIntegrity) {
    throw new TypeError('Packed consumer Web IDE integrity is not exact')
  }
  if (requireKarelIntegrity && lockedKarelIntegrity !== karelIntegrity) {
    throw new TypeError('Packed consumer Karel integrity is not exact')
  }
  return {
    karel: {
      reference: EXPECTED_KAREL_LOCK_ENTRY.resolved,
      integrity: lockedKarelIntegrity,
      binding: lockedKarelIntegrity === karelIntegrity ? 'exact' : 'pending',
    },
    webIDE: {
      reference: EXPECTED_WEB_IDE_LOCK_ENTRY.resolved,
      integrity: lockedWebIDEIntegrity,
      binding: lockedWebIDEIntegrity === webIDEIntegrity ? 'exact' : 'pending',
    },
  }
}
