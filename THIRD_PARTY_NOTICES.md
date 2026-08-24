# Third-party notices and provenance

The Web IDE Karel source is licensed under MIT. This file records notable
provenance, but it is not a substitute for the license texts and notices
required by files and dependencies in an exact distribution artifact.

The package contains no copied legacy Karel application code, Nova LMS,
Firebase, lesson, replay, interpreter, or Web IDE implementation. Its
JavaScript bundle externalizes React, React DOM, and Web IDE, and `npm pack`
reports no bundled npm dependencies. The owner-authored Python teaching
library, world contract, starter, styles, and default synthetic world ship as
package files.

The presentation includes one owner-authorized visual asset copied at the
repository owner's explicit direction from the user-owned Karel IDE reference:

- source repository: `https://github.com/justinvassantachart/karel-ide.git`;
- source commit: `09ec05ae52d818ce202910f30a6867e60c58848e`;
- source path: `public/karel.png`;
- companion source path: `src/assets/karel.png` (inlined into the built JavaScript); and
- SHA-256: `7650ed9c8dfcbb118c826762260b6bfb57507833ab3a2dd87d9a816f61a2aebb`.

The reference repository supplies no separate license, notice, or documented
upstream provenance for that PNG. It is included under this package's MIT
license at the owner's direction and is not a source, runtime, state, hook, or
dependency relationship with the reference application.

Web IDE is a separate MIT-licensed peer package. React and React DOM are
separate peer dependencies under their own licenses. Development and consumer
dependencies retain their own licenses and notices and are not package files.

The deterministic release-evidence workflow generated a per-file machine
license inventory, deduplicated `THIRD_PARTY_LICENSES.txt`, and CycloneDX 1.6
SBOM for the immutable `0.2.0` r6 artifact. This redesigned presentation changes
packaged bytes and therefore requires new successor evidence; it does not alter
or reuse that historical artifact identity.
