# Web IDE Karel

`@web-ide/karel` is a reusable, host-registered Karel companion for Web IDE. It
owns Karel's world contract, Python teaching library, protocol, playback,
renderer, and panel. It does not provide a Python interpreter, persist host
data, or add Karel behavior to Web IDE core.

The private source repository is preparing the MIT-licensed `0.2.0` candidate.
The package remains `private: true` and is not published to npm. Its supported
Web IDE peer line is `>=0.2.0 <0.3.0`; release consumers still install one exact
reviewed Web IDE/Karel artifact pair rather than choosing a version from that
range. P2.5 remains open until the candidate also has complete license, SBOM,
reproducibility, immutable-release, and independent-download evidence.

The package composes only through public Web IDE contributions and panel
services. A host selects a generic runtime that advertises Python and, for line
playback, debugger support plus the optional owner-scoped transient-breakpoint
overlay API. Providers without that API may still execute Python outside the
Karel playback controller, but Karel line playback fails closed with a clear
capability error instead of taking ownership of editor breakpoints.

## Host composition

Create strict world documents, pass them to one plugin instance, and register
that plugin beside the generic workbench and runtime plugins:

```tsx
import {
  WebIDE,
  WebIDEHostProvider,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'
import { coreWorkbenchPlugin } from 'web-ide/plugins'
import { pythonRuntimePlugin } from 'web-ide/runtimes'
import {
  DEFAULT_KAREL_WORLD,
  KAREL_WORLD_SCHEMA_NAME,
  KAREL_WORLD_SCHEMA_VERSION,
  createKarelPlugin,
  type KarelWorldDocumentV1,
} from '@web-ide/karel'
import 'web-ide/styles.css'
import '@web-ide/karel/styles.css'

const challenge: KarelWorldDocumentV1 = {
  schema: KAREL_WORLD_SCHEMA_NAME,
  version: KAREL_WORLD_SCHEMA_VERSION,
  world: {
    name: 'Collect the Beeper',
    columns: 6,
    rows: 5,
    karel: {
      avenue: 1,
      street: 1,
      direction: 'east',
      beepersInBag: 0,
    },
    beepers: [{ avenue: 4, street: 1, count: 1 }],
    walls: [{ avenue: 2, street: 2, direction: 'east' }],
    colors: [],
  },
}

const karelPlugin = createKarelPlugin({
  worlds: [
    {
      id: 'first-steps',
      document: {
        schema: KAREL_WORLD_SCHEMA_NAME,
        version: KAREL_WORLD_SCHEMA_VERSION,
        world: DEFAULT_KAREL_WORLD,
      },
    },
    { id: 'challenge', document: challenge },
  ],
})

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  plugins: [pythonRuntimePlugin, coreWorkbenchPlugin, karelPlugin],
}

const host: WebIDEHost = {
  workspace: { id: 'karel-example-v1', localCache: 'memory' },
}

export function PythonKarelIDE() {
  return (
    <WebIDEHostProvider host={host}>
      <div style={{ width: '100vw', height: '100vh' }}>
        <WebIDE configuration={configuration} />
      </div>
    </WebIDEHostProvider>
  )
}
```

The example selects Web IDE's generic Python provider, but this package does
not import that provider. Hosts may use another public-contract-compatible
Python provider. Set `contributeRunCommand: false` when the host already owns
its Run affordance.

## World documents

Portable worlds use one explicit, versioned envelope:

```json
{
  "schema": "web-ide-karel/world",
  "version": 1,
  "world": {
    "name": "Example",
    "columns": 10,
    "rows": 8,
    "karel": {
      "avenue": 1,
      "street": 1,
      "direction": "east",
      "beepersInBag": "infinite"
    },
    "beepers": [],
    "walls": [],
    "colors": []
  }
}
```

