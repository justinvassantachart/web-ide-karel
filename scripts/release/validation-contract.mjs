import path from 'node:path'

import { repositoryRoot } from './release-utils.mjs'

const npmExecutable = path.join(path.dirname(process.execPath), 'npm')
const MINUTE_MS = 60 * 1000

export const VALIDATION_TERMINATION_GRACE_MS = 10 * 1000

export const VALIDATION_GATE_SPECS = new Map([
  ['validate-production', Object.freeze({
    command: 'WEB_IDE_CANDIDATE_TARBALL=<web-candidate> KAREL_CANDIDATE_TARBALL=<karel-candidate> npm run validate:production',
    executable: npmExecutable,
    argv: ['run', 'validate:production'],
    timeoutMs: 45 * MINUTE_MS,
  })],
  ['packed-exact-pair', Object.freeze({
    command: 'WEB_IDE_CANDIDATE_TARBALL=<web-candidate> KAREL_CANDIDATE_TARBALL=<karel-candidate> npm run test:packed-production',
    executable: npmExecutable,
    argv: ['run', 'test:packed-production'],
    timeoutMs: 20 * MINUTE_MS,
  })],
  ['audit-production', Object.freeze({
    command: 'npm audit --omit=dev --audit-level=low',
    executable: npmExecutable,
    argv: ['audit', '--omit=dev', '--audit-level=low'],
    timeoutMs: 10 * MINUTE_MS,
  })],
  ['audit-full', Object.freeze({
    command: 'npm audit --audit-level=low',
    executable: npmExecutable,
    argv: ['audit', '--audit-level=low'],
    timeoutMs: 10 * MINUTE_MS,
  })],
  ['reproducibility', Object.freeze({
    command: 'KAREL_RELEASE_OUTPUT_DIR=<fresh-output> KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE=<web-candidate-state> KAREL_RELEASE_WEB_IDE_TARBALL=<web-candidate> npm run release:candidate',
    executable: npmExecutable,
    argv: ['run', 'release:candidate'],
    timeoutMs: 45 * MINUTE_MS,
  })],
  ['web-ide-peer-evidence', Object.freeze({
    command: 'Exact Web IDE artifact-manifest, sidecar, package and runtime-assets evidence verification',
    executable: process.execPath,
    argv: [path.join(repositoryRoot, 'scripts/release/verify-web-ide-final.mjs')],
    timeoutMs: 5 * MINUTE_MS,
  })],
])

export const EXPECTED_VALIDATION_GATES = new Map(
  [...VALIDATION_GATE_SPECS].map(([id, spec]) => [id, spec.command]),
)

export const VALIDATION_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  'ALL_PROXY',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_FILE',
])
