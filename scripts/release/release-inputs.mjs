import path from 'node:path'

import {
  assertExactKeys,
  assertNonEmptyString,
  readJSON,
  repositoryRoot,
} from './release-utils.mjs'

export async function loadReleaseConfiguration() {
  const input = await readJSON(path.join(
    repositoryRoot,
    'release/release-input.json',
  ))
  assertExactKeys(input, [
    'schemaVersion',
    'package',
    'sourceRepository',
    'sourceTag',
    'sourceAssetFilename',
    'capabilityReleaseId',
    'packageRole',
    'releaseRepository',
    'releaseTag',
    'releaseAssetFilename',
    'nodeVersion',
    'npmVersion',
    'webIDE',
  ], [], 'release input')
  if (input.schemaVersion !== 1 || input.package !== '@web-ide/karel@0.2.0') {
    throw new TypeError('Unsupported Karel release input identity')
  }
  for (const field of Object.keys(input).filter((key) => (
    key !== 'schemaVersion' && key !== 'webIDE'
  ))) {
    assertNonEmptyString(input[field], `release input.${field}`)
  }
  if (
    input.capabilityReleaseId !== 'hamilton.python-karel/1'
    || input.packageRole !== 'karel'
    || input.sourceTag !== 'web-ide-karel-v0.2.0-source-r4'
  ) {
    throw new TypeError('Release input does not match the accepted Hamilton Karel identity')
  }
  if (
    input.releaseAssetFilename !== 'web-ide-karel-0.2.0.tgz'
    || input.sourceAssetFilename !== 'web-ide-karel-0.2.0-source.tar.gz'
  ) {
    throw new TypeError('Release asset names do not match Karel 0.2.0')
  }
  assertExactKeys(input.webIDE, [
    'package',
    'peerRange',
    'packageRole',
    'sourceTag',
    'releaseRepository',
    'releaseTag',
    'releaseAssetFilename',
    'artifactManifestFilename',
    'runtimeEvidenceFilename',
  ], [], 'release input.webIDE')
  for (const [field, value] of Object.entries(input.webIDE)) {
    assertNonEmptyString(value, `release input.webIDE.${field}`)
  }
  if (
    input.webIDE.package !== 'web-ide@0.2.0'
    || input.webIDE.peerRange !== '>=0.2.0 <0.3.0'
    || input.webIDE.packageRole !== 'web-ide'
    || input.webIDE.sourceTag !== 'web-ide-v0.2.0-source-r4'
    || input.webIDE.releaseAssetFilename !== 'web-ide-0.2.0.tgz'
    || input.webIDE.artifactManifestFilename !== 'artifact-manifest.json'
    || input.webIDE.runtimeEvidenceFilename !== 'runtime-assets-verification.json'
  ) {
    throw new TypeError('Release input has an unsupported Web IDE peer identity')
  }
  return input
}
