# Homebridge Plugin Runtime

## Shape

The plugin is a Dynamic Platform Plugin. It registers with Homebridge through `api.registerPlatform(PLATFORM_NAME, HejhomePlatform)`.

## Lifecycle

1. Constructor stores Homebridge API references.
2. `configureAccessory()` restores cached accessories.
3. `didFinishLaunching` starts session loading and discovery.
4. New accessories are registered only after launch.
5. Shutdown disconnects realtime transport.

## UUID Rule

Accessory UUIDs are generated from Hejhome device ids, so HomeKit identity remains stable across restarts.
