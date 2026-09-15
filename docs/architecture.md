# Architecture

## Package boundary

`@web-ide/karel` is an activity companion, not a runtime or host application.
It owns reusable Karel semantics and consumes only public Web IDE contracts.

| Owner | Responsibilities |
| --- | --- |
| Host | Select Web IDE/runtime plugins, configure strict world documents, supply hosting headers and policy |
| Web IDE | Workspace/resource planes, generic runtime selection, execution commands, source presentation, panel lifecycle |
| Karel companion | World contract/converters, Python API, protocol, session projection, playback/timeline, renderer, comparison |
| Python runtime provider | Execute Python and expose public run/debug/event/session capabilities |

The companion has no host persistence, identity, role, assignment, submission,
or grading model. It does not import a concrete runtime provider or Web IDE
internals.

## Composition and data flow

```text
Host configuration
  └─ createKarelPlugin(strict world documents)
       ├─ ordinary resource: /workspace/main.py
       ├─ dynamic execution-only resources
       │    ├─ /sysroot/karel.py
       │    ├─ /sysroot/karel_world.json
       │    └─ /sysroot/karel_run.json
       └─ Karel panel
            ├─ public runtime/execution/workspace/source services
            ├─ KarelSessionStore ← protocol-v2 stdout decoder
            ├─ KarelPlaybackController
            │    └─ pure bounded KarelTimeline
            └─ KarelWorldView
```

`createKarelPlugin` validates contribution identifiers and world choices. One
plugin instance owns its current world selection. A `WeakMap` provides one
`KarelSessionStore` per runtime session so instances cannot share runtime
projection accidentally.

The optional Run command reveals the panel and calls the instance-scoped public
execution service. Panel controls use the same public execution service for
debug start and settled stop, the public runtime service for transient
breakpoint overlays, continue, and events, the workspace snapshot for source
eligibility, and the owner-scoped source service for
current/historical/error presentation.

## World contract

The portable contract is the exact envelope
`{ schema: "web-ide-karel/world", version: 1, world }`. Its immutable exported
JSON Schema documents the JSON shape; `parseKarelWorldDocument` is the semantic
enforcement boundary.

The TypeScript and Python implementations enforce:

- closed, plain data objects and dense arrays;
- safe integer, dimension, coordinate, item-count, name, direction, and color
  constraints;
- unique beeper/color corners and unique canonical walls;
- implicit outer boundaries rather than serialized boundary walls; and
- canonical street/avenue ordering, lowercase colors, and east/north internal
  wall representations.

Explicit converters handle only the named former bare companion shape and the
documented standalone `r`/`c`/`cols` shape. They return warnings and canonical
previews. The strict document parser performs no shape inference.

The bare `KarelWorld` parser/serializer remains a compatibility boundary for
the runtime library and existing consumers. Portable interchange uses the
versioned document.

## Resource planes and multi-world selection

The companion's default ordinary resource contribution contains only
`/workspace/main.py`. It can be edited and appears in Web IDE's persisted-file
projection; hosts may independently contribute other ordinary files.

For each execution, a dynamic `execution-only` contribution materializes the
Python library, selected bare world body, and a fresh opaque protocol run ID at
the three `/sysroot` paths. Web IDE makes these runtime-readable while hiding
them from editing and persistence. This prevents accidental source/world edits;
it is not a confidentiality mechanism.

With `worlds`, the host supplies one or more strict documents with unique
portable IDs and labels. Selection first stops/reset the current controller and
store, then changes the world used by the next dynamic execution resource.
Student files are not rewritten or deleted.

## Protocol and session projection

The Python library emits base64url JSON inside ANSI OSC code 777. Protocol v2
adds an opaque run ID, a sequence starting at zero, optional canonical student
source, and one terminal outcome. The support library obtains the run ID from
the execution-only run resource and emits native `turn_right` as one action.

`KarelProtocolDecoder` is incremental and keeps ordinary stdout separate. It
strictly parses event fields and source paths, validates runtime-world values,
admits one host-expected run per reset, requires contiguous sequences, rejects
anything after settlement, retains a bounded set of 256 retired run IDs, and
bounds frames, per-run characters/events, per-push events, and reported errors.

`KarelSessionStore` projects validated state for the panel and separately
notifies the playback controller of decoded events. Runtime subscriptions are
reference-counted to tolerate React Strict Mode replay. The plugin reads the
fresh execution-only run resource it materializes and binds that ID with
`expectRun` before runtime output can be projected. Reset retires the active ID;
detaching the last consumer revokes all runtime listeners and clears the
expected ID. Wrong and retired IDs are rejected as expected correlation noise
rather than replacing otherwise valid UI state.

Protocol run IDs correlate untrusted events; they are not user identity,
authorization, or secrets.

## Playback controller and timeline

