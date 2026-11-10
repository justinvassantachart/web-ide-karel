# UI staging preview

`0.3.5-ui.0` is a branch-built prerelease for staging approval, based on the exact
published `0.3.4` source tag. It is not a canonical stable release candidate;
historical stable release metadata and tags remain unchanged.

A Stop initiated from the host or shared IDE toolbar now uses the public
runtime's optional settled outcome. A deliberate `stopped` outcome becomes a
neutral aborted Karel run, matching Karel's own Stop control. A normal successful
Python exit missing the required Karel terminal event still fails visibly.
Late settlement from a retired run cannot alter a newer run. Older/custom
runtimes without settled outcomes retain their previous behavior.

Validation includes the complete TypeScript and Python test suites, focused
host-stop/missing-protocol regressions, lint, type checking, a library build, and
a zero-vulnerability production dependency audit. The legacy development
lockfile has existing audit findings; this preview adds no bundled dependency.
The consuming staging application separately verifies the exact companion/IDE
package composition before deployment.
