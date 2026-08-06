# Web IDE Karel

`@web-ide/karel` is a separate, host-registered Karel companion for Web IDE.
It owns the Karel panel, world model, Python teaching library, workspace
resources, framed event protocol, and subscription cleanup. Web IDE core does
not import this package and contains no Karel-specific behavior.

The companion does **not** provide a Python interpreter. A host composes it
with any generic Web IDE Python runtime provider whose selected session exposes
the public runtime contract. The plugin checks the `python` language ID and
subscribes to standard `stdout`, `terminalClear`, and `exit` events; it never
checks a provider ID or imports a provider implementation.

## Host composition

Install this package alongside `web-ide`, React, and the Python runtime provider
chosen by your host. Create the plugin inside the host's composition:

```tsx
import {
  WebIDE,
  WebIDEHostProvider,
  type WebIDEConfiguration,
  type WebIDEHost,
} from 'web-ide'
import { pythonRuntimePlugin } from 'web-ide/runtimes'
import { createKarelPlugin } from '@web-ide/karel'
import 'web-ide/styles.css'
import '@web-ide/karel/styles.css'

const configuration: WebIDEConfiguration = {
  runtimeProvider: 'web-ide.runtime.python',
  plugins: [pythonRuntimePlugin, createKarelPlugin()],
}

const host: WebIDEHost = {
  workspace: {
    id: 'karel-example-v1',
    localCache: 'memory',
  },
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

This runnable example uses Web IDE's built-in generic Python provider, but the
Karel package does not import it. A host can substitute any plugin contributing
a structurally compatible `RuntimeProvider`/`RuntimeSession`; the provider ID
is chosen by the host and is intentionally not known by Karel. Hosts with their
own Run button can pass `createKarelPlugin({ contributeRunCommand: false })`.

## Workspace resources

The default plugin contributes three ordinary workspace seed files:

- `/workspace/karel.py` — the dependency-free Python library;
- `/workspace/karel_world.json` — the initial world, available directly to the
  bundled starter and replaceable by the host;
- `/workspace/main.py` — a small runnable starter program.

Web IDE's normal precedence rules apply, so host `initialFiles` can replace the
starter or world without changing this package. A custom world can also be
provided directly:

```ts
const karel = createKarelPlugin({
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
})
```

Coordinates follow traditional Karel conventions: avenues increase from left
to right and streets increase from bottom to top. World boundaries are always
walls. An internal wall may be described from either adjacent corner; the
Python model blocks movement from both sides.

## Python API

A program defines `main` and passes it to `run_karel`:

```py
from karel import *


def main():
    while front_is_clear():
        move()
    put_beeper()


if __name__ == "__main__":
    run_karel(main)
```

The library includes:

- actions: `move`, `turn_left`, `pick_beeper`, `put_beeper`, `paint_corner`;
- movement tests: `front_is_clear`, `left_is_clear`, `right_is_clear` and their
  `*_is_blocked` complements;
- beeper tests: `beepers_present`, `no_beepers_present`, `beepers_in_bag`,
  `no_beepers_in_bag`;
- direction tests: `facing_north/east/south/west` and `not_facing_*`;
- world helpers: `set_world`, `get_world`, `corner_color_is`, and
  `KarelWorld.load`.

Invalid moves and beeper operations raise specific `KarelError` subclasses.
`run_karel` publishes the error state and re-raises so the generic Python
runtime can still report the normal traceback.

## Protocol

Karel events travel through stdout in a versioned private ANSI OSC frame:

```text
ESC ] 777 ; web-ide-karel ; <base64url JSON> BEL
```

OSC frames are invisible in xterm-compatible terminals. The JSON envelope
contains `protocol`, `version`, `type`, and monotonic `sequence` fields. Event
types are `state`, `complete`, and `error`. `KarelProtocolDecoder` handles
frames split across arbitrary stdout chunks, multiple frames in a chunk,
ordinary output before/between/after frames, malformed payloads, and truncated
process output. It limits frame and world sizes before rendering untrusted
runtime data.

## Public exports

The root entry exports the plugin factory, Karel panel/world view, TypeScript
world and protocol types, incremental decoder, session store, embedded source
strings, and workspace resource helpers. Raw package assets are also available
at `@web-ide/karel/python/karel.py` and
`@web-ide/karel/worlds/default.json`.

## Development

```sh
npm install
npm run validate
npm run test:browser
```

`validate` runs TypeScript/React unit, component, and integration tests; Python
standard-library tests; type checking; linting; the library build; and a package
contents check. Browser tests use Playwright and require its Chromium browser
to be installed (`npx playwright install chromium`).

`examples/basic` is a complete host composition using only public `web-ide`,
`web-ide/plugins`, `web-ide/runtimes`, and package-root exports. The production
build compiles this example after the library to catch consumer-facing export
or configuration drift.
