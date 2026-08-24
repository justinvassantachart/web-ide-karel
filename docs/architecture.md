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
and does not offer Stop, even if execution startup resolves or an initial
protocol state arrives first. This readiness state resets with every run and
lifecycle teardown; a support/runtime pause cannot satisfy it.

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
distinct from a historical display cursor. Step Back and recorded Step Forward
only move that cursor; returning to live is explicit, and no API claims or
invokes Python process reversal. Terminal detail and its final/last-valid world
are held outside evictable history.

On stop, reset, world change, deactivation, or disposal, the controller clears
timers and owned source decoration state, revokes listeners, and resets its run
correlation. Events that fail the active run, sequence, or terminal checks are
rejected rather than presented.

## Rendering and accessibility

`KarelPanel` exposes native buttons/selects with visible disabled and focus
states. Polite live regions report status and frame retention. It explicitly
explains recorded history, supplies an SVG image label for Karel's position and
direction, provides a bounded textual description of beeper, wall, and painted
corner locations plus visible item counts, responds to narrow layouts, and
removes robot motion under `prefers-reduced-motion`.

`KarelWorldView` renders validated data with React/SVG primitives. World names
are text nodes and colors are restricted by the world parser; the renderer
does not inject markup or active CSS values.

## Formative comparison

`compareKarelFinalState` is pure and deterministic. It snapshots validated
worlds, canonicalizes unordered collections for comparison, and returns
dimension-specific differences. Completion is compared only when callers
supply both expected and actual facts.

Every result is labeled `formative-only`; this package has no scoring, grading,
authorization, or trusted-execution boundary.

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
