# Publishing readiness

`@web-ide/karel@0.2.0` r6, `0.3.0`, `0.3.1`, and `0.3.2` are MIT-licensed
immutable private releases. Their exact release evidence, source tags, Hamilton
release tags, and capability bindings remain unchanged. The packages remain
`private: true` and are not published to npm; `0.3.0` stays bound to
`hamilton.python-karel/2`, `0.3.1` stays bound to `hamilton.python-karel/3`,
and `0.3.2` stays bound to `hamilton.python-karel/5` with its published
`>=0.3.0 <0.4.0` peer range, annotated source tag
`web-ide-karel-v0.3.2-source-r3`, and Hamilton release tag
`web-ide-karel-v0.3.2`. The abandoned `web-ide-karel-v0.3.2-source` and `-r2`
prepublication checkpoints remain retained and unreleased.

The current forward-only release workflow targets package `0.3.3`, annotated
source tag `web-ide-karel-v0.3.3-source`, Hamilton release tag
`web-ide-karel-v0.3.3`, exact Web IDE `0.4.0`, and capability release
`hamilton.python-karel/8`. These inputs do not themselves establish a release:
the final source commit/tag objects, candidate digests, manifest identity, and
uploaded asset hashes exist only after the complete final workflow succeeds.
No `0.3.3` tag or release is created by the checked-in scripts.

`0.3.3` is a compatibility-only successor. Its Web IDE peer range widens to
`>=0.3.0 <0.4.0 || 0.4.0`, admitting exactly the one reviewed Web IDE `0.4.0`
build and no later `0.4.x` or `0.5`. No packaged runtime, declaration, Python,
or world source file changed from `0.3.2`; the packaged manifest and documentation
did, so final-mode validation binds their exact candidate bytes.

The packed-production consumer commits one npm v3 lock for the stable local
references `artifacts/web-ide.tgz` and `artifacts/web-ide-karel.tgz`. Validation
copies an exact candidate pair to those names, checks the copied SHA-512 values
against the lock, and only then runs a script-disabled `npm ci` with strict peer
and engine checks in a new cache. The normal source gate builds the adjacent
Web IDE and current Karel checkouts. A release-candidate pair can be checked
without rebuilding it:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.4.0.tgz \
KAREL_CANDIDATE_TARBALL=/absolute/path/web-ide-karel-0.3.3.tgz \
  npm run test:packed-production
