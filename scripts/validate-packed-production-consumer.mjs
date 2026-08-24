import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isolatedNpmEnvironment,
  reportAndCleanupPackedConsumer,
  withVerifiedPackedCandidates,
} from './packed-candidates.mjs'

const EXPECTED_VERSION = '0.2.0'
const EXPECTED_KAREL_PEERS = Object.freeze({
  react: '^18.3.0 || ^19.0.0',
  'react-dom': '^18.3.0 || ^19.0.0',
  'web-ide': '>=0.2.0 <0.3.0',
})
const EXPECTED_REACT_VERSION = '19.2.8'
const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptRoot, '..')
const projectsRoot = path.dirname(repositoryRoot)
const webIDERoot = path.join(projectsRoot, 'web-ide')
const fixtureRoot = path.join(repositoryRoot, 'tests/production/consumer')
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), 'web-ide-karel-packed-production-'),
)
const packRoot = path.join(temporaryRoot, 'packed')
const consumerRoot = path.join(temporaryRoot, 'consumer')
const npmCacheRoot = path.join(temporaryRoot, 'npm-cache')
const keepTemporary = process.env.KEEP_KAREL_PRODUCTION_CONSUMER === '1'
const diagnosticGrep = process.env.KAREL_PRODUCTION_DIAGNOSTIC_GREP
const requestedArtifactParent = process.env.KAREL_PRODUCTION_ARTIFACT_DIR
const artifactParent = requestedArtifactParent === undefined
  ? tmpdir()
  : path.resolve(requestedArtifactParent)
let artifactRoot
let strictInstallEnvironment

