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

## 3.0 recovery and state rules

- Session replacement invalidates old queued/in-flight results, disposes HTTP requests including response bodies, and reconnects the state receiver.
- One complete scoped discovery succeeds before cloud removals are reflected. Explicit local hiding is independent of cloud success.
- Fresh MQTT observations outrank late optimistic command results by field. Reconnect discards the old observation epoch; untimestamped REST values do not prove fresh sensor measurements.
- Event sensors do not become clear/offline solely because no event arrives. Unknown non-nullable Matter state is omitted with unreachable status, not reported as a new false value.
- Malformed realtime frames are ignored atomically without logging raw input. Current local bounds are 256 KiB, 256 entries, 512-character IDs and 128-character codes.
- Continuous Matter dimming is limited per device across restarts of a move; late expected reports are bounded observations, not guaranteed attribution.
- Runtime status writes keep one active write and the latest pending snapshot. Shutdown cancels timers and flushes status.
- Physical device/controller acceptance remains separate from the code tests and feature checklist.

Device history is not implemented. If added later, first define retention, capacity, deletion, account separation, protocol compatibility, and library maintenance as a separate design.

## Matter PM2.5 cache restoration

Homebridge's Matter accessory cache does not retain the explicitly composed optional `NumericMeasurement` behavior of the PM2.5 child. A restored cached endpoint can therefore lack the measurement state needed for nullable PM2.5 updates.

After fresh discovery, the plugin repairs the affected PM2.5 endpoint through the public unregister/register lifecycle. It reuses the logical accessory UUID and the fixed `air-quality` part ID. This recovery is limited to the affected PM2.5 registration; it does not use private host mutations or assume that cached metadata restores the optional behavior.

The native endpoint object and endpoint number can change during this repair. Preserved logical UUID/part IDs do not establish that a controller keeps its automation bindings. Native host tests cover endpoint reconstruction and nullable measurement updates; PM2.5 display and automation continuity after restart still require validation in a paired physical controller. Users should check both in their connected app after restarting.
