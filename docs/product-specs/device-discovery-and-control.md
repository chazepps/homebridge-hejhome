# Device Discovery and Control Spec

## Goal

Expose supported Hejhome devices to HomeKit through Homebridge services.

## Discovery

The platform loads a stored session, fetches families, fetches devices per family, and creates stable Homebridge accessories from device ids.

## Control

Switch-like devices use the HomeKit `On` characteristic. The cloud control client submits the detected power datapoint and updates local state after the request resolves.

## Capability Registry

Device classes are classified through the capability registry before Homebridge services are created.

- `supported`: HomeKit meaning is clear and the adapter can create normal services.
- `partial`: API evidence exists, but only a safe subset is exposed or implementation is pending.
- `deferred`: discovery and API notes are tracked, but HomeKit exposure is intentionally held for a later batch.
- `unsupported`: the plugin records the device in diagnostics but does not create HomeKit controls.

Unknown device classes are not promoted to supported controls. Users see them in the settings UI with a GitHub issue template so new support can be added from redacted device evidence.
