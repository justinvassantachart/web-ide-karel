# Testing

## Supported local workflow

Use the checked-in npm lockfile and a supported Python interpreter:

```sh
npm ci
npm run check:python
npx playwright install chromium
npm run validate:production
```

`npm run validate` is exactly:

```text
npm run lint
npm run test
npm run typecheck
npm run build
npm run pack:check
```

The commands stop on the first failure. `npm run test` runs `test:ts` followed
by `test:python`. `npm run build` builds the library first and then compiles and
builds `examples/basic`. `npm run pack:check` is `npm pack --dry-run`; it does
not publish the package.

Use narrower scripts while iterating:

| Command | Exact scope |
| --- | --- |
| `npm run lint` | ESLint across the repository |
| `npm run test:ts` | Vitest unit, component, and integration tests, excluding `tests/browser/**` |
| `npm run check:python` | Fail closed unless `python3` is Python 3.10 or newer. |
| `npm run test:python` | Python `unittest` discovery under `tests/python` for `*_test.py` |
| `npm run typecheck` | TypeScript project references via `tsc -b` |
| `npm run build:library` | Vite library build and generated declarations |
| `npm run build:example` | Typecheck and production-build `examples/basic` against `dist` |
| `npm run test:browser` | Playwright browser suite against the port-4178 fixture |
| `npm run audit:full` / `npm run audit:production` | Fail at any known vulnerability in the full or production dependency tree. |
| `npm run test:packed-production` | Verify an exact locked Web IDE/Karel tarball pair, install it with lifecycle scripts disabled in a fresh consumer/cache, audit/typecheck/build, then run the production-server browser matrix. |
| `npm run test:release` | Exercise canonical JSON, safe tar parsing, source/tag gates, peer-evidence binding, license/SBOM generation, and strict manifest/validation schemas. |
| `npm run pack:check` | Inspect the npm tarball contents without publishing |
| `npm run release:candidate` | Produce an external deterministic Karel candidate/evidence set from exact pushed/tagged source and exact Web candidate evidence. |
| `npm run release:finalize` | Bind a final candidate and canonical all-pass validation record to Web IDE's finalized artifact manifest. |
| `npm run validate:production` | Run `validate`, the development browser suite, both audits, and the packed-production consumer gate. |

## Test layers

### World contract

- `tests/unit/world-contract.test.ts` exercises the closed JSON Schema,
  canonicalization, explicit converters, hostile JavaScript object shapes,
  bounds, duplicates, walls, and colors.
- `tests/python/karel_world_contract_test.py` applies the Python implementation
  to the same expectations.
- `tests/fixtures/world-contract-cases.json` is the shared deterministic
  canonical/conversion fixture. Both languages must serialize the same compact
  JSON plus one newline.
- `tests/unit/world.test.ts` retains compatibility coverage for the bare runtime
  world parser.

### Python teaching library and protocol

- `tests/python/karel_library_test.py` covers movement, native `turn_right`,
  walls, beepers/bag, colors, predicates, typed failures, world quotas, and
  exactly-once protocol-limit settlement.
- `tests/unit/protocol.test.ts` covers every chunk boundary, ordinary stdout,
  host-expected and retired run correlation, terminal settlement, strict
  fields/source paths, unsupported v1 input, frame/event/error quotas,
  malformed recovery, and truncation.
- `tests/integration/python-protocol.test.ts` launches the bundled Python
  library, reads host-created execution-only run/world resources, decodes its
  real stdout in TypeScript, preserves ordinary output/tracebacks, and verifies
  success and typed error outcomes.

### Timeline, playback, comparison, and component lifecycle

- `tests/unit/timeline.test.ts` proves immutable frame correlation, count and
  UTF-8-byte eviction, stale/duplicate/post-terminal rejection, explicit live
  versus history cursors, and terminal failure/limit preservation.
- `tests/unit/playback-controller.test.ts` proves public-service composition,
  deterministic owner-scoped workspace overlays, missing-capability failure,
  eligible-source filtering, current/historical decorations, live advance,
  scheduled play/pause, host-configured limits, settlement during deferred
  overlay preparation, world reset, and exact-owner cleanup.
- `tests/unit/comparison.test.ts` proves deterministic, immutable,
  `formative-only` final-state differences and explicit completion semantics.
- `tests/component/karel-panel.test.tsx` covers the rendered world, pixel-art
  icon and directional transforms, visible fallback, unavailable runtime
  messaging, the exact compact control set and Play/Pause toggle, speed slider,
  live/history labels, accessible controls/status, Forward-to-live behavior,
  multi-world reset, source presentation, startup transition locking, and
  Strict Mode listener cleanup. `tests/unit/karel-icon.test.ts`
  binds the checked-in icon's exact byte count and SHA-256.
