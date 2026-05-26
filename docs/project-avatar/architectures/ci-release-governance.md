# CI and Release Governance

## CI Gates

Pull requests and pushes run lint, typecheck, unit tests, UI tests, build, documentation validation, and npm package dry run on supported Node lines.

## Security Gates

Dependency review and CodeQL run separately with read-only source access except for security event upload permissions required by GitHub.

## Release

Tag `v*` starts npm publishing with provenance. The workflow assumes npm Trusted Publishing is configured for the repository.
