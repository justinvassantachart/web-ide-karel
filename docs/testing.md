# Testing

## Supported local workflow

Use the checked-in npm lockfile and a supported Python interpreter:

```sh
npm ci
npx playwright install chromium
npm run validate
npm run test:browser
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
| `npm run test:python` | Python `unittest` discovery under `tests/python` for `*_test.py` |
| `npm run typecheck` | TypeScript project references via `tsc -b` |
| `npm run build:library` | Vite library build and generated declarations |
| `npm run build:example` | Typecheck and production-build `examples/basic` against `dist` |
| `npm run test:browser` | Playwright browser suite against the port-4178 fixture |
| `npm run pack:check` | Inspect the npm tarball contents without publishing |

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
  contiguous run correlation, terminal settlement, strict fields/source paths,
  unsupported v1 input, frame/event/error quotas, malformed recovery, and
  truncation.
- `tests/integration/python-protocol.test.ts` launches the bundled Python
  library, reads host-created execution-only run/world resources, decodes its
  real stdout in TypeScript, preserves ordinary output/tracebacks, and verifies
  success and typed error outcomes.

### Timeline, playback, comparison, and component lifecycle

- `tests/unit/timeline.test.ts` proves immutable frame correlation, count and
  UTF-8-byte eviction, stale/duplicate/post-terminal rejection, explicit live
  versus history cursors, and terminal failure/limit preservation.
- `tests/unit/playback-controller.test.ts` proves public-service composition,
  eligible-source filtering, current/historical decorations, live advance,
  scheduled play/pause, pause limits, settlement, world reset, and cleanup.
- `tests/unit/comparison.test.ts` proves deterministic, immutable,
  `formative-only` final-state differences and explicit completion semantics.
- `tests/component/karel-panel.test.tsx` covers the rendered world, unavailable
  runtime messaging, accessible controls/status, multi-world reset, source
  presentation, and Strict Mode listener cleanup.
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

Browser scenarios fail if their asserted runtime, isolation, UI, or lifecycle
outcome is absent. `playwright.config.ts` runs them headlessly and gives the two
real-runtime scenarios extended 180-second timeouts inside the tests.

The web server is a Vite development server, even though `build:example`
separately produces a production bundle. Therefore this browser command does
not establish packed-artifact installation, production-server headers, SPA
fallback behavior, CSP/CORS/CORP coverage, or production rollback. Those are
separate release gates and must not be inferred from a green browser run here.

## Validation expectations

A change is locally ready for integration only when:

- `npm run validate` and `npm run test:browser` both exit zero;
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
