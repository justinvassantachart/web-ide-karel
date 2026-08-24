import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'

export const GIT_BINARY = '/usr/bin/git'
const ACCOUNT_HOME = userInfo().homedir
const GIT_CREDENTIAL_HELPER = 'osxkeychain'

const SAFE_GIT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export function hermeticGitEnvironment(baseEnvironment = process.env) {
  const environment = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_VALUE_0: GIT_CREDENTIAL_HELPER,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOME: ACCOUNT_HOME,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: SAFE_GIT_PATH,
    XDG_CONFIG_HOME: '/var/empty',
  }
  for (const key of [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
  ]) {
    if (baseEnvironment[key] !== undefined) environment[key] = baseEnvironment[key]
  }
  return environment
}

export function gitArguments(arguments_) {
  return ['-c', `credential.helper=${GIT_CREDENTIAL_HELPER}`, ...arguments_]
}

export async function run(command, arguments_, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(
          `${command} ${arguments_.join(' ')} failed (${signal ?? code})\n${stderr.trimEnd()}`,
        ))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export async function git(arguments_, options = {}) {
  return await run(GIT_BINARY, gitArguments(arguments_), {
    ...options,
    env: hermeticGitEnvironment(options.env),
  })
}

const FORBIDDEN_LOCAL_CONFIG = [
  /^include(?:if)?\./u,
  /^url\./u,
  /^credential\./u,
  /^http\./u,
  /^protocol\./u,
  /^filter\./u,
  /^tar\./u,
  /^extensions\.worktreeconfig$/u,
  /^core\.(?:attributesfile|excludesfile|fsmonitor|gitproxy|hookspath|sshcommand|worktree)$/u,
  /^remote\..*\.(?:proxy|receivepack|uploadpack)$/u,
]

const FORBIDDEN_GIT_STATE_FILES = Object.freeze([
  Object.freeze({
    relativePath: 'info/grafts',
    description: 'Git object indirection',
  }),
  Object.freeze({
    relativePath: 'objects/info/alternates',
    description: 'Git object indirection',
  }),
  Object.freeze({
    relativePath: 'info/attributes',
    description: 'Git archive attributes',
  }),
  Object.freeze({
    relativePath: 'config.worktree',
    description: 'Git worktree configuration',
  }),
])

export async function verifyHermeticGitRepository(root) {
  const { stdout } = await git([
    'config',
    '--local',
    '--no-includes',
    '--name-only',
    '--null',
    '--list',
  ], { cwd: root })
  const keys = stdout.split('\0').filter(Boolean).map((key) => key.toLowerCase())
  const forbidden = keys.find((key) => FORBIDDEN_LOCAL_CONFIG.some(
    (pattern) => pattern.test(key),
  ))
  if (forbidden) {
    throw new TypeError(`Release repository has forbidden local Git config ${forbidden}`)
  }
  const replacements = (await git([
    'for-each-ref',
    '--format=%(refname)',
    'refs/replace',
  ], { cwd: root })).stdout.trim()
  if (replacements) {
    throw new TypeError(`Release repository has forbidden replace refs:\n${replacements}`)
  }
  const shallow = (await git([
    'rev-parse',
    '--is-shallow-repository',
  ], { cwd: root })).stdout.trim()
  if (shallow !== 'false') {
    throw new TypeError('Release repository must be a complete non-shallow clone')
  }
  for (const { relativePath, description } of FORBIDDEN_GIT_STATE_FILES) {
    const gitPathOutput = (await git([
      'rev-parse',
      '--git-path',
      relativePath,
    ], { cwd: root })).stdout.trim()
    const gitPath = path.isAbsolute(gitPathOutput)
      ? gitPathOutput
      : path.resolve(root, gitPathOutput)
    try {
      const info = await lstat(gitPath)
      if (!info.isFile()) {
        throw new TypeError(`Forbidden ${description} at ${relativePath}`)
      }
      const handle = await open(gitPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const openedInfo = await handle.stat()
        const probe = Buffer.alloc(1)
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
        if (
          !openedInfo.isFile()
          || openedInfo.dev !== info.dev
          || openedInfo.ino !== info.ino
          || bytesRead > 0
        ) {
          throw new TypeError(`Forbidden ${description} at ${relativePath}`)
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
