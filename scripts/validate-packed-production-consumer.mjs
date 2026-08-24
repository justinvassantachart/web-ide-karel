import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const keepTemporary = process.env.KEEP_KAREL_PRODUCTION_CONSUMER === '1'
const diagnosticGrep = process.env.KAREL_PRODUCTION_DIAGNOSTIC_GREP
const requestedArtifactParent = process.env.KAREL_PRODUCTION_ARTIFACT_DIR
const artifactParent = requestedArtifactParent === undefined
  ? tmpdir()
  : path.resolve(requestedArtifactParent)
await mkdir(artifactParent, { recursive: true })
const artifactRoot = await mkdtemp(
  path.join(artifactParent, 'web-ide-karel-production-evidence-'),
)

const strictInstallEnvironment = {
  ...process.env,
  KAREL_PRODUCTION_ARTIFACT_DIR: artifactRoot,
  npm_config_engine_strict: 'true',
  npm_config_strict_peer_deps: 'true',
}

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
  if (manifest.name !== expectedName) {
    throw new Error(
      `Expected ${expectedName} at ${root}, found ${String(manifest.name)}`,
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
  const tarballPath = path.join(packRoot, record.filename)
  const sha256 = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex')
  process.stdout.write(
    `${expectedName}@${record.version}: ${record.filename} sha256=${sha256}\n`,
  )
  return { filename: record.filename, path: tarballPath, sha256 }
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

async function installPackedArtifacts(webIDE, karel) {
  const artifactRoot = path.join(consumerRoot, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  await cp(webIDE.path, path.join(artifactRoot, webIDE.filename))
  await cp(karel.path, path.join(artifactRoot, karel.filename))

  const manifestPath = path.join(consumerRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['web-ide'] = `file:./artifacts/${webIDE.filename}`
  manifest.dependencies['@web-ide/karel'] =
    `file:./artifacts/${karel.filename}`
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
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
    if (resolvedVersions.size !== 1) {
      throw new Error(
        `Expected one resolved ${name} identity, found: ${[...resolvedVersions].join(', ') || 'none'}`,
      )
    }
    process.stdout.write(
      `Packed consumer ${name} identity: ${name}@${[...resolvedVersions][0]}\n`,
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
  await mkdir(packRoot, { recursive: true })
  await assertFixtureUsesPublicExportsOnly()
  const webIDE = await packPackage(webIDERoot, 'web-ide')
  const karel = await packPackage(repositoryRoot, '@web-ide/karel')

  await copyFixture()
  await installPackedArtifacts(webIDE, karel)

  run('npm', [
    'install',
    '--strict-peer-deps',
    '--engine-strict',
    '--no-fund',
    '--no-audit',
  ])
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
} catch (error) {
  process.exitCode = 1
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
} finally {
  await reportArtifacts()
  if (keepTemporary) {
    process.stdout.write(`Retained production consumer: ${temporaryRoot}\n`)
  } else {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
