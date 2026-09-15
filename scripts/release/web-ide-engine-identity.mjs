// Web IDE 0.3.x installed debugger-sh from the public npm registry and the
// browser downloaded the engine WebAssembly at run time, so those manifests
// carry a runtime.debuggerSh registry record and lock the engine WASM as one
// of 27 remote runtime assets.
//
// Web IDE 0.4.0 installs a public GitHub release asset of the
// justinvassantachart/engine fork instead. The fork is deliberately never an
// npm release, and its build embeds the engine WebAssembly inside its own
// module, so the 0.4.0 manifest carries a runtime.engine fork record, locks 26
// remote runtime assets with no engine WASM among them, and must never fetch
// the fork asset at run time.
export const ENGINE_PACKAGE_NAME = 'debugger-sh'
export const WEB_IDE_040_ENGINE_ASSET_URL
  = 'https://github.com/justinvassantachart/engine/releases/download/debugger-sh-v0.3.15-webide.0.4.0.1/debugger-sh-0.3.15-webide.0.4.0.1.tgz'

// Exact fork artifact and build identities, checked against the packed bytes.
const WEB_IDE_040_FORK_ENGINE = Object.freeze({
  version: '0.3.15-webide.0.4.0.1',
  sourceRepository: 'https://github.com/justinvassantachart/engine',
  sourceCommit: 'b7236bda9c8fef31cd771fe770c2145f11ac0682',
  sourceAcceptedBaseCommit: '58cbc9369e3f7738a6dc9b01082723d144bb9c97',
  upstreamRepository: 'https://github.com/debugger-sh/engine',
  upstreamVersion: '0.3.15',
  upstreamCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
  buildKind: 'embedded-wasm-library-build',
  buildToolchain: Object.freeze({
    node: 'v24.11.1',
    npm: '11.6.2',
    rustc: 'rustc 1.95.0 (59807616e 2026-04-14)',
    cargo: 'cargo 1.95.0 (f2d3ce0bd 2026-03-21)',
    wasmPack: 'wasm-pack 0.14.0',
  }),
  distributionMechanism: 'public-github-release-asset',
  distributionRepository: 'justinvassantachart/engine',
  distributionTag: 'debugger-sh-v0.3.15-webide.0.4.0.1',
  distributionAssetFilename: 'debugger-sh-0.3.15-webide.0.4.0.1.tgz',
  distributionUrl: WEB_IDE_040_ENGINE_ASSET_URL,
  distributionSize: 27818347,
  distributionSha256:
    'feaaf9da592ee6be8ee68705bd2c2ad79db69528df4fcdf2d1c20b01b51f1bf7',
  distributionSha512Integrity:
    'sha512-EMYupTFpj9buXYwQ9yt8vZNr7yEaKG7K4/9KHmPMhPN+RRk+/Zm0oyTsJlt5Xjcb7Z3XtWGRkz5dnAt2S4X7iA==',
  wasmPath: 'dist/engine_bg.wasm',
  wasmSize: 8880594,
  wasmSha256:
    'df46b583db11d22ed49006746cdf630e3632f3a34499798d4dc19b7634928d24',
  modulePath: 'dist/debugger-sh.js',
  moduleSize: 23760324,
  moduleSha256:
    'fc29a20e6318c41583fae83fddef24c7ee068001ad2f43e97acb6154b319f6b4',
})

const WEB_ENGINE_IDENTITIES = Object.freeze({
  '0.3.0': Object.freeze({
    evidenceKey: 'debuggerSh',
    dependencySpecifier: '0.3.15',
    runtimeAssetCount: 27,
    registry: Object.freeze({
      version: '0.3.15',
      sourceTag: 'v0.3.15',
      sourceCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
    }),
  }),
  '0.3.1': Object.freeze({
    evidenceKey: 'debuggerSh',
    dependencySpecifier: '0.3.15',
    runtimeAssetCount: 27,
    registry: Object.freeze({
      version: '0.3.15',
      sourceTag: 'v0.3.15',
      sourceCommit: 'cc250508fabb5b091075e073ceb2e14899fd8423',
    }),
  }),
  '0.4.0': Object.freeze({
    evidenceKey: 'engine',
    dependencySpecifier: WEB_IDE_040_ENGINE_ASSET_URL,
    runtimeAssetCount: 26,
    fork: WEB_IDE_040_FORK_ENGINE,
  }),
})

export function engineIdentity(webIDEVersion) {
  const identity = WEB_ENGINE_IDENTITIES[webIDEVersion]
  if (!identity) {
    throw new TypeError(`Web IDE ${String(webIDEVersion)} has no reviewed engine dependency identity`)
  }
  return identity
}
