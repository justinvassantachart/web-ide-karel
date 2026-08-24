import { createHash } from 'node:crypto'

import { canonicalJSONString } from './canonical-json.mjs'
import { assertSha256, sortStrings } from './release-utils.mjs'

function npmPurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function deterministicUuidV5(name) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const bytes = createHash('sha1')
    .update(namespace)
    .update(name)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function sriHash(integrity, location) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new TypeError(`${location} must have SHA-512 integrity`)
  }
  const encoded = integrity.slice('sha512-'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new TypeError(`${location} SHA-512 integrity is malformed`)
  }
  return { alg: 'SHA-512', content: bytes.toString('hex') }
}

function peerComponent(peer) {
  const ref = npmPurl(peer.name, peer.version)
  const integrity = peer.name === 'web-ide'
    ? peer.artifact.sha512Integrity
    : peer.integrity
  const reference = peer.name === 'web-ide'
    ? `https://github.com/justinvassantachart/ths-ide/releases/download/web-ide-v0.3.0/${peer.artifact.fileName}`
    : peer.resolved
  return {
    type: 'library',
    'bom-ref': ref,
    name: peer.name,
    version: peer.version,
    purl: ref,
    scope: 'required',
    hashes: [sriHash(integrity, peer.name)],
    licenses: [{ expression: peer.license }],
    externalReferences: [{ type: 'distribution', url: reference }],
    properties: [
      { name: 'web-ide-karel:evidence:inclusion', value: 'peer-external' },
      { name: 'web-ide-karel:evidence:peer-range', value: peer.peerRange },
    ],
  }
}

export function generateCycloneDx({
  packageManifest,
  inspection,
  licenseReport,
  webIDEEvidence,
}) {
  const candidate = inspection.tarball
  assertSha256(candidate.sha256, 'SBOM candidate SHA-256')
  const rootRef = npmPurl(packageManifest.name, packageManifest.version)
  const fileComponents = inspection.files.map((file) => {
    const ref = `urn:web-ide-karel:package-file:${file.sha256}:${encodeURIComponent(file.path)}`
    return {
      type: 'file',
      'bom-ref': ref,
      name: file.path,
      hashes: [{ alg: 'SHA-256', content: file.sha256 }],
      licenses: [{ expression: 'MIT' }],
      properties: [
        { name: 'web-ide-karel:evidence:inclusion', value: 'package-file' },
        { name: 'web-ide-karel:evidence:size', value: String(file.size) },
      ],
    }
  })
  const peerComponents = licenseReport.externalPeers.map(peerComponent)
  const components = [...fileComponents, ...peerComponents].sort((left, right) => (
    left['bom-ref'] < right['bom-ref']
      ? -1
      : left['bom-ref'] > right['bom-ref'] ? 1 : 0
  ))
  const componentRefs = components.map((component) => component['bom-ref'])
  const identity = [
    packageManifest.name,
    packageManifest.version,
    candidate.sha256,
    webIDEEvidence.report.candidateState.sha256,
    ...componentRefs,
  ].join('\n')
  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuidV5(identity)}`,
    version: 1,
    metadata: {
      component: {
        type: 'library',
        'bom-ref': rootRef,
        name: packageManifest.name,
        version: packageManifest.version,
        purl: rootRef,
        hashes: [{ alg: 'SHA-256', content: candidate.sha256 }],
        licenses: [{ expression: packageManifest.license }],
        properties: [
          {
            name: 'web-ide-karel:evidence:bundled-dependencies',
            value: '[]',
          },
          {
            name: 'web-ide-karel:evidence:candidate-filename',
            value: candidate.filename,
          },
          {
            name: 'web-ide-karel:evidence:candidate-size',
            value: String(candidate.size),
          },
          {
            name: 'web-ide-karel:evidence:runtime-owner-candidate-state-sha256',
            value: webIDEEvidence.report.candidateState.sha256,
          },
        ],
      },
      properties: [
        {
          name: 'web-ide-karel:evidence:source',
          value: 'independent-npm-pack-and-safe-tar-inventory',
        },
      ],
    },
    components,
    dependencies: [
      { ref: rootRef, dependsOn: sortStrings(componentRefs) },
      ...sortStrings(componentRefs).map((ref) => ({ ref, dependsOn: [] })),
    ],
  }
}

export function validateCycloneDx(document, inputs) {
  const expected = generateCycloneDx(inputs)
  if (canonicalJSONString(document) !== canonicalJSONString(expected)) {
    throw new TypeError('CycloneDX SBOM does not match independently regenerated evidence')
  }
  return document
}
