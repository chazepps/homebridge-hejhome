# homebridge-hejhome

Homebridge dynamic platform plugin for Hejhome devices. This repository is a fresh implementation based on the official Homebridge platform plugin model; archived code under `backup/` is reference-only and is not part of the new runtime.

## Status

Source-derived implementation scaffold with tested authentication, storage, settings UI flow, and official plugin metadata gates.

## Runtime Requirements

- Node.js `22.12.0` or `24.x`
- Homebridge `^1.8.0` or `^2.0.0`
- Homebridge Config UI X with custom plugin UI support

## Development

```sh
npm install
npm run build
npm run homebridge:dev
```

The local development config lives at `test/hbConfig/config.json`.

## Login Flow

The settings UI follows the Hejhome Web sequence:

1. Enter email or phone identifier.
2. Send verification code.
3. Wait for the user to enter the code received outside Homebridge.
4. Verify the code.
5. Enable password input only after verification succeeds.
6. Submit password login with auto-login fixed on.
7. Store only session material under the Homebridge storage path.

Passwords are never persisted. Session values are redacted from logs and documentation checks.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run build
npm run docs:check
npm pack --dry-run
```

## Documentation

- `ARCHITECTURE.md` - runtime architecture
- `DOCUMENTATION_REFACTORING.md` - documentation harness progress and gates
- `docs/` - design, frontend, product, reliability, security, and release planning
