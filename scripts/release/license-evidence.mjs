import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { canonicalJSONString } from './canonical-json.mjs'
import {
  assertExactKeys,
  readJSON,
  repositoryRoot,
  sha256Bytes,
  sortStrings,
} from './release-utils.mjs'

function normalizedText(bytes, source) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(`License evidence is not UTF-8: ${source}`, {
      cause: error,
    })
  }
  return `${text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\s+$/u, '')}\n`
}

function licenseTextRecord(bytes, source) {
  const text = normalizedText(bytes, source)
  return {
    source,
    sha256: sha256Bytes(bytes),
    normalizedSha256: sha256Bytes(Buffer.from(text)),
    text,
  }
}

function validatePolicy(policy) {
  assertExactKeys(policy, [
    'schemaVersion',
    'package',
    'packageLicense',
    'packageLicenseTextPath',
    'externalPeers',
  ], [], 'license policy')
  if (
    policy.schemaVersion !== 1
    || policy.package !== '@web-ide/karel@0.3.2'
    || policy.packageLicense !== 'MIT'
    || policy.packageLicenseTextPath !== 'LICENSE.md'
  ) throw new TypeError('Unsupported Karel license policy identity')
  if (!Array.isArray(policy.externalPeers) || policy.externalPeers.length !== 2) {
    throw new TypeError('Karel license policy must contain two React peer records')
  }
  const names = []
  for (const [index, peer] of policy.externalPeers.entries()) {
    assertExactKeys(peer, [
      'name',
      'license',
      'licenseTextPath',
      'licenseTextSha256',
    ], [], `license policy externalPeers[${index}]`)
    if (
      !['react', 'react-dom'].includes(peer.name)
      || peer.license !== 'MIT'
      || peer.licenseTextPath !== `node_modules/${peer.name}/LICENSE`
      || !/^[a-f0-9]{64}$/u.test(peer.licenseTextSha256)
    ) throw new TypeError(`Unsupported license policy peer ${String(peer.name)}`)
    names.push(peer.name)
  }
  if (JSON.stringify(names) !== JSON.stringify(['react', 'react-dom'])) {
    throw new TypeError('Karel license policy peers must be exact and sorted')
  }
  return policy
}

async function reactPeerRecord({
  policyPeer,
  packageManifest,
  packageLock,
  consumerLock,
}) {
  const lockPath = `node_modules/${policyPeer.name}`
  const rootEntry = packageLock.packages?.[lockPath]
  const consumerEntry = consumerLock.packages?.[lockPath]
  if (
    !rootEntry
    || !consumerEntry
    || rootEntry.version !== consumerEntry.version
    || rootEntry.integrity !== consumerEntry.integrity
    || rootEntry.resolved !== consumerEntry.resolved
    || rootEntry.license !== policyPeer.license
    || consumerEntry.license !== policyPeer.license
  ) throw new TypeError(`${policyPeer.name} root and consumer lock identities differ`)
  const installedManifest = await readJSON(path.join(
    repositoryRoot,
    lockPath,
    'package.json',
  ))
  if (
    installedManifest.name !== policyPeer.name
    || installedManifest.version !== rootEntry.version
    || installedManifest.license !== policyPeer.license
  ) throw new TypeError(`${policyPeer.name} installed package does not match its lock`)
  const licenseBytes = await readFile(path.join(
    repositoryRoot,
    policyPeer.licenseTextPath,
  ))
  const license = licenseTextRecord(licenseBytes, policyPeer.licenseTextPath)
  if (license.sha256 !== policyPeer.licenseTextSha256) {
    throw new TypeError(`${policyPeer.name} installed license text does not match policy`)
  }
  return {
    kind: 'peer-external',
    name: policyPeer.name,
    version: rootEntry.version,
    peerRange: packageManifest.peerDependencies[policyPeer.name],
    license: policyPeer.license,
    resolved: rootEntry.resolved,
    integrity: rootEntry.integrity,
    licenseText: {
      source: license.source,
      sha256: license.sha256,
      normalizedSha256: license.normalizedSha256,
    },
    text: license.text,
  }
}