```

The `0.3.3` artifact must independently produce all of the following evidence
for its exact digest:

- a reviewed per-file license/provenance inventory and production SBOM;
- two clean, reproducible package builds with identical artifact bytes;
- the complete production validation gate against the exact candidate pair;
- immutable private-release publication after its source commits are pushed;
- an independent re-download whose digest matches the published asset and the
  downstream receipt; and
- downstream cache seeding and retention under the consuming host's policy.

The earlier annotated `v0.2.0` and `web-ide-karel-v0.2.0-source-r2` through
`web-ide-karel-v0.2.0-source-r5` tags are retained unchanged as abandoned
prepublication checkpoints: no Hamilton release or uploaded asset was created
from them. The r2 and r3 candidates were superseded with their paired Web
captures; r4 failed closed on Vitest's ANSI-prefixed repository path, and r5
failed closed on the receipt runner's own temporary-directory label.
The completed forward-only evidence run used
`web-ide-karel-v0.2.0-source-r6`; that tag and every earlier checkpoint remain
immutable.

The historical capability identifiers remain recorded only in their immutable
evidence, not in package runtime contracts. The `0.3.3` Karel artifact manifest
uses schema 2 and the exact sorted singleton `capabilityReleaseIds` list
`["hamilton.python-karel/8"]`; the exact Web IDE `0.4.0` peer manifest is
expected to carry `["hamilton.python-karel/8", "hamilton.python/4"]`, and the
immutable Web IDE `0.3.1` manifest retains
`["hamilton.python-karel/4", "hamilton.python/2"]`. Hamilton's retained
`hamilton.python/3` and `hamilton.python-karel/6` compositions are historical
and are not rebound here. Published URLs,
credentials, and host cache state remain distribution-owned records and are
not embedded in the package.

## Deterministic evidence and dependency order

The checked-in `release/` inputs and `scripts/release/` tooling define the
forward-only `0.3.3` fail-closed workflow. Candidate generation binds
the canonical Web IDE candidate state, exact Web tarball, Web-owned runtime
verification report, committed consumer lock, exact pushed/tagged Karel source,
two isolated byte-identical Karel packs, independent safe tar inventory,
per-file license inventory, deduplicated license text, and CycloneDX SBOM. Its
outputs are external and it performs no tag, release, or upload mutation.

The sequence is intentionally:

1. publish the reviewed `debugger-sh` fork build as the public GitHub release
   asset that Web IDE `0.4.0` resolves -- tag
   `debugger-sh-v0.3.15-webide.0.4.0.1` in `justinvassantachart/engine`, never
   npm -- then generate Web IDE's final candidate state, tarball, and runtime
   report from its exact annotated `web-ide-v0.4.0-source` tag;
2. commit the exact Web candidate into Karel's packed-consumer lock and generate
   the exact Karel candidate;
3. run the unfiltered exact-pair compatibility gate through the isolated capture
   runner in receipt mode and provide its complete normalized capture log,
   including the final canonical receipt line, to Web IDE; normalization
   replaces only declared repository, candidate, execution, workspace, and home
   roots with stable placeholders and fails if a local user or temporary path
   remains;
4. finalize Web IDE's artifact manifest; then
5. finalize Karel's manifest against that exact Web manifest and sidecar.

This prevents a circular manifest dependency. Karel's candidate state is a
pre-manifest binding, not a substitute for Web IDE's final manifest. Karel
finalization must prove the manifest names the same Web source commit/tree/tag,
tar SHA-256/SHA-512, and runtime report used at candidate generation.
The final Karel manifest uses a slash-free
`urn:sha256:<canonical-manifest-input>` ID. Its digest covers every manifest
field except the ID itself, so the complete source, artifact, peer, validation,
runtime-reference, and intended-distribution record is content-bound without
placing the slash-bearing capability release ID in Hamilton's artifact-ID
namespace.

The committed packed-consumer lock binds the Web IDE `0.4.0`/Karel `0.3.3`
pair and its complete normalized graph. The fork source, accepted base,
toolchain, public release asset, and embedded WebAssembly identities are exact.
Historical graph digests and the `0.3.1` compatibility lock remain unchanged.
Karel finalization also requires Web IDE's final artifact manifest and sidecar.

## Lock regeneration boundary

Every packaged file is a byte input, so a later change to one can change the
Karel tarball. Final-mode generation therefore requires the committed consumer
lock to be checked against the exact final Web IDE and Karel candidate bytes
and to contain both computed SHA-512 integrities. No
commit, digest, or integrity printed in prose is release evidence. The actual
source identities, candidate digests, lock bindings, and receipts belong only
in the external canonical evidence directory and the downstream release
ledger. Test-mode generation is disposable and cannot close this boundary.
Rebinding the consumer lock to exact `0.3.3` candidate bytes proves
compatibility only; it is not publication evidence.

## Post-publication Web IDE 0.3.1 compatibility

Web IDE `0.3.1` is inside Karel's published peer range but was not part of the
historical Karel release finalization. The additive compatibility capture uses
the separately committed
`release/web-ide-0.3.1-compatibility.package-lock.json` and verifies the exact
published Karel receipt, manifest, candidate state, and package bytes before it
runs the complete packed production/browser consumer against Web IDE's final
candidate. Its reviewed source is identified by annotated tag
`web-ide-karel-compatibility-gate-v2-web-ide-v0.3.1-source`.

This attestation does not regenerate Karel, move
`web-ide-karel-v0.3.1-source`, change the Karel artifact manifest, or rebind
`hamilton.python-karel/3`. The historical Web IDE `0.3.0` consumer lock remains
part of the frozen original compatibility path, not the active `0.3.3` release
tools. The successor capture is atomic,
normalizes local paths, has a 90-second process timeout plus bounded cleanup,
and emits the existing `karel:release-compatibility-gate@2` receipt contract
with Web IDE `0.3.1` identity only after the unfiltered exact-pair gate passes.