`parseKarelWorldDocument` rejects unknown or missing fields, unsupported
versions, non-plain objects and arrays, unsafe integers, invalid or duplicate
items, out-of-bounds coordinates, implicit boundary walls, and unsafe colors.
Worlds are limited to 100 by 100, each item array to 10,000 entries, and names
to 256 characters. Canonicalization sorts items, lowercases colors, and
normalizes equivalent west/south wall descriptions to east/north.

Public world-contract exports include:

- `KAREL_WORLD_DOCUMENT_SCHEMA`, the immutable portable JSON Schema;
- `parseKarelWorldDocument`, `canonicalizeKarelWorldDocument`, and
  `serializeKarelWorldDocument`;
- `convertBareKarelWorldToDocument`, for the former companion body shape; and
- `convertStandaloneKarelWorldToDocument`, for the documented
  `r`/`c`/`cols`, keyed-beeper, and wall-string shape.

Converters are explicit and return a canonical preview plus conversion
warnings. The strict parser never guesses a legacy shape. The older
`parseKarelWorld`/`serializeKarelWorld` functions remain compatibility-only
bare-world APIs; new portable storage and interchange should use the versioned
document.

The same strict contract is available to Python consumers from
`@web-ide/karel/python/karel_world_contract.py`. TypeScript and Python parity
tests share the fixtures in `tests/fixtures/world-contract-cases.json`.

Coordinates are one-based. Avenues increase left-to-right and streets increase
bottom-to-top. World boundaries are implicit walls.

## Workspace and execution resources

The default plugin separates student workspace content from runtime support:

| Path | Scope | Purpose |
| --- | --- | --- |
| `/workspace/main.py` | Ordinary workspace | Editable starter/student program |
| `/sysroot/karel.py` | Execution-only | Python teaching library |
| `/sysroot/karel_world.json` | Execution-only | Exact selected world for the next run |
| `/sysroot/karel_run.json` | Execution-only | Fresh protocol-v2 run identity |

`createKarelWorkspaceFiles` returns only the starter. The plugin materializes
the other three paths dynamically for every execution with
`createKarelExecutionFiles`. Web IDE excludes execution-only files from the
editor and persisted-file projection, so changing or resetting a world does
not modify student code.

Execution-only resources are still delivered into a user-controlled browser.
They are not confidential and must never contain secrets or hidden,
authoritative checks.

## Python teaching API

A program defines `main` and passes it to `run_karel`:

```py
from karel import move, run_karel, turn_left, turn_right


def main():
    move()
    turn_left()
    turn_right()


if __name__ == "__main__":
    run_karel(main)
```

The library includes:

- actions: `move`, `turn_left`, native single-action `turn_right`,
  `pick_beeper`, `put_beeper`, and `paint_corner`;
- movement predicates: `front/left/right_is_clear` and the corresponding
  `*_is_blocked` forms;
- beeper predicates: `beepers_present`, `no_beepers_present`,
  `beepers_in_bag`, and `no_beepers_in_bag`;
- direction predicates: all four `facing_*` and `not_facing_*` forms; and
- world helpers: `set_world`, `get_world`, `corner_color_is`, and
  `KarelWorld.load`.

Invalid operations raise typed `KarelError` subclasses. `run_karel` publishes
one correlated terminal event and re-raises Python failures so the generic
runtime retains the ordinary traceback.

## Protocol v2

Runtime events travel through stdout in a private ANSI OSC frame:

```text
ESC ] 777 ; web-ide-karel ; <base64url JSON> BEL
```

Every v2 event contains `protocol`, `version`, an opaque `runId`, and a
contiguous sequence beginning at zero. State events contain an action, a
validated world, and an eligible relative POSIX source location when one is
available. One terminal event settles the run as `completed`, `runtime-error`,
`aborted`, or `limit-exceeded`.

`KarelProtocolDecoder` incrementally separates framed events from ordinary
stdout, validates exact event fields and source paths, rejects wrong-run,
non-contiguous, unsupported, malformed, oversized, and post-terminal events,
and can resume after a rejected frame. Before execution, the plugin binds the
store to the exact run ID that it just materialized in `/sysroot/karel_run.json`.
A sequence-zero event with any other ID is rejected, and up to 256 retired run
IDs remain blocked so late output from a previous run cannot become the next
run. Expected stale/wrong-run correlation rejections do not replace the visible
state with a protocol error. Current defensive limits are:

