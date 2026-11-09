# CI and Release Governance

## CI Gates

Pull requests and pushes run lint, typecheck, unit tests, UI tests, build, documentation validation, and npm package dry run on supported Node lines.

The host matrix covers Homebridge 2.4.0, latest and beta on Node 22.13, 24 and 26. Pinning 2.4.0 keeps its additive-parts compatibility tests active after newer Homebridge releases.

## Security Gates

Dependency review and CodeQL run separately with read-only source access except for security event upload permissions required by GitHub.

## Release

Matching `v*` tags start validated Trusted Publishing after supported-Node verification. `tools/release/channel.mjs` rejects version/tag/lockfile/channel mismatches. Beta prereleases use only `beta`; `latest` remains unchanged. Preparation does not push tags or publish.
