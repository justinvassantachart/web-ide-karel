# Release ownership

This repository owns the source **and** the release channel for the
`@web-ide/karel` package. Releases were previously published to the private
`justinvassantachart/ths-ide` repository, which is the THS/Hamilton
application and does not own this package. They were rehomed here on
2026-09-16. Every release's `artifact-manifest.json` already recorded
`source.repository: https://github.com/justinvassantachart/web-ide-karel.git`.

This repository and its releases are **private**.

## Canonical releases

| Version | Canonical release | Source commit | Source tag |
| --- | --- | --- | --- |
| 0.3.3 | [`web-ide-karel-v0.3.3`](https://github.com/justinvassantachart/web-ide-karel/releases/tag/web-ide-karel-v0.3.3) | `3312a840a4713b4fa262968b5050b0a4b127bfcd` | `web-ide-karel-v0.3.3-source-r3` |
| 0.3.2 | [`web-ide-karel-v0.3.2`](https://github.com/justinvassantachart/web-ide-karel/releases/tag/web-ide-karel-v0.3.2) | `98d1c9748ec65462f685c497e3a0bd538321392a` | `web-ide-karel-v0.3.2-source-r3` |
| 0.3.1 | [`web-ide-karel-v0.3.1`](https://github.com/justinvassantachart/web-ide-karel/releases/tag/web-ide-karel-v0.3.1) | `95c624bf934fc74f0e6f2a2054d930d61a400c64` | `web-ide-karel-v0.3.1-source` |
| 0.3.0 | [`web-ide-karel-v0.3.0`](https://github.com/justinvassantachart/web-ide-karel/releases/tag/web-ide-karel-v0.3.0) | `e0db7183efe3bc50af3a767452e57510050a03f7` | `web-ide-karel-v0.3.0-source` |
| 0.2.0 | [`web-ide-karel-v0.2.0`](https://github.com/justinvassantachart/web-ide-karel/releases/tag/web-ide-karel-v0.2.0) | `3f57a1dde0246ff1ff08bf6ec95d7d26ddc9d872` | `web-ide-karel-v0.2.0-source-r6` |

Canonical package download pattern:

```
https://github.com/justinvassantachart/web-ide-karel/releases/download/web-ide-karel-v<version>/web-ide-karel-<version>.tgz
```

All five are byte-exact mirrors of the original `ths-ide` releases. Each
mirror's release notes list every attached asset's size and SHA-256 and
describe the provenance limits below.

## The retained `ths-ide` releases must not be retired

The original releases are retained, immutable and still resolvable. This is
**required**, not merely convenient: the live Hamilton application consumes
Karel directly from that repository, pinning
`web-ide-karel-v0.3.1/web-ide-karel-0.3.1.tgz` as
`@hamilton/retained-karel-0-3-1` and `web-ide-karel-v0.3.2/web-ide-karel-0.3.2.tgz`
as `@web-ide/karel`. Those "repository-retained" pins are a documented Hamilton
design decision. Breaking those URLs would break production.

The mirrors here are additive. Nothing in the Hamilton application was changed
by this migration.

## Release configuration is still pinned to the old channel — on purpose

`release/release-input.json` still sets `releaseRepository:
justinvassantachart/ths-ide` (and the same value inside its nested `webIDE`
block).

**Do not "fix" that in isolation.** It is pinned per release version — the same
file pins `package: "@web-ide/karel@0.3.3"` and `releaseTag:
"web-ide-karel-v0.3.3"` — and it correctly describes the 0.3.3 artifact **as it
was actually published**. Changing it without cutting a new version would make
this repository's tooling reject the `artifact-manifest.json` it already
published.

Update `releaseRepository` to `justinvassantachart/web-ide-karel` as part of
the next version bump, together with the pinned manifest-schema consts and any
`mechanism` literal, then run the normal release gates. Nothing in this
migration bypassed or re-ran any release gate.

The nested `webIDE` block also points at `ths-ide` for `web-ide` 0.4.0. Note
that `web-ide` 0.4.0 deliberately **stays** in `ths-ide` — its asset set binds
this package's private `karel-compatibility.log` as manifest evidence, so it
cannot be mirrored into the public `web-ide` repository. Only `web-ide` 0.5.0
and later are canonical at
`https://github.com/justinvassantachart/web-ide/releases`.
