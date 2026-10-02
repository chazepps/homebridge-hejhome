[한국어](README.md) | **English**

<p align="center">
  <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/main/branding/logo.png" alt="Hejhome logo" height="110">
</p>

<h1 align="center">Homebridge Hejhome</h1>

<p align="center">
  Connect Hejhome devices to Apple Home
</p>

<p align="center">
  <img alt="Homebridge 2.4 or later" src="https://img.shields.io/badge/homebridge-2.4%2B-491F59?style=for-the-badge">
  <img alt="Node.js 22, 24 or 26" src="https://img.shields.io/badge/node.js-22.13%2B%20%7C%2024.x%20%7C%2026.x-339933?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="ISC license" src="https://img.shields.io/badge/license-ISC-0f766e?style=for-the-badge">
</p>

Use lights, switches, plugs and sensors registered in the Hejhome app through Apple Home, Siri and Home automations. Supported devices can also connect to Google Home and SmartThings through Matter.

A Hejhome account and an internet connection are required. Device control uses the Hejhome cloud.

> **About the 3.0 beta**
> This document covers **3.0.0-beta.1**. **Stable v2 uses `latest`; beta v3 uses `beta`.** Normal installations and updates use the stable version. Select the v3 beta explicitly. Features and system requirements differ between the two versions.