- `tests/unit/plugin.test.ts` covers ordinary versus execution-only resources,
  fresh run materialization, public Run registration, language capability
  checks, custom IDs, and strict world selection failures.

## Browser workflow

`npm run test:browser` starts `tests/browser/vite.config.ts` at
`http://127.0.0.1:4178`. The fixture returns:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Playwright suite verifies:

1. mock runtime frames render and subscriptions are removed on unmount;
2. a real Web IDE host registers Karel through public APIs and keeps
   execution-only files out of the Explorer;
3. the generic Python runtime completes a nested-module Karel program in a
   cross-origin-isolated browser; and
4. public services drive Prepare, the Play/Pause toggle, live Forward, recorded
   Back/Forward-to-live, and Reset with accessible status text; and
5. the exact five-button surface, speed slider, real icon, desktop host
   composition, single-line narrow control strip, light/dark palettes, focus
   visibility, and reduced-motion behavior remain present.

Component coverage also resolves execution startup and delivers an initial
protocol state before the first valid student pause. The panel must remain
`Starting` with Reset and world selection disabled until that pause arrives,
preventing the packed reset/rerun scenario from racing runtime preparation
through another transition.

Browser scenarios fail if their asserted runtime, isolation, UI, or lifecycle
outcome is absent. `playwright.config.ts` runs them headlessly and gives the two
real-runtime scenarios extended 180-second timeouts inside the tests.

The web server is a Vite development server, even though `build:example`
separately produces a production bundle. Therefore this browser command does
not establish packed-artifact installation, production-server headers, SPA
fallback behavior, CSP/CORS/CORP coverage, or production rollback. Those are
separate release gates and must not be inferred from a green browser run here.

## Packed-production workflow

`npm run test:packed-production` runs
`scripts/validate-packed-production-consumer.mjs`. Its committed fixture lock
resolves only the stable local names `artifacts/web-ide.tgz` and
`artifacts/web-ide-karel.tgz`, including exact SHA-512 integrity for both.
The default workflow builds and packs the adjacent `web-ide` checkout and this
package into an OS temporary directory. An exact release pair can be supplied
instead:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.3.0.tgz \
KAREL_CANDIDATE_TARBALL=/absolute/path/web-ide-karel-0.3.1.tgz \
  npm run test:packed-production
