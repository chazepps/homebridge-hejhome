<p align="center">
  <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/latest/branding/logo.png" alt="Hejhome logo" height="150">
</p>

<h1 align="center">Homebridge Hejhome Plugin</h1>

<p align="center">
  The Hejhome plugin allows you to access your Hejhome device(s) from HomeKit.
</p>

<p align="center">
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img alt="Homebridge verified" src="https://img.shields.io/badge/homebridge-verified-491F59?style=for-the-badge&logo=homebridge&logoColor=white"></a>
  <img alt="Node.js 22 or 24" src="https://img.shields.io/badge/node.js-22.12%2B%20%7C%2024.x-339933?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="Homebridge 1 or 2" src="https://img.shields.io/badge/homebridge-1.8%2B%20%7C%202.x-491F59?style=for-the-badge">
  <img alt="License ISC" src="https://img.shields.io/badge/license-ISC-0f766e?style=for-the-badge">
</p>

## Overview

`homebridge-hejhome` is a dynamic platform plugin that connects Hejhome devices to HomeKit. It keeps the Hejhome plugin branding while using a fresh Homebridge implementation built around the official platform model.

The plugin handles the full Hejhome Web login flow inside Homebridge Config UI, stores session material under the Homebridge storage path, discovers devices from the Hejhome cloud, and keeps HomeKit accessories updated through REST and realtime events. Passwords and verification codes are not persisted.

## Highlights

- Plugin display name: `Hejhome`.
- Author and maintainer: [Chaz](https://github.com/chazepps).
- Repository: [chazepps/homebridge-hejhome](https://github.com/chazepps/homebridge-hejhome).
- Funding: [GitHub Sponsors](https://github.com/sponsors/chazepps).
- Custom Homebridge Config UI for phone or email verification.
- Session storage isolated from `config.json`.
- Dynamic accessory registration, update, and stale accessory cleanup.
- Realtime state updates for discovered devices.
- Device support summary and unsupported-device GitHub issue template in the settings UI.
- Documentation, lint, typecheck, unit test, UI test, and packaging gates.

## Supported Devices

Support is intentionally conservative: devices are exposed only when the HomeKit mapping is clear enough to be useful and predictable.

| Status | Device family | Hejhome types | HomeKit service |
| --- | --- | --- | --- |
| Stable | RGB and color-temperature lights | `LightRgbw*`, `LightRgb*`, `LightWw*`, `LedStrip*` | Lightbulb |
| Stable | Wall switches and relays | `Switch*`, `ZigbeeSwitch*`, `Relay*` | Switch |
| Stable | Plugs and power strips | `Plug`, `SmartPlug`, `BruntPlug`, `PowerStrip*` | Outlet |
| Stable | Curtains and blinds | `Curtain`, `Blind*` | Window Covering |
| Stable | Motion, contact, temperature, humidity, leak, and smoke sensors | `SensorMo`, `SensorRadar`, `SensorDo`, `SensorTh*`, `SensorRefTh*`, `SensorWater*`, `SensorSmoke*` | HomeKit sensor services |
| Stable | Smart button | `SmartButton` | Stateless Programmable Switch |
| Partial | IR TV, set-top, projector, lamp, speaker, DVD, camera, and DIY remotes | `Ir*` remote types | Switch |
| Partial | IR air conditioner and fan | `IrAirconditioner`, `IrFan` | Thermostat / Fan |
| Deferred | Hejhome cameras | `HomeCamera*` | Camera |

The original stable device list from the earlier README is still represented here: Zigbee switches, color bulbs, relay controllers, smart buttons, motion sensors, and smart line LED products.

## Installation

Install the plugin from the Homebridge UI or with npm:

```sh
npm install -g homebridge-hejhome
```

Then add the platform:

```json
{
  "platform": "Hejhome",
  "name": "Hejhome"
}
```

Open the plugin settings in Homebridge Config UI and complete the Hejhome login sequence. The password field is enabled only after the verification code succeeds, and the password itself is never written to disk.

## Local Development

Use the Node version from `.nvmrc` when possible.

```sh
nvm use
npm install
npm run build
npm run homebridge:dev
```

For the local Homebridge Config UI surface:

```sh
npm run homebridge:ui
```

The development Homebridge config lives in `test/hbConfig/config.json`.

## Verification

Run the focused checks while iterating:

```sh
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run build
npm run docs:check
npm pack --dry-run
```

## Release

Releases are published by GitHub Actions from `v*` tags. The release workflow installs dependencies, runs the same verification gate used by `prepublishOnly`, checks the package with `npm pack --dry-run`, and publishes to npm through npm Trusted Publishing with provenance. Configure the repository as a trusted publisher in npm before pushing a release tag:

```sh
git tag v2.0.0
git push origin v2.0.0
```

## Project Map

| Path | Purpose |
| --- | --- |
| `src/platform.ts` | Homebridge dynamic platform lifecycle, discovery, and realtime wiring |
| `src/hej/` | Hejhome Web authentication, REST, and realtime clients |
| `src/storage/` | Session, device snapshot, and log storage |
| `homebridge-ui/` | Custom Homebridge Config UI and UI server |
| `docs/` | Product, frontend, reliability, security, and architecture notes |

## Contributing

Device support grows best with real device data. If a device is missing or partially supported, open an issue with the unsupported-device template shown in the plugin settings UI. Pull requests should include the relevant test updates and pass the verification commands above.

## License

ISC. See [LICENSE](LICENSE).
