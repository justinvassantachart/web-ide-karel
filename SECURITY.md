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

The production consumer uses committed file-tarball resolutions and SHA-512
integrities for one exact Web IDE/Karel pair. Its verifier copies both
candidates to stable fixture names, hashes those destinations before npm is
allowed to run, and rejects path or byte drift. Installation uses `npm ci`, a
new disposable cache, strict engine/peer checks, and disabled lifecycle scripts.
Release validation additionally closes the complete canonical npm v3 package
graph, so an added node, changed transitive URL, or lifecycle flag cannot hide
behind unchanged direct artifact entries.
An existing global npm cache, sibling checkout, mutable manifest rewrite, or
SemVer-compatible substitute cannot satisfy that gate. Release-candidate
overrides must be absolute paths; a missing, non-file, or integrity-mismatched
candidate fails closed.

The package remains `private: true`; MIT licensing does not authorize an npm
publication. Immutable release publication, receipts, and downstream cache
seeding remain separate host-owned distribution steps.

Release-evidence tooling accepts only absolute non-symlink regular-file inputs,
plus a separate external real candidate directory, and publishes only to a new
external path through sibling staging plus atomic rename. Its in-memory
gzip/tar parser enforces compressed, expanded, per-entry,
entry-count, path, and PAX limits; accepts the exact reviewed textual package
inventory and safe regular-file mode; and rejects links, traversal, duplicate
or case-colliding paths, unexpected files, invalid UTF-8, sensitive filenames,
secret patterns, developer paths, and Web IDE internal/sibling imports. It
reconciles npm pack JSON with those independently parsed bytes. Candidate builds
use two detached exact-source clones, separate new npm caches, disabled
lifecycle scripts, and strict engines/peers. Git release reads use an absolute
binary with neutral global/system configuration, replacement objects disabled,
and local rewrite/include/archive-format/worktree-config/object-indirection
checks, including untracked Git info attributes that could alter an archive.
Source archives pin the reviewed Git tar umask. Final source evidence
requires a clean pushed `main` and pushed annotated tag at `HEAD`; non-final
test outputs are labeled and rejected by finalization. Archive controls and its
source reference are checked before and after generation, and the same live
source identity is re-verified immediately before atomic final publication. The
gate capture runner executes only predeclared argv in a scrubbed environment,
enforces the gate-specific wall-clock timeout, captures the actual combined
output and exit status, and writes a source/candidate-pair-bound receipt.
Timeout or output-limit termination targets the isolated process group with
bounded `SIGTERM` then `SIGKILL` escalation and settles it before returning.
Finalization copies, rehashes, and independently validates the retained raw
logs and capture receipts; it never converts an operator-authored pass flag into
release evidence.

Web IDE runtime assets remain a Web IDE trust boundary. Karel verifies the
canonical Web candidate state/runtime report before its build, then verifies
the finalized Web manifest and sidecar against the same source, tar, SRI, and
runtime-report digests. Karel records only the owner, report digest, and asset
count; it neither duplicates that inventory nor claims to have fetched or
licensed those Web-owned assets.

Raw protocol events, source paths, stdout/stderr, world names, and error text may
contain user-authored data. Avoid persistent logging by default, apply host
retention policy, and use synthetic data in test evidence.

## Non-security guarantees

`compareKarelFinalState` always labels results `formative-only`. A matching
browser result is not tamper-resistant and must never authorize an action or be
stored as an authoritative score or grade. Recorded Step Back is visual history
only and is not process rewind.
