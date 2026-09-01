import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  GIT_BINARY,
  git,
  gitArguments,
  hermeticGitEnvironment,
  run,
  verifyHermeticGitRepository,
} from './process-utils.mjs'
import { repositoryRoot, sha256Bytes } from './release-utils.mjs'

const MAX_SOURCE_ARCHIVE_TAR_BYTES = 256 * 1024 * 1024

function clean(value) {
  return value.trim()
}

function normalizeRepository(value) {
  return value
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '')
}

async function archiveReferenceIdentity(root, reference) {
  const objectId = clean((await git([
    'rev-parse',
    '--verify',
    `${reference}^{object}`,
  ], { cwd: root })).stdout)
  const peeledCommit = clean((await git([
    'rev-parse',
    '--verify',
    `${reference}^{commit}`,
  ], { cwd: root })).stdout)
  return { objectId, peeledCommit, reference }
}

export function assertReleaseSourceStateUnchanged(expected, actual) {
  if (canonicalJSONString(actual) !== canonicalJSONString(expected)) {
    throw new TypeError('Release source identity changed during evidence generation')
  }
  return actual
}

async function commonSourceState(configuration, root) {
  await verifyHermeticGitRepository(root)
  const gitAtRoot = (arguments_) => git(arguments_, { cwd: root })
  const branch = clean((await gitAtRoot([
    'symbolic-ref',
    '--short',
    'HEAD',
  ])).stdout)
  if (branch !== 'main') {
    throw new TypeError(`Release source branch must be main, received ${branch}`)
  }
  const head = clean((await gitAtRoot(['rev-parse', 'HEAD'])).stdout)
  const tree = clean((await gitAtRoot(['rev-parse', 'HEAD^{tree}'])).stdout)
  const sourceEpoch = Number(clean((await gitAtRoot([
    'show',
    '-s',
    '--format=%ct',
    'HEAD',
  ])).stdout))
  if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch <= 0) {
    throw new TypeError('Release source commit timestamp is invalid')
  }
  const tracking = clean((await gitAtRoot([
    'rev-parse',
    'refs/remotes/origin/main',
  ])).stdout)
  if (head !== tracking) throw new TypeError('HEAD does not match refs/remotes/origin/main')
  const remote = clean((await gitAtRoot([
    'config',
    '--local',
    '--no-includes',
    '--get',
    'remote.origin.url',
  ])).stdout)
  if (normalizeRepository(remote) !== normalizeRepository(configuration.sourceRepository)) {
    throw new TypeError(`origin URL does not match release input: ${remote}`)
  }
  const remoteMain = clean((await gitAtRoot([
    'ls-remote',
    configuration.sourceRepository,
    'refs/heads/main',
  ])).stdout).split(/\s+/u)[0]
  if (remoteMain !== head) throw new TypeError('HEAD does not match live remote origin/main')
  const nodeVersion = process.versions.node
  const npmVersion = clean((await run('npm', ['--version'])).stdout)
  if (
    nodeVersion !== configuration.nodeVersion
    || npmVersion !== configuration.npmVersion
  ) {
    throw new TypeError(
      `Release toolchain mismatch: expected Node ${configuration.nodeVersion}/npm ${configuration.npmVersion}, received Node ${nodeVersion}/npm ${npmVersion}`,
    )
  }
  return {
    branch,
    commit: head,
    tree,
    remote,
    nodeVersion,
    npmVersion,
    sourceEpoch,
  }
}

