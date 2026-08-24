# Publishing readiness

`@web-ide/karel@0.2.0` r6 is an MIT-licensed immutable private release. Its
license/SBOM, reproducibility, production validation, publication, independent
download, and downstream retention evidence completed P2.5. It remains
`private: true` and is not published to npm.

The presentation redesign changes packaged bytes and remains unpublished. The
forward-only release mechanics now name package `0.3.0`, annotated source tag
`web-ide-karel-v0.3.0-source`, Hamilton release tag
`web-ide-karel-v0.3.0`, and exact capability release
`hamilton.python-karel/2`. They do not reuse or move the `0.2.0` artifact, r6
source tag, or immutable `hamilton.python-karel/1` binding.

The packed-production consumer commits one npm v3 lock for the stable local
references `artifacts/web-ide.tgz` and `artifacts/web-ide-karel.tgz`. Validation
copies an exact candidate pair to those names, checks the copied SHA-512 values
against the lock, and only then runs a script-disabled `npm ci` with strict peer
and engine checks in a new cache. The normal source gate builds the adjacent
Web IDE and current Karel checkouts. A release-candidate pair can be checked
without rebuilding it:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.3.0.tgz \
KAREL_CANDIDATE_TARBALL=/absolute/path/web-ide-karel-0.3.0.tgz \
  npm run test:packed-production
```

The 0.3 artifact must independently produce all of the following evidence for
its exact digest:

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

The historical `hamilton.python-karel/1` identifier remains recorded only in
the immutable r6 evidence, not in package runtime contracts. The 0.3 Karel
artifact manifest uses schema 2 and the exact sorted singleton
`capabilityReleaseIds` list `["hamilton.python-karel/2"]`. Published URLs,
credentials, and host cache state remain distribution-owned records and are
not embedded in the package.

## Deterministic evidence and dependency order

The checked-in `release/` inputs and `scripts/release/` tooling define the
forward-only `0.3.0` fail-closed workflow. Candidate generation binds
the canonical Web IDE candidate state, exact Web tarball, Web-owned runtime
verification report, committed consumer lock, exact pushed/tagged Karel source,
two isolated byte-identical Karel packs, independent safe tar inventory,
per-file license inventory, deduplicated license text, and CycloneDX SBOM. Its
outputs are external and it performs no tag, release, or upload mutation.

The sequence is intentionally:

1. generate Web IDE's final candidate state, tarball, and runtime report from
   its exact annotated `web-ide-v0.3.0-source` tag;
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

The committed packed-consumer lock binds the locally frozen 0.3 Karel package
bytes. Its Web IDE SHA-512 is an unmistakable provisional value because the
final Web candidate does not yet exist. This intentionally blocks an exact-pair
gate until that Web entry is replaced and the unchanged normalized transitive-
graph digest is rechecked.

## Lock regeneration boundary

Every packaged file is a byte input, so a later change to one can change the
Karel tarball. Final-mode generation therefore requires the committed consumer
lock to be checked against the exact final Web IDE and Karel candidate bytes
and to contain both computed SHA-512 integrities. No
commit, digest, or integrity printed in prose is release evidence. The actual
source identities, candidate digests, lock bindings, and receipts belong only
in the external canonical evidence directory and the downstream release
ledger. Test-mode generation is disposable and cannot close this boundary.
Rebinding the consumer lock to exact 0.3 candidate bytes proves compatibility
only; it is not publication evidence.