export async function generateLicenseEvidence({
  policy,
  packageManifest,
  packageLock,
  consumerLock,
  packageEntries,
  inspection,
  webIDEEvidence,
}) {
  validatePolicy(policy)
  const entryByPath = new Map(packageEntries
    .filter((entry) => entry.type === 'file')
    .map((entry) => [entry.path, entry]))
  const ownLicenseEntry = entryByPath.get(policy.packageLicenseTextPath)
  if (!ownLicenseEntry) throw new TypeError('Karel tarball has no own license text')
  const ownLicense = licenseTextRecord(
    ownLicenseEntry.bytes,
    policy.packageLicenseTextPath,
  )
  if (!webIDEEvidence.licenseEntry) {
    throw new TypeError('Verified Web IDE artifact has no license entry')
  }
  const webLicense = licenseTextRecord(
    webIDEEvidence.licenseEntry.bytes,
    `${webIDEEvidence.report.artifact.fileName}:LICENSE.md`,
  )
  const webPeer = {
    kind: 'peer-external',
    name: 'web-ide',
    version: webIDEEvidence.report.package.version,
    peerRange: packageManifest.peerDependencies['web-ide'],
    license: webIDEEvidence.report.package.license,
    artifact: webIDEEvidence.report.artifact,
    candidateState: webIDEEvidence.report.candidateState,
    licenseText: {
      source: webLicense.source,
      sha256: webLicense.sha256,
      normalizedSha256: webLicense.normalizedSha256,
    },
    text: webLicense.text,
  }
  const reactPeers = []
  for (const policyPeer of policy.externalPeers) {
    reactPeers.push(await reactPeerRecord({
      policyPeer,
      packageManifest,
      packageLock,
      consumerLock,
    }))
  }
  const peerRecords = [webPeer, ...reactPeers].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))
  const packageFiles = inspection.files.map((file) => ({
    ...file,
    license: policy.packageLicense,
    licenseTextSha256: ownLicense.normalizedSha256,
  }))
  const machinePeerRecords = peerRecords.map((peer) => {
    const record = { ...peer }
    delete record.text
    return record
  })
  const report = {
    schemaVersion: 1,
    package: '@web-ide/karel@0.3.2',
    bundledDependencies: [],
    packageFileLicense: {
      expression: policy.packageLicense,
      source: ownLicense.source,
      sha256: ownLicense.sha256,
      normalizedSha256: ownLicense.normalizedSha256,
    },
    packageFiles,
    externalPeers: machinePeerRecords,
    runtimeAssetOwnership: {
      ownerPackageRole: 'web-ide',
      candidateStateSha256:
        webIDEEvidence.report.candidateState.sha256,
      runtimeEvidenceSha256:
        webIDEEvidence.report.runtimeEvidence.sha256,
    },
  }

  const textByHash = new Map()
  for (const record of [
    { name: '@web-ide/karel', text: ownLicense.text, hash: ownLicense.normalizedSha256 },
    ...peerRecords.map((peer) => ({
      name: peer.name,
      text: peer.text,
      hash: peer.licenseText.normalizedSha256,
    })),
  ]) textByHash.set(record.hash, record.text)
  const sections = [
    'WEB IDE KAREL 0.3.2 LICENSE EVIDENCE',
    '',
    'Generated deterministically from the exact package inventory, package locks,',
    'and the verified external Web IDE candidate state.',
    '',
    'PACKAGE FILES',
    '',
    `All ${packageFiles.length} packed Karel files: MIT`,
    `License text: ${ownLicense.source} (normalized SHA-256 ${ownLicense.normalizedSha256})`,
    'npm pack bundled dependencies: []',
    '',
    'EXTERNAL PEERS',
    '',
    ...peerRecords.flatMap((peer) => [
      `${peer.name}@${peer.version}`,
      `Peer range: ${peer.peerRange}`,
      `License: ${peer.license}`,
      `License text: ${peer.licenseText.source} (normalized SHA-256 ${peer.licenseText.normalizedSha256})`,
      '',
    ]),
    'RUNTIME ASSET OWNERSHIP',
    '',
    'Runtime assets are owned by Web IDE and verified against its exact candidate state.',
    `Web IDE candidate state SHA-256: ${webIDEEvidence.report.candidateState.sha256}`,
    `Web IDE runtime report SHA-256: ${webIDEEvidence.report.runtimeEvidence.sha256}`,
    '',
    'DEDUPLICATED LICENSE TEXTS',
    '',
  ]
  for (const digest of sortStrings(textByHash.keys())) {
    sections.push(
      `===== normalized SHA-256 ${digest} =====`,
      '',
      textByHash.get(digest).trimEnd(),
      '',
    )
  }
  return {
    report,
    reportBytes: canonicalJSONString(report),
    textBytes: `${sections.join('\n').trimEnd()}\n`,
  }
}