export async function verifyReleaseSourceState(
  configuration,
  root = repositoryRoot,
) {
  const common = await commonSourceState(configuration, root)
  const gitAtRoot = (arguments_) => git(arguments_, { cwd: root })
  const status = clean((await gitAtRoot([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])).stdout)
  if (status) throw new TypeError(`Release source worktree is dirty:\n${status}`)
  const tagObjectId = clean((await gitAtRoot([
    'rev-parse',
    `refs/tags/${configuration.sourceTag}`,
  ])).stdout)
  const tagObjectType = clean((await gitAtRoot([
    'cat-file',
    '-t',
    `refs/tags/${configuration.sourceTag}`,
  ])).stdout)
  const tagCommit = clean((await gitAtRoot([
    'rev-parse',
    `refs/tags/${configuration.sourceTag}^{commit}`,
  ])).stdout)
  if (tagObjectType !== 'tag') {
    throw new TypeError(`Source tag ${configuration.sourceTag} must be annotated`)
  }
  if (tagCommit !== common.commit) {
    throw new TypeError(`Source tag ${configuration.sourceTag} is not at HEAD`)
  }
  const remoteTags = clean((await gitAtRoot([
    'ls-remote',
    configuration.sourceRepository,
    `refs/tags/${configuration.sourceTag}`,
    `refs/tags/${configuration.sourceTag}^{}`,
  ])).stdout)
  const remoteTagRefs = new Map(remoteTags
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [objectId, reference] = line.split(/\s+/u)
      return [reference, objectId]
    }))
  if (
    remoteTagRefs.get(`refs/tags/${configuration.sourceTag}`) !== tagObjectId
    || remoteTagRefs.get(`refs/tags/${configuration.sourceTag}^{}`)
      !== common.commit
  ) {
    throw new TypeError(
      `Remote source tag ${configuration.sourceTag} is missing or does not resolve to HEAD`,
    )
  }
  return {
    ...common,
    finalEligible: true,
    sourceReference: configuration.sourceTag,
    tag: {
      name: configuration.sourceTag,
      objectId: tagObjectId,
      objectType: tagObjectType,
      peeledCommit: tagCommit,
    },
    worktreeClean: true,
  }
}

export async function inspectNonFinalSourceState(
  configuration,
  root = repositoryRoot,
) {
  const common = await commonSourceState(configuration, root)
  const status = clean((await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ], { cwd: root })).stdout)
  return {
    ...common,
    finalEligible: false,
    requestedTag: configuration.sourceTag,
    sourceReference: common.commit,
    tag: null,
    worktreeClean: status.length === 0,
  }
}

export async function sourceArchiveBytes(
  configuration,
  { root = repositoryRoot, reference = configuration.sourceTag } = {},
) {
  const referenceBefore = await archiveReferenceIdentity(root, reference)
  await verifyHermeticGitRepository(root)
  const tar = await new Promise((resolve, reject) => {
    const child = spawn(GIT_BINARY, gitArguments([
      '-c',
      'tar.umask=0002',
      'archive',
      '--format=tar',
      '--prefix=web-ide-karel-0.3.2/',
      reference,
    ]), {
      cwd: root,
      env: hermeticGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = []
    let outputBytes = 0
    let outputLimitExceeded = false
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (outputLimitExceeded) return
      outputBytes += chunk.length
      if (outputBytes > MAX_SOURCE_ARCHIVE_TAR_BYTES) {
        outputLimitExceeded = true
        child.kill('SIGTERM')
        return
      }
      output.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (outputLimitExceeded) {
        reject(new TypeError('git archive exceeded the source archive size limit'))
      } else if (code !== 0) {
        reject(new Error(`git archive failed (${code}): ${stderr.trimEnd()}`))
      } else {
        resolve(Buffer.concat(output))
      }
    })
  })
  await verifyHermeticGitRepository(root)
  const referenceAfter = await archiveReferenceIdentity(root, reference)
  await verifyHermeticGitRepository(root)
  if (
    canonicalJSONString(referenceAfter)
      !== canonicalJSONString(referenceBefore)
  ) {
    throw new TypeError('Git archive source reference changed during generation')
  }
  const bytes = gzipSync(tar, { level: 9, mtime: 0 })
  return { bytes, size: bytes.length, sha256: sha256Bytes(bytes) }
}
