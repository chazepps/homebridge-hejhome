# Homebridge Plugin Runtime

## Shape

The plugin is a Dynamic Platform Plugin. It registers with Homebridge through `api.registerPlatform(PLATFORM_NAME, HejhomePlatform)`.

## Lifecycle

1. Constructor stores Homebridge API references.
2. `configureAccessory()` restores cached accessories.
3. `didFinishLaunching` applies local visibility and recovers missing Matter endpoints from the cached device inventory before session loading and cloud discovery.
4. New accessories are registered only after launch.
5. Shutdown disconnects realtime transport.

## UUID Rule

Accessory UUIDs are generated from Hejhome device ids, so HomeKit identity remains stable across restarts.

Matter identity also requires the bridge to retain its device topology when a controller reconnects. If the native Matter cache is missing, cached HAP metadata and the device snapshot restore missing parents and stable part IDs before network requests. Snapshot recovery requires a matching session fingerprint and discovery scope, rechecks the session after loading, and filters selected families and rooms. This also covers explicitly Matter-only devices, which have no HAP cache. Existing native Matter endpoints remain in place. Recovered devices stay unreachable and cannot be controlled until the current session verifies them through discovery. Failed asynchronous registration remains retryable; a late completion is detected before registering again.

Sensors with confirmed battery support declare the battery cluster even when no reading is available. Its initial value is unknown, so the first battery report updates the same endpoint without unregistering and recreating the device or its parts.

Snapshot read failures remain retryable through the session watcher. Only a completed read and session recheck mark inventory loading complete.

## Adding Matter ports without replacing devices

Homebridge 2.4.0's standard update API changes metadata but does not create new child endpoints. The compatibility tool at `tools/homebridge/patch-additive-matter-parts.mjs` adds this capability for an existing composed accessory. It preserves the parent and existing child endpoints, endpoint numbers, part order and semantic tags, rebinds command handlers, and shares live child state with the serialized cache. The plugin waits for each added child to become available before reporting its state. A report that omits a previously published power-strip port does not remove that port.

Queued updates retain their original registration identity and recheck the node and endpoint after asynchronous work. Child creation receives the same guard and checks it after each asynchronous boundary, before updating shared command registries. Removing or stopping a device cancels its pending update; reusing its UUID does not authorize the old work against a replacement. Parent cache containers are retained so reports received during queue waits or endpoint transactions remain current on disk.

The tool targets only Homebridge 2.4.0 and verifies the exact original method hashes. It does not run during npm installation and does not restart Homebridge. Check the installed core first, apply during a controlled restart, then validate the restored device and port identities:

```sh
node tools/homebridge/patch-additive-matter-parts.mjs --homebridge-root /path/to/homebridge --check
node tools/homebridge/patch-additive-matter-parts.mjs --homebridge-root /path/to/homebridge --apply
```

Original sources and checksums are saved in the recovery directory reported by the tool. To undo this compatibility patch, use `--restore` in place of `--apply`, then restart the affected child bridge. Restore refuses to overwrite files changed outside the patch. A Homebridge upgrade can replace the patched files; a different version or implementation requires a new compatibility review.

Restore validates the complete manifest and every original file before making any change, then writes the verified in-memory contents. Missing or damaged recovery data leaves the installed core and recovery files untouched.

`tests/matter-additive-parts.test.ts` patches an isolated copy of the real Homebridge core. It checks asynchronous port creation, native cache restoration, unchanged original endpoint identities, command rebinding, concurrent updates, failed-part cleanup/retry, serialized live state, ownership, semantic tags after a second restore, and safe patch rollback. The pinned compatibility tests are skipped for other Homebridge versions; the ordinary plugin tests still cover those host channels.
