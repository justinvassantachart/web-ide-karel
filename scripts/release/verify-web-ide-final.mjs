import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { validateProductionConsumerLock } from './consumer-lock.mjs'
import { loadReleaseConfiguration } from './release-inputs.mjs'
import {
  assertExternalInputFile,
  repositoryRoot,
} from './release-utils.mjs'
import { verifyWebIDEEvidence } from './web-ide-evidence.mjs'

const manifestInput = process.env.KAREL_RELEASE_WEB_IDE_MANIFEST
const tarballInput = process.env.KAREL_RELEASE_WEB_IDE_TARBALL
if (!manifestInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_MANIFEST is required')
if (!tarballInput) throw new TypeError('KAREL_RELEASE_WEB_IDE_TARBALL is required')

const configuration = await loadReleaseConfiguration()
const manifestPath = await assertExternalInputFile(
  manifestInput,
  'Web IDE final verification manifest',
)
const tarballPath = await assertExternalInputFile(
  tarballInput,
  'Web IDE final verification package',
)
const consumerLock = JSON.parse(await readFile(path.join(
  repositoryRoot,
  'tests/production/consumer/package-lock.json',
), 'utf8'))
validateProductionConsumerLock(consumerLock)
const evidence = await verifyWebIDEEvidence({
  configuration,
  manifestPath,
  tarballPath,
  consumerLock,
  mode: 'final',
})
process.stdout.write(
  `Verified exact final Web IDE ${evidence.report.artifact.sha256} and runtime evidence ${evidence.report.runtimeEvidence.sha256}\n`,
)
