# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private vulnerability-reporting channel when available, or contact the
repository owner privately. Include the affected source commit/package version,
reproduction steps, impact, and the smallest safe proof. Do not include real
user data, credentials, tokens, or unrelated secrets.

The package is currently pre-release. Security fixes target the current
maintained source and reviewed release artifacts; no support promise is made
for arbitrary forks or modified bundles.

## Trust boundaries

Treat all of the following as untrusted:

- Python programs and their stdout/stderr;
- OSC protocol payloads, run IDs, source locations, error messages, and worlds;
- imported world documents and conversion inputs;
- runtime/debug pause locations and timing; and
- any browser-generated final-state comparison.

The host configuration chooses plugins, runtime providers, world documents,
hosting policy, and persistence. Even host-supplied values are validated at the
Karel contract boundary before they become portable worlds or protocol state.

This package runs inside a user-controlled browser. It contains no server-side
authorization boundary and must not be used to establish identity, permission,
trusted completion, a score, or a grade.

## Execution-only is not secret

The Karel library, selected world, and run resource are contributed under
`/sysroot` as Web IDE `execution-only` files. This keeps them out of the editor
and persisted student-file projection. It does not keep them secret from a user
who controls the browser, runtime, developer tools, or network.

Never place credentials, API keys, private tests, confidential content, or an
authoritative result in execution-only resources. Network restrictions and
server-side authorization remain host responsibilities.

## Defensive controls

### Worlds and rendering

The versioned world parser rejects unknown fields, non-plain/sparse/accessor
data, unsafe integers, oversized dimensions/item arrays/names, invalid
coordinates/directions, duplicate semantics, implicit boundary walls, and
active CSS color forms. It canonicalizes before serialization. React/SVG
renders validated text and attributes without HTML injection.

Explicit converters never infer an input format. Conversion warnings must be
shown or reviewed by the caller; a canonical preview is not proof that the
source was trustworthy.

### Protocol and runtime output

Protocol v2 requires exact fields, a portable bounded run ID, one contiguous
sequence beginning at zero, canonical relative POSIX student paths, and one
terminal settlement. The plugin binds the decoder to the run ID in the exact
execution-only resource it just materialized. The decoder retains at most 256
retired IDs, bounds frame length, framed characters, run and chunk event counts,
and errors returned per push. It separates valid private frames from ordinary
stdout and rejects malformed, unexpected-run, retired, duplicate, unsupported,
and post-terminal input. Correlation prevents stale projection; an opaque run
ID remains untrusted and is not an authentication token.

The playback controller separately bounds observed debugger pauses, elapsed
time, and UTF-8 stdout/stderr bytes. The pure timeline bounds retained frames by
both count and serialized bytes and rejects stale controller runs. Terminal
failure and limit evidence is not lost when old history is evicted.

These limits constrain companion-owned state after public runtime events reach
the package. They do not prove transport-level backpressure inside a runtime or
worker. A host must assess and bound that lower layer independently.

### Source presentation and lifecycle

Only source locations that normalize to an existing `/workspace` file and line
are presented. Runtime support/test/world paths are skipped. Source operations
use an owner-scoped Web IDE facade; cleanup clears only this contribution's
decorations.

Deterministic playback derives temporary breakpoints only from non-empty,
non-comment lines in the current workspace's Python files. They are installed
through Web IDE's optional object-identity overlay boundary, atomically merged
under the runtime's combined breakpoint quota, and excluded from editor
breakpoint validation. A missing overlay capability fails playback closed.
Settlement, stop, reset, deactivation, and disposal clear only the controller's
owner token; session disposal is the final cleanup boundary.

Subscriptions are instance-scoped and reference-counted. Stop, reset, world
change, deactivation, and disposal cancel timers, revoke listeners, clear
source state, and reset run correlation. Events that fail active run, sequence,
or terminal checks are rejected. Hosts must still await the public execution
stop/close boundaries before destroying their own resources.

## Browser isolation and hosting

The selected Web IDE Python runtime requires `SharedArrayBuffer` and
cross-origin isolation. Production documents, SPA fallbacks, workers, WASM,
and runtime assets must use compatible:

- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Embedder-Policy: require-corp`;
- Content Security Policy; and
- CORS/Cross-Origin-Resource-Policy headers.

The development browser fixture asserts cross-origin isolation for its real
runtime scenarios. The separate packed-consumer suite validates the exact CSP
and isolation headers documented in `docs/testing.md` on normal routes, nested
SPA fallbacks, assets, malformed requests, and 404s; it also checks observed
external runtime assets for CORS or cross-origin CORP. A production host must
fail closed when `crossOriginIsolated` or `SharedArrayBuffer` is unavailable,
keep secrets out of client bundles, preserve those controls on every response,
and narrow external origins to the reviewed asset set.

## Dependency and release hygiene

Use the checked-in lockfile and review every dependency change. Before a
release, run the documented lint, TypeScript/Python tests, typecheck, builds,
package inspection, browser suite, dependency audits, and clean packed-consumer
production checks. The checked-in Python guard fails below 3.10 before the
Python contract suite begins. Record exact source, lockfile, artifact, runtime,
browser, screenshot, and evidence hashes. Do not publish on the strength of a
development fixture alone.

Raw protocol events, source paths, stdout/stderr, world names, and error text may
contain user-authored data. Avoid persistent logging by default, apply host
retention policy, and use synthetic data in test evidence.

## Non-security guarantees

`compareKarelFinalState` always labels results `formative-only`. A matching
browser result is not tamper-resistant and must never authorize an action or be
stored as an authoritative score or grade. Recorded Step Back is visual history
only and is not process rewind.