| Boundary | Limit |
| --- | ---: |
| One OSC frame | 2,000,000 characters |
| Protocol events per run | 100,000 |
| Protocol events per decoder push | 1,024 |
| Reported decoder errors per push | 64 |
| Framed protocol characters per run | 8,388,608 characters |
| Run ID / source path | 128 / 512 characters |
| Action / message / error type | 64 / 4,096 / 128 characters |

Protocol data and student stdout are untrusted browser input. A decoded event
is formative UI state, never an authorization or grading result.

## Playback and history

`KarelPlaybackController` consumes only the panel's public `runtime`,
`execution`, `source`, and `workspace` services. It filters debugger pauses to
existing `/workspace` files, skips support/runtime locations, combines eligible
line pauses with validated Karel action frames, and owns current, historical,
and error source decorations.

For each playback run, the controller snapshots the workspace's Python files
and contributes every non-empty, non-comment source line through Web IDE's
owner-scoped transient-breakpoint overlay. It starts ordinary debug execution
and continues between eligible stops, which preserves deterministic lines in
nested student modules without changing visible editor breakpoints. The overlay
is cleared on settlement, stop, reset, deactivation, and disposal. Replacement
is subject to the selected runtime provider's combined breakpoint quota.

The panel exposes Prepare, Play, Pause, Stop, Restart, Reset, Step forward,
Step back, Return to live, playback speed, and multi-world selection. Step back
changes only the displayed recorded world; it never reverses the live Python
process. Reset stops the run and restores the selected initial world without
rewriting student files. Changing worlds performs the same execution/timeline
reset before selecting the next initial world. Cleanup cancels timers, clears
owned source decorations, and revokes subscriptions.

A new run remains visibly `Starting`, with Stop, Reset, Restart, and world
selection unavailable, until the runtime has delivered its first validated
pause in a student workspace file. An early execution-start resolution,
support-code pause, or protocol state frame cannot be mistaken for that
readiness boundary. Terminal settlement invalidates pending local preparation
generations so a limit cannot launch execution after it has already settled.

Current defaults are:

- timeline retention: at most 128 frames and 8 MiB of serialized frames, with
  deterministic oldest-first eviction and visible truncation counts;
- debugger pauses: 10,000 per run;
- elapsed time: 60 seconds per run;
- ordinary stdout/stderr observed by playback: 16 MiB per run; and
- playback delay: 300 ms, clamped to 50–2,000 ms.

Hosts may pass complete, positive-integer `playbackLimits` and
`timelineLimits` objects to `createKarelPlugin`. The former owns pause, elapsed,
output, and playback-speed bounds; the latter owns retained frame count and
serialized UTF-8 bytes. Limits are instance-scoped, validated at controller
construction, and do not change the protocol decoder's defensive ceilings.

Terminal failures and limits are preserved separately from evictable history.
Accessible names, live status/frame text, visible focus, responsive controls,
a reduced-motion rule, an SVG robot description, and a textual world summary
are included in the panel.

## Formative comparison

`compareKarelFinalState(actual, expected, options)` compares dimensions,
position, direction, beeper bag, beeper piles, walls, colors, and an explicitly
supplied completion fact. Ordering is deterministic and input worlds are
snapshotted.

Every result carries `authority: "formative-only"`. The helper returns matches
and differences, not a score or grade, and must not be used as trusted evidence
or an authorization boundary.

## Development

The package declares Node 20 or later and Python 3.10 or later. From a clean
checkout:

```sh
npm ci
npm run check:python
npx playwright install chromium
npm run validate:production
```