`KarelPlaybackController` is the effectful adapter. It owns timers,
subscriptions, generic execution calls, transient debug-breakpoint ownership,
eligible-source filtering, source decorations, and cumulative
pause/time/output limits.
Support paths or deleted/out-of-range workspace locations are skipped rather
than presented as student source.

The controller separately records whether the current run has reached its
first validated student-source pause. Until then the panel reports `Starting`
and locks Reset, world selection, and conflicting run transitions, even if
execution startup resolves or an initial protocol state arrives first.
Terminal settlement invalidates pending local preparation generations before
cleanup. This readiness state resets with every run and lifecycle teardown; a
support/runtime pause cannot satisfy it.

Before a playback run starts, the controller snapshots ordinary workspace
files and derives an overlay from every non-empty, non-comment line in each
`.py` file. It requires Web IDE's optional `replaceBreakpointOverlay` and
`clearBreakpointOverlay` methods, installs the map under one controller-owned
object token, and uses Continue between stops so calls into nested student
modules remain observable. The selected runtime atomically merges that overlay
with editor and other-owner breakpoints under its configuration quota; Karel
never overwrites or presents those other sets. The controller clears only its
own token after settlement and throughout stop/reset/deactivation/disposal.

`KarelTimeline` is a pure state machine. It records immutable line/action
frames correlated by controller run, monotonically increasing sequence, source,
action, and world. It owns these phases:

- `idle`: no active run;
- `paused`: live execution may accept one advance request;
- `advancing`: waiting for the next accepted live frame;
- `playing`: the controller may schedule another step after its configured
  delay; and
- `terminal`: completed, runtime-error, aborted, or limit-exceeded.

History is bounded independently by frame count and UTF-8 serialized bytes.
Oldest frames are evicted deterministically. The live frame always remains
distinct from a historical display cursor. Back and recorded Forward only move
that cursor; Forward clears the history cursor when it reaches the newest
frame, and no UI or API claims or invokes Python process reversal. Terminal
detail and its final/last-valid world are held outside evictable history.

On stop, reset, world change, deactivation, or disposal, the controller clears
timers and owned source decoration state, revokes listeners, and resets its run
correlation. Events that fail the active run, sequence, or terminal checks are
rejected rather than presented.

## Rendering and accessibility

`KarelPanel` is the package's presentation boundary. It exposes one compact
single-line strip of native buttons, a range input, and a world selector with
visible disabled and focus states. Its only actions are Prepare, a Play/Pause
toggle, Reset, Back, and Forward. It uses a small local CSS-token set that
consumes host color variables without owning theme selection. Polite live
regions report compact status/frame information and exact errors or limits.
The panel omits a repeated visual header and diagnostic footer; world name,
coordinates, direction, beeper, wall, and painted-corner details remain in the
selector, SVG title, and bounded accessible description. It fills only
host-provided space, allows internal toolbar scrolling at exceptionally narrow
container widths instead of wrapping controls into multiple lines, and removes
robot motion under `prefers-reduced-motion`. Ordinary stdout/stderr remains in
Web IDE's terminal.

`KarelWorldView` renders validated world data with React/SVG primitives and one
owner-authorized pixel-art PNG imported from `src/assets/karel.png`. Vite
inlines those exact bytes into the library bundle, so rendering performs no
asset fetch. The source image faces east; the SVG transform rotates it for the
other directions and replaces it with an SVG arrow after an image error. The
outer SVG retains the single accessible image name and bounded description.
World names are text nodes and colors are restricted by the world parser; the
renderer does not inject markup or active CSS values.

The panel treats only the public session projection's typed
`KarelBlockedError` as a blocked-move visual state. The renderer owns its inline
SVG flame/scorched effect, includes the blocked move in the textual equivalent,
and removes all effect motion under `prefers-reduced-motion`; reset removes the
state without adding a timer or lifecycle resource.

## Formative comparison

`compareKarelFinalState` is pure and deterministic. It snapshots validated
worlds, canonicalizes unordered collections for comparison, and returns
dimension-specific differences. Completion is compared only when callers
supply both expected and actual facts.

Every result is labeled `formative-only`; this package has no scoring, grading,
authorization, or trusted-execution boundary.

## Package and distribution boundary

The source package is MIT-licensed `@web-ide/karel@0.3.3`, remains
`private: true`, and declares Web IDE `>=0.3.0 <0.4.0 || 0.4.0` as a peer. The
trailing `|| 0.4.0` is a metadata-only widening that admits exactly the one
reviewed Web IDE `0.4.0` build; later `0.4.x` and `0.5` stay excluded until
they are reviewed. No Karel runtime behavior, world format, or formative
semantics changed for it. React, React
DOM, and Web IDE are external to the library bundle. The sibling
`file:../web-ide` development dependency exists only to build and test paired
source checkouts; it is not a release or host dependency path.

