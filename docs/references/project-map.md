# Project Map

## Runtime

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Homebridge registration |
| `src/settings.ts` | Plugin and platform constants |
| `src/platform.ts` | Dynamic platform lifecycle |
| `src/platformAccessory.ts` | HomeKit service mapping |
| `src/hej/auth.ts` | Verification and login |
| `src/hej/rest.ts` | Cloud REST API |
| `src/hej/realtime.ts` | Realtime state updates |
| `src/storage/sessionStore.ts` | Session persistence |
| `src/utils/redact.ts` | Sensitive value masking |

## UI

| Path | Responsibility |
| --- | --- |
| `homebridge-ui/public/index.html` | Settings UI |
| `homebridge-ui/server.js` | Custom UI endpoints |

## Tests

| Path | Responsibility |
| --- | --- |
| `tests/official-gates.test.ts` | Homebridge package and schema gates |
| `tests/hej-auth.test.ts` | Authentication request flow |
| `tests/session-store.test.ts` | Storage persistence |
| `tests/redaction.test.ts` | Secret masking |
| `tests/platform.test.ts` | Unconfigured platform behavior |
| `tests/ui/login-ui.spec.ts` | Settings UI flow |