```

Overrides must be absolute regular-file paths. The verifier copies both inputs
to the stable names, hashes the copied destinations, and compares them with the
committed lock before npm is invoked. A wrong manifest/lock reference,
malformed integrity, changed byte, pre-existing artifact, missing file, or
relative override fails closed. The consumer uses a new disposable npm cache
and `npm ci --ignore-scripts --strict-peer-deps --engine-strict`; it never
rewrites the manifest or falls back to `npm install`. It asserts exact Web IDE
and Karel `0.3.1` package identities, Karel's Web peer range, and one React/
React DOM identity before running full and production audits, typechecking, a
real Vite production build, and one-worker Playwright against a purpose-built
static SPA server. The fixture imports public package exports only.

The fixture lock is coupled to the exact package bytes. Regenerate and review
it after any included package file, manifest, dependency, or build output
changes; an integrity mismatch is evidence of drift, not permission to update
the lock during validation. Release tooling also binds the complete canonical
transitive lock graph; only the two independently verified private-artifact
integrities are normalized for that graph check. Added nodes, registry or Git
URL drift, lifecycle flags, and any other transitive-node change fail closed.
The Karel entry binds the locally frozen `0.3.1` package bytes. The Web entry
binds the exact finalized Web IDE `0.3.0` bytes. The verifier rejects any drift
in either artifact before npm is invoked.

The production browser matrix proves:

1. nested-module execution with exact line/action/world/run correlation,
   execution-only resource exclusion, history navigation, and live external
   Monaco, debugger-sh, and Python-runtime assets;
2. deterministic termination of a line-only loop at its configured pause
   limit;
3. output-flood termination while already accepted, correlated protocol events
   remain valid;
4. 2,000 valid Karel actions with contiguous sequences and visible
   count/byte-bounded history truncation;
5. ordinary stdout, traceback, typed error, and nested source preservation;
6. active Reset followed by a clean, newly correlated Play rerun;
7. sequential project remount without workspace, state, session, or listener
   leakage;
8. two simultaneous browser realms with overlapping local run IDs and isolated
   workspaces/state;
9. close/unmount cleanup of listeners, sessions, persistence, workers, and
   post-disposal events; and
10. keyboard-only operation, retained focus indication, polite/non-color
    status, exact inlined Karel icon rendering, reduced motion, a single-line
    narrow control strip contained within the panel, light/dark themes, and at
    least 4.5:1 text contrast.

Passing scenarios write 13 full-page PNGs, while Playwright retains trace and
failure artifacts. Set `KAREL_PRODUCTION_ARTIFACT_DIR` to an absolute directory
to retain them at a chosen evidence boundary; the wrapper reports every
artifact's path, byte count, and SHA-256. Set
`KEEP_KAREL_PRODUCTION_CONSUMER=1` only for local failure investigation. The
complete `validate:production` gate fails before running if
`KAREL_PRODUCTION_DIAGNOSTIC_GREP` is present; that filter is reserved for an
explicit direct diagnostic invocation of `test:packed-production` and can
never produce release evidence.

The tested production server applies the following values to the document,
nested SPA fallback, static assets, malformed-path response, and 404 response:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Access-Control-Allow-Origin: *
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob: https://cdn.jsdelivr.net https://runno.dev; worker-src 'self' blob:; child-src 'self' blob:
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The matrix also requires `crossOriginIsolated`, `SharedArrayBuffer`, successful
external responses, and either `Access-Control-Allow-Origin: *` or
`Cross-Origin-Resource-Policy: cross-origin` on every observed cross-origin
runtime asset. Do not broaden these origins without a reviewed runtime-asset
change; a self-hosted deployment may replace them with its exact reviewed
origins.

## Deterministic release-evidence workflow

Release outputs must use an absent absolute path outside this repository. Each
command stages into a sibling temporary directory and atomically renames only
after every check succeeds; a failed run leaves no partial target and is
retryable.
File inputs must be absolute non-symlink regular-file paths outside this
repository; the finalizer's candidate input must be a separate external real
directory. Candidate generation does not read a sibling working tree: it
clones the exact verified
Karel commit twice, materializes the independently inspected Web IDE tar as the
clone's build-only sibling, uses a separate fresh npm cache for each build, and
uses isolated home/temp directories plus empty user/global npm configuration.
The environment is rebuilt from a small transport/path allowlist, so arbitrary
variables, npm configuration, registry-auth tokens, and Vite-prefixed values are
not inherited. Release Git commands use `/usr/bin/git`, neutral system/global
configuration, and the fixed OS keychain credential helper solely for
authenticated live-remote reads; tokens are not inherited or printed. Each
clone runs
`npm ci --ignore-scripts --strict-peer-deps --engine-strict` before
building and packing. Both npm tarballs and their canonical inventories must be
identical.

For a final candidate:

```sh
KAREL_RELEASE_OUTPUT_DIR=/absolute/external/new-karel-candidate \
KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE=/absolute/web-evidence/candidate-state.json \
KAREL_RELEASE_WEB_IDE_TARBALL=/absolute/web-evidence/web-ide-0.3.0.tgz \
  npm run release:candidate
```

Final mode fails unless local `main` equals both its tracking ref and the live
remote, the worktree is clean, the pushed annotated
`web-ide-karel-v0.3.1-source` tag peels to `HEAD`, and Node `24.11.1`/npm
`11.6.2` are active. The Web candidate state must be canonical final evidence,
its exact ten-artifact inventory must bind the runtime report and tar SHA-256,
and the committed packed-consumer lock must bind the computed Web and Karel
SHA-512 values.

For tooling tests before final tags exist, set `KAREL_RELEASE_MODE=test`. This
mode still requires the exact pushed Karel `main`, exact toolchain, canonical
Web candidate-state fixture, and two clean byte-identical builds, but archives
the pushed commit and marks every output non-final. It never satisfies
`release:finalize` and must not be uploaded or cited as release evidence.

For Web IDE finalization, run the exact pair with
`KAREL_RELEASE_WEB_IDE_GATE_RECEIPT=1` and
both `KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE` and
`KAREL_RELEASE_KAREL_CANDIDATE_STATE` set to their canonical candidate states.
The unfiltered successful run emits exactly one Web IDE compatibility receipt
as its final stdout line. The capture runner retains the complete output after
replacing only declared local roots with stable placeholders; retain that exact
normalized capture log for Web's finalizer.

Capture each gate with the repository runner. It requires the same final
clean/pushed/tagged source and exact locked candidate pair; the Web manifest is
additionally required for `web-ide-peer-evidence`. The runner selects the
predeclared executable and argv, removes inherited Node/npm/test controls,
captures actual stdout/stderr and exit status, normalizes only declared local
roots, and atomically publishes one exact normalized log plus one canonical
receipt to a previously absent external directory:

```sh
KAREL_RELEASE_GATE_ID=packed-exact-pair \
KAREL_RELEASE_GATE_OUTPUT_DIR=/absolute/external/gates/packed-exact-pair \
KAREL_RELEASE_KAREL_TARBALL=/absolute/karel-candidate/web-ide-karel-0.3.1.tgz \
KAREL_RELEASE_KAREL_CANDIDATE_STATE=/absolute/karel-candidate/candidate-state.json \
KAREL_RELEASE_WEB_IDE_TARBALL=/absolute/web-candidate/web-ide-0.3.0.tgz \
KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE=/absolute/web-candidate/candidate-state.json \
  npm run release:capture-gate