Release compatibility is narrower than the peer range. The packed-production
consumer commits one lock for stable `web-ide.tgz` and `web-ide-karel.tgz`
references and verifies both candidates' SHA-512 values before a strict,
script-disabled `npm ci` in a disposable cache. Release tooling also binds the
complete canonical transitive lock graph. Candidate overrides are
absolute paths, while default source validation packs temporary artifacts from
the adjacent Web IDE and current Karel checkout. No manifest is rewritten at
runtime and no cache, sibling package, compatible range, or npm publication can
substitute different bytes.
The active Web peer source is bound to the annotated
`web-ide-v0.4.0-source` tag; its Hamilton asset release is
`web-ide-v0.4.0`. Those source and artifact identities are verified and
referenced, never moved or rebound for this Karel-only successor.

An additive post-publication profile attests the already-released Karel
`0.3.1` bytes with Web IDE `0.3.1`. It first verifies Karel's immutable release
receipt, artifact manifest, candidate state, and tarball, then installs that
tarball and Web IDE's exact candidate through the separately committed
`release/web-ide-0.3.1-compatibility.package-lock.json`. The full packed
production/browser consumer emits Web IDE's existing schema-2 compatibility
receipt only after success. This historical profile does not alter either the
active `0.3.3` pair or the original Web IDE `0.3.0` lock, Karel `0.3.1`
release evidence, package, or capability binding.

Release evidence is external output produced by `scripts/release/`; it is not a
runtime dependency and is never written inside the repository. Candidate and
final outputs are built in sibling staging directories and atomically renamed
to previously absent targets. Git source reads ignore ambient global/system
configuration and replacement objects and reject local rewrite, include,
archive-format, upload-pack, graft, alternate-object, and replace-ref controls.
The evidence
binds package and lockfile digests, source commit/tree/annotated tag, a
deterministic exact-tag archive, two byte-identical isolated package builds,
independently parsed npm-tar inventory, per-file licenses, CycloneDX SBOM,
capture-runner validation logs with deterministic local-path placeholders and
actual-exit/source/candidate-pair-bound receipts, intended private Hamilton
release assets, and an unchanged live
source identity immediately before atomic final publication. The accepted
composition identity `hamilton.python-karel/8` appears only in release
metadata; it does not enter Karel's public runtime or world contracts. The
schema-2 Karel artifact manifest binds the exact sorted singleton
`capabilityReleaseIds` list `['hamilton.python-karel/8']`; Web IDE `0.4.0`'s
separately owned schema-2 manifest carries
`hamilton.python-karel/8` and `hamilton.python/4`. The older Karel `0.3.2`,
`0.3.1` and Web IDE `0.3.1`, `0.3.0` identities, and Hamilton's retained
`hamilton.python/3` and `hamilton.python-karel/6` compositions, remain confined
to their frozen historical validators and evidence.
The final artifact manifest uses the slash-free
`urn:sha256:<canonical-manifest-input>` content identity also used by Web IDE.
That digest covers every manifest field except `manifestId` itself, binding the
complete package, source, peer, runtime-reference, validation, and distribution
record while satisfying Hamilton's artifact-ID grammar.

The evidence dependency order avoids a manifest cycle:

```text
Web IDE candidate state + tar + runtime report
  -> Karel deterministic candidate
  -> exact-pair compatibility validation log
  -> Web IDE final artifact manifest
  -> Karel final artifact manifest
```

Karel candidate generation verifies the canonical Web candidate state, exact
tar SHA-256/SHA-512 identity, packed package inventory, consumer-lock binding,
and exact runtime-report digest. Karel finalization then independently verifies
the finalized canonical Web manifest and sidecar and requires its source,
tarball, and runtime-report values to equal the candidate-stage values. The
Karel manifest records only a digest reference to Web IDE's runtime evidence;
Web IDE remains the sole owner of the runtime-asset inventory.

Immutable release mutation, downstream artifact URLs, cache seeding, and
retention policy remain host/distribution concerns. The evidence scripts do not
tag, publish, upload, or alter those systems.

## Limits and deployment boundary

Default retained-history, playback, and protocol limits are exported from the
package and documented in the README. They bound companion-owned state and
observed public events. They do not prove that an underlying runtime transport
cannot buffer data before Web IDE exposes it.

`createKarelPlugin` accepts complete `playbackLimits` and `timelineLimits`
objects for a host that needs lower activity-specific bounds. They are
validated as positive safe integers, remain local to that plugin/controller
instance, and cannot raise the decoder's fixed protocol ceilings.

The selected browser runtime requires cross-origin isolation. A production host
must return compatible COOP, COEP, CSP, CORS, and CORP headers for the document,
SPA fallbacks, workers, WASM, and runtime assets. The development fixture proves
COOP/COEP composition; the separate packed-consumer matrix proves the exact
production policy, normal/nested/fallback/error routes, asset headers, and
real runtime downloads described in [testing.md](testing.md) and
[../SECURITY.md](../SECURITY.md).
