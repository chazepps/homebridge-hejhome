# Hejhome Production Hardening And Next Device Expansion

This document is the execution plan for an agentic worker. Follow it step by step and stop each step only after producing the artifact or validation named in that step.

## Goal

Prepare `homebridge-hejhome` for a safer productization pass before adding riskier device families. This batch closes public documentation hygiene, release policy consistency, Pi runtime regression verification, and realtime/device-state normalization coverage.

Camera streaming, broad IR remote control, air purifier behavior, door locks, and alarm-style notification devices are intentionally deferred. This plan records their next evidence needs but does not ship those integrations.

## Architecture

- The plugin remains a Homebridge Dynamic Platform Plugin.
- The public docs describe only the current implementation, redacted API behavior, and HomeKit mapping decisions.
- The release path is npm Trusted Publishing with provenance through GitHub Actions OIDC.
- Pi regression checks run outside Homebridge and inspect the deployed runtime through SSH without printing tokens, cookies, account ids, or raw session material.
- Realtime MQTT payloads are normalized before they touch HomeKit accessory state.

## Tech Stack

- Node.js 22 and 24
- Homebridge 1.8 or 2.x
- TypeScript 6
- Vitest and Playwright
- GitHub Actions
- npm Trusted Publishing with provenance
- Raspberry Pi Homebridge runtime through `hb-service`

## Step 1: Public Documentation Cleanup

Remove public references to private provenance, removed archive directories, or analysis-source hints from README and docs. Keep API documents limited to endpoint families, field names, state semantics, and HomeKit mapping decisions.

Artifact:

- Public docs no longer contain private provenance hints or removed archive directory references.
- `tools/docs/harness-lib.mjs` rejects these terms during `npm run docs:check`.

Validation:

```sh
npm run docs:check
git diff --check
```

## Step 2: Release Policy Alignment

Make release docs and `.github/workflows/release.yml` say and do the same thing: npm Trusted Publishing with provenance. Do not require or inject a long-lived npm token secret in the workflow.

Artifact:

- Release workflow keeps `id-token: write`.
- Release workflow runs `npm publish --access public --provenance`.
- README tells maintainers to configure npm Trusted Publishing.

Validation:

```sh
npm test -- tests/public-surface.test.ts
```

## Step 3: Pi Runtime Regression Script

Add `npm run homebridge:pi:verify` to check a real Pi installation over SSH. The script verifies:

- Pi Homebridge Node is v22 or v24.
- Homebridge service is active.
- Homebridge loads the dev checkout from `/var/lib/homebridge/dev-plugins/homebridge-hejhome`, either directly or through the local plugin path.
- Linked plugin package version is readable.
- Device snapshot has at least one family and one device.
- Logs contain `session.loaded`, `accessory-load.start`, `snapshot.saved`, and `realtime.subscribe.success`.
- Snapshot includes the current core device set: RGBW light, motion sensor, white light, Zigbee switch, and relay controller.

Artifact:

- `tools/homebridge/verify-pi-runtime.mjs`
- `homebridge:pi:verify` package script

Validation:

```sh
npm run homebridge:pi:verify
```

## Step 4: Snapshot And Realtime Regression Coverage

Keep a redacted Pi snapshot fixture for the current observed device mix. Use it only for type and capability coverage; do not store real tokens, cookies, account ids, or raw device ids.

Add regression tests to make sure raw realtime codes such as `colour_data`, `work_mode`, and `pir` are normalized and do not remain in HomeKit-facing device state.

Artifact:

- `tests/fixtures/pi-devices-snapshot.json`
- Snapshot fixture test
- Realtime raw-code leak regression test

Validation:

```sh
npm test -- tests/pi-snapshot-fixture.test.ts tests/realtime.test.ts
```

## Step 5: Backlog Sync

Synchronize `docs/api/README.md`, device product specs, and the capability registry support states.

Backlog policy:

- Camera: deferred to a dedicated HomeKit `CameraController` and media relay plan.
- IR: partial until each remote key has safe HomeKit meaning.
- Air purifier: partial until mode, fan, filter, and air-quality fields are verified.
- Door lock and alarm-like devices: partial until secure state and notification behavior are proven.

Artifact:

- API and product docs describe the same supported, partial, deferred, and unsupported categories shown by the settings UI.

Validation:

```sh
npm run docs:check
```

## Step 6: Full Verification

Run the full local gate and packaging dry run.

Validation:

```sh
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run build
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

## Release Impact

No runtime user-facing breaking change is expected in this batch. The release workflow changes its credential source from a long-lived npm secret to npm Trusted Publishing. Maintainers must configure the repository as a trusted publisher in npm before pushing a `v*` tag.

## Rollback

- If the release workflow fails before publish, restore the previous workflow only as a temporary emergency step and rotate any secret used.
- If Pi verification fails, do not publish. Fix the linked checkout, Homebridge service, session, snapshot, or realtime connection first.
- If realtime normalization regresses, keep the old published version installed on Pi and fix the mapper before release.