`npm run validate` executes, in order, lint, all non-browser TypeScript and
Python tests, typechecking, the library and basic-example builds, and
`npm pack --dry-run`. `test:python` runs the version checker first and fails
closed below Python 3.10. `validate:production` adds the development browser
suite, full and production dependency audits, and a locked fresh consumer that
installs exact packed Web IDE and Karel artifacts with lifecycle scripts
disabled and a disposable npm cache, builds them for production, serves the
nested SPA with production headers, and runs the release browser matrix.

The packed matrix builds temporary candidates from the adjacent Web IDE and
current Karel source by default. To validate already-built release candidates,
provide both absolute paths. Their bytes must match the committed consumer
lock before npm is invoked:

```sh
WEB_IDE_CANDIDATE_TARBALL=/absolute/path/web-ide-0.2.0.tgz \
KAREL_CANDIDATE_TARBALL=/absolute/path/web-ide-karel-0.2.0.tgz \
  npm run test:packed-production
```

The Web IDE release compatibility run additionally sets
`KAREL_RELEASE_WEB_IDE_GATE_RECEIPT=1` and supplies the canonical Web candidate
state through `KAREL_RELEASE_WEB_IDE_CANDIDATE_STATE` plus the canonical Karel
candidate state through `KAREL_RELEASE_KAREL_CANDIDATE_STATE`. After the
complete, unfiltered exact-pair gate succeeds, the script emits Web IDE's
required candidate/source-bound receipt as the final stdout line. Receipt mode
rejects source-built candidates, unbound Karel bytes, and diagnostic filtering.
The release capture runner later replaces only declared local repository,
candidate, execution, workspace, and home roots with stable placeholders and
fails if a personal or temporary absolute path remains.

The source license and package version do not themselves complete a release.
See [publishing readiness](docs/publishing-readiness.md) for the remaining
artifact and immutable-release evidence.

### Deterministic release evidence

`npm run release:candidate` is the Karel candidate builder. In its
default `final` mode it requires a clean, pushed `main`, the pushed annotated
`web-ide-karel-v0.2.0-source-r3` tag at `HEAD`, the exact Node/npm toolchain, an
absent external output path, and the exact Web IDE candidate state and tarball.
It verifies the canonical Web candidate state, runtime-assets report, tar
SHA-256, consumer-lock SHA-512 integrity, and package identity before running
two isolated clean Karel installs/builds/packs with fresh npm caches. It then
writes a deterministic source archive, candidate tarball, safe tar inventory,
license inventory, deduplicated license text, CycloneDX SBOM, reproducibility
report, and candidate state outside the repository.

The dependency-ordered release sequence deliberately has two stages. Karel's
candidate binds Web IDE's pre-manifest candidate evidence so the paired
compatibility gate can run without a circular manifest dependency. After that
gate finalizes Web IDE's artifact manifest, `npm run release:finalize` verifies
the canonical Web manifest, sidecar, exact tarball, and runtime report against
the peer bytes recorded by Karel and accepts only six outputs from the
repository's validation-gate capture runner. Each output contains the exact
normalized capture log plus a canonical receipt recording the stable logical
executable/argv, normalized environment policy, actual exit status, Karel/Web
source identities, and exact candidate pair. Finalization copies and rehashes
those caller-supplied bytes,
independently validates every receipt and the Web compatibility footer,
regenerates the source archive, package inspection, license evidence, and SBOM,
and writes Karel's final manifest and sidecar to a separate atomic output.
Karel references Web IDE's runtime evidence by digest and never claims or
duplicates Web-owned runtime assets.

The scripts require absolute external input/output paths; see
[docs/testing.md](docs/testing.md) for exact variables and the explicitly
non-final test mode. They do not tag, publish, upload, or mutate a release.

`npm run test:browser` alone still uses a cross-origin-isolated Vite development
fixture and is not production proof. See [docs/testing.md](docs/testing.md) for
the exact development and packed-production workflows and
[docs/architecture.md](docs/architecture.md) for ownership and lifecycle
details. Security boundaries and reporting are in [SECURITY.md](SECURITY.md).
