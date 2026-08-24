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
| `npm run test:packed-production` | Pack both sibling packages, strictly install them in a fresh consumer, audit/typecheck/build, then run the production-server browser matrix. |
| `npm run pack:check` | Inspect the npm tarball contents without publishing |
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
- `tests/component/karel-panel.test.tsx` covers the rendered world, unavailable
  runtime messaging, accessible controls/status, multi-world reset, source
  presentation, startup transition locking, and Strict Mode listener cleanup.
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
4. public services drive prepare/pause, live Step Forward, recorded Step Back,
   Return to live, and settled Stop with accessible status text.

Component coverage also resolves execution startup and delivers an initial
protocol state before the first valid student pause. The panel must remain
`Starting` with Stop, Reset, Restart, and world selection disabled until that
pause arrives, preventing the packed abort/rerun scenario from racing runtime
preparation through another transition.

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
`scripts/validate-packed-production-consumer.mjs`. It builds and packs the
adjacent `web-ide` checkout and this package, records both SHA-256 values,
copies only the tarballs into a fresh temporary project, and installs with
strict peer and engine checks. The fixture imports public package exports only;
it then runs full and production audits, typechecking, a real Vite production
build, and one-worker Playwright against a purpose-built static SPA server.

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
6. active abort followed by a clean, newly correlated rerun;
7. sequential project remount without workspace, state, session, or listener
   leakage;
8. two simultaneous browser realms with overlapping local run IDs and isolated
   workspaces/state;
9. close/unmount cleanup of listeners, sessions, persistence, workers, and
   post-disposal events; and
10. keyboard-only operation, retained focus indication, polite/non-color
    status, reduced motion, narrow responsive layout without horizontal
    overflow, light/dark themes, and at least 4.5:1 text contrast.

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
