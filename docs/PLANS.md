# Plans

## Build Plan

1. Maintain official Homebridge dynamic platform gates.
2. Keep login UI sequence locked by Playwright.
3. Expand Hejhome API client only from redacted packet evidence.
4. Add device capability mappings one device class at a time.
5. Publish through npm Trusted Publishing after CI is stable.

## Active Execution Plan

`docs/exec-plans/2026-05-28-production-hardening-and-device-expansion.md` tracks the current product hardening batch: public documentation cleanup, Trusted Publishing alignment, Pi runtime regression verification, and realtime/device-state normalization tests.

## Test Plan

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:ui`
- `npm run build`
- `npm run docs:check`
- `npm pack --dry-run`

## Release Plan

Tag releases as `v*`. CI builds and tests on Node 22 and Node 24 before npm publish.
