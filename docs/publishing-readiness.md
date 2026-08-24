# Publishing readiness

`@web-ide/karel@0.2.0` is an MIT-licensed private release candidate. The
source manifest, public package boundary, Web IDE peer range, and locked packed
consumer are release inputs; none of them publishes or authorizes publication
by itself.

The packed-production consumer commits one npm v3 lock for the stable local
references `artifacts/web-ide.tgz` and `artifacts/web-ide-karel.tgz`. Validation
copies an exact candidate pair to those names, checks the copied SHA-512 values
against the lock, and only then runs a script-disabled `npm ci` with strict peer
and engine checks in a new cache. The normal source gate builds the adjacent
Web IDE and current Karel checkouts. A release-candidate pair can be checked
without rebuilding it:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.2.0.tgz \
KAREL_CANDIDATE_TARBALL=/absolute/path/web-ide-karel-0.2.0.tgz \
  npm run test:packed-production
```

P2.5 is complete only when the exact candidate digest also has all of the
following recorded evidence:

- a reviewed per-file license/provenance inventory and production SBOM;
- two clean, reproducible package builds with identical artifact bytes;
- the complete production validation gate against the exact candidate pair;
- immutable private-release publication after its source commits are pushed;
- an independent re-download whose digest matches the published asset and the
  downstream receipt; and
- downstream cache seeding and retention under the consuming host's policy.

The earlier annotated `v0.2.0`, `web-ide-karel-v0.2.0-source-r2`, and
`web-ide-karel-v0.2.0-source-r3` source tags are retained unchanged as abandoned
prepublication checkpoints: no Hamilton release or uploaded asset was created
from them. The r2 and r3 Karel candidates were superseded when their paired
Web receipt captures failed closed before publication.
The forward-only evidence run uses `web-ide-karel-v0.2.0-source-r4`; none of
these tags may be moved or rewritten.

The package remains `private: true` and is not published to npm. The accepted
`hamilton.python-karel/1` identifier is recorded only in release-evidence
inputs/manifests, not in package runtime contracts. Published URLs, credentials,
and host cache state remain distribution-owned records and are not embedded in
the package.

## Deterministic evidence and dependency order

The checked-in `release/` inputs and `scripts/release/` tooling now define the
Karel evidence format and fail-closed workflow. Candidate generation binds
the canonical Web IDE candidate state, exact Web tarball, Web-owned runtime
verification report, committed consumer lock, exact pushed/tagged Karel source,
two isolated byte-identical Karel packs, independent safe tar inventory,
per-file license inventory, deduplicated license text, and CycloneDX SBOM. Its
outputs are external and it performs no tag, release, or upload mutation.

The sequence is intentionally:

1. generate Web IDE's final candidate state, tarball, and runtime report from
   its exact annotated `web-ide-v0.2.0-source-r4` tag;
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

## Lock regeneration boundary

Release tooling and packaged documentation are source inputs, so every source
commit can change the Karel tarball. Final-mode generation therefore requires
the committed consumer lock to be regenerated from the exact final Web IDE and
Karel candidate bytes and to contain both computed SHA-512 integrities. No
commit, digest, or integrity printed in prose is release evidence. The actual
source identities, candidate digests, lock bindings, and receipts belong only
in the external canonical evidence directory and the downstream release
ledger. Test-mode generation is disposable and cannot close this boundary.
