# Product Sense

## Users

| User | Need | Product Decision |
| --- | --- | --- |
| Homebridge owner | Pair Hejhome account once and leave it running | Custom UI handles verification and persistent session storage |
| Operator | Know when the plugin is not configured | Platform logs a clear warning and avoids cloud discovery |
| Maintainer | Understand protocol risk | Packet-derived details are documented only in redacted form |
| Automation | Run repeatable verification | CI covers lint, typecheck, tests, build, docs, and package dry run |

## Non-Goals

- Replacing the Hejhome mobile app account creation flow.
- Storing user passwords.
- Shipping archived implementation code as runtime source.

## Acceptance

The plugin should install cleanly, present a guided login UI, avoid crashes when unconfigured, and expose supported devices as HomeKit services after a valid session is stored.
