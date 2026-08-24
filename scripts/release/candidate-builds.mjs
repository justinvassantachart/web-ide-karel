import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  inspectPackedPackage,
  PACKAGE_TAR_LIMITS,
} from './package-inspection.mjs'
import { git, run } from './process-utils.mjs'
import {
  isolatedNpmEnvironment,
  readBoundedFile,
  repositoryRoot,
} from './release-utils.mjs'

async function materializeWebIDE(entries, destination) {
  await mkdir(destination, { recursive: false })
  for (const entry of entries) {
    const target = path.join(destination, entry.path)
    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.bytes, { flag: 'wx' })
    await chmod(target, entry.mode)
  }
}

async function buildOne({
  workRoot,
  index,
  sourceCommit,
  sourceEpoch,
  configuration,
  webIDEEntries,
  expectedPackageManifest,
}) {
  const buildRoot = path.join(workRoot, `build-${index}`)
  const cloneDirectory = path.join(buildRoot, 'web-ide-karel')
  const webIDERoot = path.join(buildRoot, 'web-ide')
  const cacheDirectory = path.join(workRoot, `npm-cache-${index}`)
  const homeDirectory = path.join(workRoot, `home-${index}`)
  const temporaryDirectory = path.join(workRoot, `tmp-${index}`)
  const userConfigPath = path.join(workRoot, `user-npmrc-${index}`)
  const globalConfigPath = path.join(workRoot, `global-npmrc-${index}`)
  const packDirectory = path.join(workRoot, `pack-${index}`)
  await mkdir(buildRoot, { recursive: true })
  await mkdir(homeDirectory, { recursive: false })
  await mkdir(temporaryDirectory, { recursive: false })
  await mkdir(packDirectory, { recursive: true })
  await Promise.all([
    writeFile(userConfigPath, '', { flag: 'wx' }),
    writeFile(globalConfigPath, '', { flag: 'wx' }),
  ])
  await git([
    'clone',
    '--quiet',
    '--no-hardlinks',
    '--no-checkout',
    repositoryRoot,
    cloneDirectory,
  ])
  await git(['checkout', '--quiet', '--detach', sourceCommit], {
    cwd: cloneDirectory,
  })
  const initialStatus = (await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], { cwd: cloneDirectory })).stdout
  if (initialStatus !== '') {
    throw new TypeError(`Isolated Karel build ${index} did not begin clean`)
  }
  await materializeWebIDE(webIDEEntries, webIDERoot)
  const environment = isolatedNpmEnvironment(
    process.env,
    cacheDirectory,
    sourceEpoch,
    {
      homeRoot: homeDirectory,
      temporaryRoot: temporaryDirectory,
      userConfigPath,
      globalConfigPath,
    },
  )
  await run('npm', [
    'ci',
    '--ignore-scripts',
    '--strict-peer-deps',
    '--engine-strict',
    '--no-audit',
    '--no-fund',
    '--cache',
    cacheDirectory,
  ], { cwd: cloneDirectory, env: environment, inherit: true })
  await run('npm', ['run', 'build:library'], {
    cwd: cloneDirectory,
    env: environment,
    inherit: true,
  })
  const packProcess = await run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDirectory,
  ], { cwd: cloneDirectory, env: environment })
  const packResult = JSON.parse(packProcess.stdout)
  const filename = packResult?.[0]?.filename
  if (filename !== configuration.releaseAssetFilename) {
    throw new TypeError(
      `Isolated Karel build ${index} produced unexpected asset ${JSON.stringify(filename)}`,
    )
  }
  const tarballBytes = await readBoundedFile(
    path.join(packDirectory, filename),
    PACKAGE_TAR_LIMITS.compressedBytes,
    `Isolated Karel build ${index} tarball`,
  )
  const inspection = inspectPackedPackage(packResult, tarballBytes, {
    expectedManifest: expectedPackageManifest,
  })
  const finalStatus = (await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], { cwd: cloneDirectory })).stdout
  if (finalStatus !== '') {
    throw new TypeError(`Isolated Karel build ${index} changed tracked source state`)
  }
  return { tarballBytes, inspection }
}

export async function settleAllBuilds(builds) {
  const results = await Promise.allSettled(builds)
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more isolated deterministic Karel builds failed',
    )
  }
  return results.map((result) => result.value)
}

export async function buildDeterministicCandidates({
  outputDirectory,
  sourceCommit,
  sourceEpoch,
  configuration,
  webIDEEntries,
  expectedPackageManifest,
}) {
  const workRoot = path.join(outputDirectory, '.isolated-builds')
  await mkdir(workRoot, { recursive: false })
  try {
    const [first, second] = await settleAllBuilds([
      buildOne({
        workRoot,
        index: 1,
        sourceCommit,
        sourceEpoch,
        configuration,
        webIDEEntries,
        expectedPackageManifest,
      }),
      buildOne({
        workRoot,
        index: 2,
        sourceCommit,
        sourceEpoch,
        configuration,
        webIDEEntries,
        expectedPackageManifest,
      }),
    ])
    if (!first.tarballBytes.equals(second.tarballBytes)) {
      throw new TypeError('Two clean isolated Karel builds produced different tarballs')
    }
    if (
      canonicalJSONString(first.inspection.report)
      !== canonicalJSONString(second.inspection.report)
    ) {
      throw new TypeError('Two clean isolated Karel builds produced different inventories')
    }
    const candidatePath = path.join(
      outputDirectory,
      configuration.releaseAssetFilename,
    )
    await copyFile(
      path.join(workRoot, 'pack-1', configuration.releaseAssetFilename),
      candidatePath,
      fsConstants.COPYFILE_EXCL,
    )
    return {
      candidatePath,
      tarballBytes: first.tarballBytes,
      entries: first.inspection.entries,
      packageManifest: first.inspection.manifest,
      inspection: first.inspection.report,
      determinism: {
        schemaVersion: 1,
        package: configuration.package,
        result: 'pass',
        isolatedBuildCount: 2,
        exactWebIDEArtifactMaterializedForBothBuilds: true,
        packageTarballsByteIdentical: true,
        packageInventoriesCanonicalByteIdentical: true,
        sourceTrackedStateCleanBeforeAndAfter: true,
      },
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}