function run(command, args, options = {}) {
  const cwd = options.cwd ?? consumerRoot
  const result = spawnSync(command, args, {
    cwd,
    env: options.env ?? strictInstallEnvironment,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    }
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${String(result.status)}`,
    )
  }
  return result
}

async function assertPackage(root, expectedName) {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  )
  if (manifest.name !== expectedName || manifest.version !== EXPECTED_VERSION) {
    throw new Error(
      `Expected ${expectedName}@${EXPECTED_VERSION} at ${root}, found ${String(manifest.name)}@${String(manifest.version)}`,
    )
  }
}

async function packPackage(root, expectedName) {
  await assertPackage(root, expectedName)
  run('npm', ['run', 'build:library'], { cwd: root })
  const result = run(
    'npm',
    ['pack', '--pack-destination', packRoot, '--json'],
    { cwd: root, capture: true },
  )
  const records = JSON.parse(result.stdout)
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`npm pack returned an unexpected result for ${expectedName}`)
  }
  const record = records[0]
  if (
    record.name !== expectedName
    || record.version !== EXPECTED_VERSION
    || typeof record.filename !== 'string'
  ) {
    throw new Error(
      `npm pack returned the wrong identity for ${expectedName}@${EXPECTED_VERSION}`,
    )
  }
  const tarballPath = path.resolve(packRoot, record.filename)
  if (path.dirname(tarballPath) !== packRoot) {
    throw new Error(`npm pack returned an unsafe filename for ${expectedName}`)
  }
  return tarballPath
}

async function resolveCandidates() {
  const webIDEOverride = process.env.WEB_IDE_CANDIDATE_TARBALL
  const karelOverride = process.env.KAREL_CANDIDATE_TARBALL
  if ((webIDEOverride === undefined) !== (karelOverride === undefined)) {
    throw new Error(
      'WEB_IDE_CANDIDATE_TARBALL and KAREL_CANDIDATE_TARBALL must be supplied together',
    )
  }
  if (webIDEOverride !== undefined && karelOverride !== undefined) {
    return {
      '@web-ide/karel': karelOverride,
      'web-ide': webIDEOverride,
    }
  }

  await mkdir(packRoot, { recursive: true })
  return {
    '@web-ide/karel': await packPackage(repositoryRoot, '@web-ide/karel'),
    'web-ide': await packPackage(webIDERoot, 'web-ide'),
  }
}

async function copyFixture() {
  const excluded = new Set([
    'artifacts',
    'dist',
    'node_modules',
    'playwright-report',
    'test-results',
  ])
  await cp(fixtureRoot, consumerRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(fixtureRoot, source)
      return !relative
        .split(path.sep)
        .some((part) => excluded.has(part) || part.endsWith('.tsbuildinfo'))
    },
  })
  await materializeTemplates(consumerRoot)
}

async function materializeTemplates(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await materializeTemplates(entryPath)
    } else if (entry.name.endsWith('.template')) {
      await rename(entryPath, entryPath.slice(0, -'.template'.length))
    }
  }
}

async function assertFixtureUsesPublicExportsOnly() {
  const prohibited = [
    /(?:from|import)\s*['"][^'"]*\/src(?:\/|['"])/u,
    /(?:from|import)\s*['"][^'"]*\/dist(?:\/|['"])/u,
    /(?:from|import)\s*['"]\.\.\//u,
  ]
  for (const sourcePath of await filesUnder(path.join(fixtureRoot, 'src'))) {
    const source = await readFile(sourcePath, 'utf8')
    if (prohibited.some((pattern) => pattern.test(source))) {
      throw new Error(
        `Production consumer must use package public exports only: ${sourcePath}`,
      )
    }
  }
}

async function assertInstalledPackagePair() {
  const webIDE = JSON.parse(await readFile(path.join(
    consumerRoot,
    'node_modules/web-ide/package.json',
  ), 'utf8'))
  const karel = JSON.parse(await readFile(path.join(
    consumerRoot,
    'node_modules/@web-ide/karel/package.json',
  ), 'utf8'))
  for (const [manifest, expectedName] of [
    [webIDE, 'web-ide'],
    [karel, '@web-ide/karel'],
  ]) {
    if (manifest.name !== expectedName || manifest.version !== EXPECTED_VERSION) {
      throw new Error(
        `Installed packed candidate must be ${expectedName}@${EXPECTED_VERSION}, found ${String(manifest.name)}@${String(manifest.version)}`,
      )
    }
  }
  for (const [peer, expectedRange] of Object.entries(EXPECTED_KAREL_PEERS)) {
    if (karel.peerDependencies?.[peer] !== expectedRange) {
      throw new Error(
        `Installed @web-ide/karel peer ${peer} must be ${expectedRange}, found ${String(karel.peerDependencies?.[peer])}`,
      )
    }
  }
  process.stdout.write(
    `Installed exact pair: web-ide@${webIDE.version} + @web-ide/karel@${karel.version}\n`,
  )
}

function assertSingleReactIdentity() {
  const result = run(
    'npm',
    ['ls', 'react', 'react-dom', '--all', '--json'],
    { capture: true },
  )
  process.stdout.write(result.stdout)
  const tree = JSON.parse(result.stdout)
  const versions = new Map([
    ['react', new Set()],
    ['react-dom', new Set()],
  ])
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (versions.has(name) && typeof dependency?.version === 'string') {
        versions.get(name).add(dependency.version)
      }
      visit(dependency)
    }
  }
  visit(tree)
  for (const [name, resolvedVersions] of versions) {
    if (
      resolvedVersions.size !== 1
      || !resolvedVersions.has(EXPECTED_REACT_VERSION)
    ) {
      throw new Error(
        `Expected one exact ${name}@${EXPECTED_REACT_VERSION} identity, found: ${[...resolvedVersions].join(', ') || 'none'}`,
      )
    }
    process.stdout.write(
      `Packed consumer ${name} identity: ${name}@${EXPECTED_REACT_VERSION}\n`,
    )
  }
}

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files.sort()
}

async function reportArtifacts() {
  const artifacts = await filesUnder(artifactRoot)
  const screenshots = artifacts.filter((file) => file.endsWith('.png'))
  process.stdout.write(
    `Production evidence: ${screenshots.length} screenshots, ${artifacts.length} total artifacts\n`,
  )
  for (const artifact of artifacts) {
    const content = await readFile(artifact)
    const sha256 = createHash('sha256').update(content).digest('hex')
    process.stdout.write(
      `${path.relative(artifactRoot, artifact)} sha256=${sha256} bytes=${content.byteLength}\n`,
    )
  }
  process.stdout.write(`Retained production evidence: ${artifactRoot}\n`)
}

try {
  await mkdir(artifactParent, { recursive: true })
  artifactRoot = await mkdtemp(
    path.join(artifactParent, 'web-ide-karel-production-evidence-'),
  )
  await mkdir(npmCacheRoot, { recursive: true })
  strictInstallEnvironment = {
    ...isolatedNpmEnvironment(process.env, npmCacheRoot),
    KAREL_PRODUCTION_ARTIFACT_DIR: artifactRoot,
  }

  await assertFixtureUsesPublicExportsOnly()
  const candidates = await resolveCandidates()
  await copyFixture()

  await withVerifiedPackedCandidates({
    consumerRoot,
    candidates,
    consume: async (verified) => {
      for (const candidate of verified) {
        process.stdout.write(
          `${candidate.packageName}@${candidate.expectedVersion}: ${candidate.sourcePath} sha256=${candidate.sha256} sha512=${candidate.integrity} bytes=${candidate.bytes}\n`,
        )
      }
      run('npm', [
        'ci',
        '--ignore-scripts',
        '--strict-peer-deps',
        '--engine-strict',
        '--no-fund',
        '--no-audit',
      ])
      await assertInstalledPackagePair()
      assertSingleReactIdentity()
      run('npm', ['audit', '--audit-level=low'])
      run('npm', ['audit', '--omit=dev', '--audit-level=low'])
      run('npm', ['run', 'typecheck'])
      run('npm', ['run', 'build'])
      if (diagnosticGrep) {
        process.stdout.write(
          `DIAGNOSTIC ONLY: running packed production tests matching ${JSON.stringify(diagnosticGrep)}\n`,
        )
        run('npm', ['run', 'test:production', '--', '--grep', diagnosticGrep])
      } else {
        run('npm', ['run', 'test:production'])
      }

      const outputFiles = await readdir(path.join(consumerRoot, 'dist'))
      process.stdout.write(
        `${diagnosticGrep ? 'Targeted packed production diagnostic passed' : 'Packed production consumer passed'}; dist entries: ${outputFiles.sort().join(', ')}\n`,
      )
    },
  })
} catch (error) {
  process.exitCode = 1
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
} finally {
  await reportAndCleanupPackedConsumer({
    keepTemporary,
    report: async () => {
      if (artifactRoot !== undefined) await reportArtifacts()
    },
    cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    onRetained: () => {
      process.stdout.write(`Retained production consumer: ${temporaryRoot}\n`)
    },
  })
}
