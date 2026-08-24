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

The package remains `private: true` and is not published to npm. GitHub release
assets, downstream capability identifiers, URLs, credentials, and host cache
state are distribution-owned records and are not embedded in package source or
runtime contracts.
