# Reliability

## Failure Modes

| Failure | Expected Behavior | Verification |
| --- | --- | --- |
| No stored session | Warn and skip discovery | `tests/platform.test.ts` |
| Verification send failure | Show UI error without saving config | UI request handler returns `RequestError` |
| Verification mismatch | Keep password and login disabled | `tests/ui/login-ui.spec.ts` |
| Password login failure | Do not save partial session | `homebridge-ui/server.js` handler boundary |
| Realtime disconnect | MQTT client reconnects using configured policy | `src/hej/realtime.ts` |
| Device removed upstream | Unregister stale accessory after discovery | `src/platform.ts` |

## Recovery

Users recover by reopening plugin settings and completing login again. The runtime never requires a TTY or custom Homebridge startup parameter.

## Operational Rule

All thrown errors at cloud and UI boundaries must be caught, logged or returned in redacted form, and must not crash Homebridge.
