# Third-party notices and provenance

The Web IDE Karel source is licensed under MIT. This file records notable
provenance, but it is not a substitute for the license texts and notices
required by files and dependencies in an exact distribution artifact.

The package contains no copied legacy Karel application, Nova LMS, Firebase,
lesson, replay, interpreter, or Web IDE implementation. Its JavaScript bundle
externalizes React, React DOM, and Web IDE, and `npm pack` reports no bundled
npm dependencies. The owner-authored Python teaching library, world contract,
starter, styles, and default synthetic world ship as package files.

Web IDE is a separate MIT-licensed peer package. React and React DOM are
separate peer dependencies under their own licenses. Development and consumer
dependencies retain their own licenses and notices and are not package files.

The deterministic release-evidence workflow generates a per-file machine
license inventory, deduplicated `THIRD_PARTY_LICENSES.txt`, and CycloneDX 1.6
SBOM tied to one exact `0.2.0` tarball. P2.5 remains incomplete until those
outputs are generated and reviewed from the final pushed/tagged source and
exact finalized Web IDE peer, then published and independently re-downloaded
under the documented immutable-release gate.