[Getting started](#getting-started) · [Settings](#settings) · [Supported devices](#supported-devices-and-features) · [Upgrading](#upgrading-from-2x) · [Troubleshooting](#troubleshooting)

## Screenshots

The 3.0 beta in dark mode, shown in Korean. Click an image to view it at full size.

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Devices</strong><br>
      <a href="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-devices.png">
        <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-devices.png" alt="Device list and Apple Home and Matter connection readiness" width="100%">
      </a>
    </td>
    <td width="50%" valign="top">
      <strong>Connections</strong><br>
      <a href="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-connections.png">
        <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-connections.png" alt="Account, home and room selection, and Matter connection settings" width="100%">
      </a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Power</strong><br>
      <a href="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-power.png">
        <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-power.png" alt="Device power and standby power inputs" width="100%">
      </a>
    </td>
    <td width="50%" valign="top">
      <strong>Help</strong><br>
      <a href="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-help.png">
        <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/codex/hejhome-3.0.0-beta/docs/images/v3-beta-help.png" alt="Connection status, diagnostics, and beta guidance" width="100%">
      </a>
    </td>
  </tr>
</table>

## Features

- **Connect only the devices you need** — Choose homes, rooms and a connection method for each device.
- **Manage settings in one place** — Devices, Connections, Power and Help pages support Korean and English, light and dark themes, and mobile screens.
- **Discover new devices automatically** — State notifications and periodic inventory checks detect added devices.
- **Keep unsaved edits** — Navigation and state updates preserve settings you are editing.
- **Understand device status** — Reported values, connection preparation and command delivery results are shown separately.

## Getting started

### 1. Check the requirements

| Component | Requirements for the 3.0 beta |
| --- | --- |
| Homebridge | Version 2.4 or later within the 2.x series |
| Homebridge UI | Version 5.29 or later |
| Node.js | 22.x from 22.13.0 onward, or 24.x or 26.x |
| Hejhome account | Email sign-in and devices registered in the app |
| Network | Access to the Hejhome cloud; working IPv6 and mDNS on the local network for Matter |

You do not need a beta version of Homebridge or an alpha version of Homebridge UI.

Remote, air-conditioner and air-purifier controls on the plugin settings page require **the Homebridge server to run on macOS or Linux**. These controls are unavailable on Windows servers. This restriction does not depend on the device running your browser and is separate from settings editing and the Apple Home/Matter control paths.

### 2. Install the plugin

Find `@chazepps/homebridge-hejhome` in the **Plugins** section of Homebridge UI. If using the command line, run commands in the environment where Homebridge is installed.

| Choice | Channel | Version | How to install |
| --- | --- | --- | --- |
| Stable v2 | `latest` | `2.1.1` | Normal installation or update, or `@latest` |
| Beta v3 | `beta` | `3.0.0-beta.1` | Select the beta in the version picker, or use `@beta` |

Open **Install Previous Version** (or Install Alternate Version, depending on the UI) from the installed plugin's menu to choose a version. Version 3 requires Homebridge 2.4 or later. Each installation runs one selected version.

```sh
# Install the published stable version
npm install -g @chazepps/homebridge-hejhome@latest
```

**To explicitly select the v3 beta, use:**

```sh
npm install -g @chazepps/homebridge-hejhome@3.0.0-beta.1
```

`@beta` installs the version on the beta channel. Specify the exact version as above to stay on a particular beta. Check the current channel versions with:

```sh
npm view @chazepps/homebridge-hejhome dist-tags
npm install -g @chazepps/homebridge-hejhome@beta
```

<details>
<summary>Build and test a package from source</summary>

Back up your test Homebridge configuration, then run these commands from a checkout containing the 3.0 beta source.

```sh
nvm use
npm ci
npx playwright install chromium
npm run verify
npm pack --ignore-scripts
```

Transfer the generated package to the Homebridge installation environment and install it.

```sh
npm install -g ./chazepps-homebridge-hejhome-3.0.0-beta.1.tgz
```

Restart Homebridge or the relevant child bridge, then reopen the plugin settings. This installs a local package without publishing it to npm.

</details>

### 3. Sign in and select devices

1. Open the Hejhome plugin settings.
2. Request a verification code for your Hejhome account email and verify it.
3. Sign in with your password. Passwords and verification codes are not stored.
4. Select spaces under **Connections → Homes and rooms**. The default is all rooms in the first home.
5. Select **Save homes and rooms** and follow the restart instructions.

Each Homebridge storage directory supports **one Hejhome account**. You can select multiple homes and rooms within that account, but simultaneous connections to multiple accounts are not supported yet. Signing in with a different account replaces the existing session.

If editing `config.json` directly, the minimum configuration is shown below. Complete sign-in separately in the settings UI.

```json
{
  "platform": "Hejhome",
  "name": "Hejhome"
}
```

## Settings

| Page | What you can do |
| --- | --- |
| **Devices** | Search by name, type or model; set display names and connection methods; use supported controls |
| **Connections** | Check account status, sign in again, select homes and rooms, configure Matter and Adaptive Lighting |
| **Power** | Enter active and standby wattage; configure advanced profiles for actual power measurements |
| **Help** | Check connection status, view diagnostics without personal information, read beta guidance and model support details |

Save changes using the button in each section. Settings that require a restart are identified on screen. **“Prepared” means Homebridge has prepared a connection; it does not confirm that Apple Home pairing is complete.**

### Connect to other smart-home apps

Matter is off by default. Enable **Connections → Matter connection**, then enable Matter for the relevant bridge in Homebridge. Use that bridge's Matter QR code in the app you want to connect. Adding the same device through both Apple Home and Matter to the same app may create duplicates.

Matter still requires the Hejhome cloud. It does not add local communication or Thread support to your devices. Homebridge's Matter support is a community implementation, not a certified commercial Matter product.

### Discover new devices

A state notification from a new device triggers a server inventory check. Only **supported devices belonging to the current account and selected homes and rooms** are added, subject to their display settings.

Subsequent notification-triggered scans run at least 30 seconds apart. Notifications for an ID not found during a scan do not trigger repeated scans for five minutes. Inventory is also checked every five minutes by default, even without notifications. Failed lookups retain existing devices and are retried, so discovery may take longer when the network is unavailable. Discovery does not add support for an unsupported model's features.

### Adjust lighting color automatically

For supported color-temperature lights, enable **Connections → Adaptive lighting** and select Adaptive Lighting in Apple Home as well. Color temperature changes with the time of day, using periodic cloud commands. This option is off by default.

### Power and energy

On the **Power** page, enter each device's active and standby power in **W (watts)**. A blank field means unset; `0` is saved as 0 W.

For supported single-load devices, the plugin combines these specifications with confirmed power state to estimate power and cumulative energy for Matter. These are estimates, not measurements. Unknown states, disconnected periods and restart gaps are excluded. A configured power or energy measurement profile takes priority over estimates. To apply changes, enable Matter in both the plugin and the relevant bridge, save, and restart Homebridge.

Homebridge's Matter outlet tiles can display W. Lights retain their original device type, so their tiles may not show W. Energy display in Apple Home depends on operating-system and controller support. See the [power specification guide](docs/product-specs/3.0-beta-guide.md#소비전력-사양) and [measurement configuration guide](docs/product-specs/3.0-beta-guide.md#전력-측정), currently available in Korean.

## Supported devices and features

Support depends on the model and the values it reports. This table describes the implementation; it does not mean every model has been tested on physical hardware.

| Device family | Features and limitations |
| --- | --- |
| RGB/RGBW lights and LED strips | Power, brightness and color; Matter brightness control on supported devices |
| Color-temperature lights | Power, brightness and color temperature; Apple Home Adaptive Lighting |
| Wall switches and relays | Power and individual control of multiple switches |
| Plugs and power strips | Power and individual outlet control; power measurements on models with configured conversion profiles |
| Curtains and blinds | Position reporting and target-position control; stop and tilt control are not supported |
| Motion, contact, leak and smoke sensors | Detection and alarm states reported by the device |
| Temperature and humidity sensors | Temperature and humidity |
| Air purifiers | Power control for the supported `Airpurifier` type; mode changes in the settings UI; PM2.5 readings when a verified conversion multiplier is configured |
| Supported door locks | Door-open state only for `ZigbeeDoorlock`; no lock-state reporting or lock/unlock controls |

Battery status is shown when supplied by the device. See the [device support registry](src/devices/capabilities.ts) and the [beta guide (Korean)](docs/product-specs/3.0-beta-guide.md) for device types and detailed capabilities.

### Infrared remote devices

| Device family | Features |
| --- | --- |
| TVs and set-top boxes | Power control or a momentary power button; volume, channel and mute controls in settings; six optional Apple Home remote buttons |
| Fans | Fan power control when a power state is reported, otherwise a momentary power button; two optional speed-cycle and oscillation buttons; no Matter connection |
| Air conditioners | Power control; view and change reported target temperature, operating mode and fan speed in settings |
| Other supported devices | Verified power commands only |

Except for air conditioners, supported infrared devices without a reported power state appear in Apple Home as a **momentary power button**. A reported power value is not independent confirmation of the physical device's state. Matter on/off control is limited to supported devices that provide a power state.

Additional remote buttons are off by default. Enable **Show remote buttons in Apple Home** for a device, save and restart to add them to the existing accessory. Each button sends one command and returns to off. These buttons do not report actual mute, fan-speed or oscillation state. Channel-number entry is available in the settings UI.

Apple Home and Matter thermostat interfaces are not provided because actual air-conditioner operating state cannot be confirmed. You can link a separate Hejhome thermometer to show the measured current temperature in the settings UI.

### Features not yet available

Smart-button click automations, continuous radar occupancy detection, curtain stop/tilt, uncalibrated air-quality and filter features, RGBW color-temperature extensions and scenes, camera video/recording (HKSV), and door locking/unlocking are not available. Unconfirmed features and readings are not fabricated.

Integration with Homebridge UI 6 alpha automations is a separate test area. Read the [automation guide (Korean)](docs/product-specs/smart-automation-guide.md) before using it.

## Upgrading from 2.x

Back up your configuration and review these changes.

| Change | What to check |
| --- | --- |
| Runtime requirements | Version 3.0 requires Homebridge 2.4 or later. On Homebridge 1, use a compatible plugin version from the 2.0 or 2.1 series. |
| Air conditioners and smart buttons | Services previously exposing unconfirmed operating states or click events are removed. Review existing automations. |
| Connection method and display type | Existing device identifiers are retained, but available services may change and require updates in your app or automations. |

Do not start troubleshooting by resetting existing pairings or accessory data. Read the [beta migration notes (Korean)](docs/product-specs/3.0-beta-guide.md#이전-버전과-달라지는-표시), then check your main devices and automations.

### Return to a stable version

Turn off the new connection options and follow the [rollback steps (Korean)](docs/product-specs/3.0-beta-guide.md#정식-버전으로-돌아가기). Before returning to the 2.0 or 2.1 series, save a copy of your configuration and remove the Hejhome `features` section. `@latest` installs whichever version is currently stable; specify a version number to return to a particular release.

## Troubleshooting

Start with **Help → Connection status**.

| Symptom | What to check |
| --- | --- |
| Device state changes, but controls fail | Check whether sign-in has expired and sign in again. Receiving state and authenticating control requests are separate. |
| A new device does not appear | Allow automatic discovery to run, then check the selected homes and rooms, hidden-device settings and supported models. |
| The same device appears twice | Check whether it was added to the same app through both Apple Home and Matter. |
| Sensor values are missing | Check for a recent measurement report and its validity period. PM2.5 also requires a multiplier based on verified units. |
| A command response is delayed | Check the physical device before trying again. No response does not necessarily mean the command was not executed. |
| Home/room settings conflict | Select **Use latest settings**, review the saved choices, and make your changes again. |
| Device settings cannot be saved after disabling measurements | If an existing validity period is shown, select **Clear validity time**, then save. |

**“Command sent” means the server acknowledged the request.** Confirm physical operation through a subsequent device report or by checking the device itself.

If the problem persists, [report an issue](https://github.com/chazepps/homebridge-hejhome/issues) with diagnostics without personal information, installed versions, the model, reproduction steps and the time of the problem. Do not share passwords, verification codes, tokens or cookies.

## Privacy and verification

Sign-in sessions are stored on Homebridge separately from `config.json`. Passwords and verification codes are not stored, and diagnostics are not sent to the developer automatically.

Automated tests cover device connections and reconnections, settings saves, command ordering, missing values, account changes and UI behavior. Automated checks and physical-device validation are tracked separately. Remaining checks are recorded in the [feature checklist (Korean)](docs/exec-plans/2026-09-30-homebridge-feature-action-checklist.md).

## Development and contributions

Use the Node.js version specified in `.nvmrc`.

```sh
nvm use
npm ci
npm run build
npm run homebridge:dev
```

| Task | Command |
| --- | --- |
| Run the development Homebridge UI | `npm run homebridge:ui` |
| Build only the settings UI | `npm run build:ui` |
| Preview with simulated devices | `npm run preview:ui` — after building, open `http://127.0.0.1:4173` |
| Install the browser for initial test setup | `npx playwright install chromium` |
| Run code, UI and documentation checks | `npm run verify` |
| Inspect package contents | `npm pack --dry-run` |

Development settings are in `test/hbConfig/config.json`. The UI preview uses simulated responses and does not control real devices.

Edit the React and Radix UI code in `homebridge-ui/src/`. Do not edit `homebridge-ui/public/index.html` directly; it is generated by the build. `npm run build` includes the UI build.

When adding device support, verify the actual reported values and command meanings, and add relevant tests. See the [architecture](ARCHITECTURE.md), [documentation index](docs/README.md) and [security notes](docs/SECURITY.md) for more information.

## License

Released under the [ISC license](LICENSE).