```

Gate capture uses these fixed wall-clock budgets:

| Gate | Timeout |
| --- | ---: |
| `validate-production` | 45 minutes |
| `packed-exact-pair` | 20 minutes |
| `audit-production` | 10 minutes |
| `audit-full` | 10 minutes |
| `reproducibility` | 45 minutes |
| `web-ide-peer-evidence` | 5 minutes |

The longer budgets cover the multi-build/browser and reproducibility gates;
the audit and local verification gates retain narrower bounds. Each receipt
uses capture schema 2, records stable logical `npm`/`node` invocation values,
and binds its exact timeout and the 10-second termination grace period. On
timeout or capture-limit overflow, the runner signals the gate's isolated POSIX
process group with `SIGTERM`, waits the grace period, sends `SIGKILL` if any
member remains, and verifies that both the direct child and process group have
settled before the staging directory is discarded. The release machine uses
macOS process-group semantics; capture fails closed on Windows.

After the successful compatibility log has finalized Web IDE's manifest,
capture `web-ide-peer-evidence` with
`KAREL_RELEASE_WEB_IDE_MANIFEST=/absolute/web-evidence/artifact-manifest.json`.
Copy `release/validation-summary.template.json` outside the repository and bind
each gate's external log and receipt by absolute path, exact filename, size,
and SHA-256. Replace both source commits and both candidate digests, serialize
the input as canonical JSON, and run. Logs must be nonempty UTF-8 and contain no
credentials or private keys:

```sh
KAREL_RELEASE_CANDIDATE_DIR=/absolute/external/final-karel-candidate \
KAREL_RELEASE_OUTPUT_DIR=/absolute/external/new-final-karel-evidence \
KAREL_RELEASE_VALIDATION_INPUT=/absolute/external/validation-summary.json \
KAREL_RELEASE_WEB_IDE_MANIFEST=/absolute/web-evidence/artifact-manifest.json \
KAREL_RELEASE_WEB_IDE_TARBALL=/absolute/web-evidence/web-ide-0.3.0.tgz \
  npm run release:finalize
```

Finalization leaves the candidate directory read-only, copies its exact bytes
into transactional staging, and independently rechecks clean/pushed/tagged
Karel source, the tag-derived source archive, deterministic-build schema,
package tar allowlist and inspection, regenerated licenses and SBOM, consumer
locks, final Web manifest/sidecar/tar/runtime/candidate cross-links, and every
normalized validation capture log and capture receipt. It copies and rehashes
the exact bytes, then verifies the predeclared command, normalized-capture
environment, actual zero exit,
both source commits, both candidate digests, and the final Web receipt footer.
Unknown fields, rewritten reports plus rewritten state, symlinks, missing logs,
peer drift, and late failures all fail closed without publishing a partial
output. Git controls and the archived reference are checked before and after
archive generation, and finalization re-verifies the complete live source
identity immediately before its atomic publication step. It does not tag or
publish.

The external candidate directory contains the source archive, package tarball,
candidate state, safe package inventory, deterministic-build comparison,
license inventory, `THIRD_PARTY_LICENSES.txt`, CycloneDX 1.6 SBOM, and Web
candidate verification. Finalization additionally retains the six normalized
capture logs and
capture receipts and writes the canonical validation summary, Web
final-manifest verification, artifact manifest, and sidecar. Runtime assets
remain represented only by Web IDE's referenced report digest and count.

## Validation expectations

A change is locally ready for integration only when:

- `npm run validate:production` exits zero;
- no required test was focused, skipped, relabeled, or weakened;
- world/protocol fixture changes are intentional and pass in both languages;
- package dry-run contains only intended public files;
- execution-only resources remain absent from editable/persisted workspace
  projections; and
- browser results are described as formative runtime behavior, never trusted
  grades or authorization evidence.

For release evidence, also record the exact Node, npm, Python, Playwright, and
browser versions, the source commit, dependency lockfile, built artifact and
tarball hashes, audit results, commands, failures/skips, and production-hosting
results. Do not publish from `npm run pack:check`; it is inspection only.
