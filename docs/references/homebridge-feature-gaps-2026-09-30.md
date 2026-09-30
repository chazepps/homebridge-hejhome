# Homebridge feature gap inventory — 2026-09-30

## Scope and evidence

Compared local implementation commit `edbf64a` (2.1.0-beta.0) with official Homebridge/HAP/Matter/UI APIs and upstream source. npm registry tags checked in this investigation: Homebridge latest 2.4.0, beta 2.4.1-beta.11; UI latest 5.29.0, beta 5.29.1-beta.3, alpha 6.0.1-alpha.20.

This is a capability inventory, not a promise that each Hejhome model supplies every required command. Recent Homebridge additions are distinguished from older host APIs the plugin has not used. No code, deployment, live device state or npm channels were changed for this investigation.

## Existing baseline

The beta already has optional Matter publication for core device families, per-model calibrated electrical measurements, white-light Adaptive Lighting, HAP/Matter command-state sharing, restored Matter handler attachment, explicit beta release policy and Node 22/24/26 checks. These are not new backlog items.

## Work that can start using existing integration surfaces

| ID | Missing feature | Current source evidence | Proposed implementation and validation | Priority |
| --- | --- | --- | --- | --- |
| A1 | Reachability, freshness and truthful sensor errors | platform.ts logs transport state; HAP reads cached values/defaults; no last-seen policy or StatusFault/StatusActive. Matter uses the discovery online value. | Track REST auth, MQTT transport and individual sample age separately. Return HAP communication errors/appropriate sensor status and Matter reachable=false without inventing zero/normal readings. Test disconnect, stale reads and recovery. | P1 |
| A2 | Session recovery and reconciliation without restart | initialize checks accessToken, runs discovery once, then stops its session watcher. UI can replace the stored session independently. | Detect session-file replacement, reconnect clients and repeat scoped discovery. Resync after MQTT reconnect; preserve accessories when cloud discovery fails. Silent token renewal is conditional on a proven vendor refresh flow. | P1 |
| A3 | Matter relative dimming | matter/accessory.ts rejects LevelControl.step even though absolute brightness works. | Translate up/down step to a bounded absolute target using current state and the existing brightness command. Continuous move/stop needs a bounded scheduler and a cloud request budget; it is a separate task. | P2 |
| A4 | Live protocol diagnostics in custom UI | UI renders a saved device snapshot and feature flags; it does not use getCachedMatterAccessories or server push events. | Show Hejhome discovery, HAP registration and Matter registration separately, sample time, last control result and session state. Cache presence is not commissioning proof. Use plugin-ui-utils pushEvent and cached-accessory APIs. | P1 |
| A5 | Per-device protocol and presentation settings | scope selects homes/rooms; feature switches are platform-wide. No per-device visibility/role overrides. | Add stable device-ID overrides for HAP/Matter/both/hidden, display labels and supported service roles. Preview accessory removals and identity effects. Keep discovery separate from publication. | P2 |
| A6 | Real load status for metered outlets | platformAccessory.ts updateOutlet sets OutletInUse equal to On. | For calibrated models, derive load from measured power/current with threshold hysteresis. Preserve On as relay state and do not treat missing telemetry as no load. | P2 |
| A7 | Theme and language integration | Custom UI copy/styles are fixed; available userCurrentLightingMode/i18nCurrentLang APIs are unused. | Follow the host theme and localize Korean/English labels, validation and feature help. Validate both themes and narrow screens. | P3 |

A1/A2 are integration reliability improvements enabled by existing host APIs, not newly released Homebridge features.

## Device features: host supports them, vendor evidence still matters

| ID | Candidate | Confirmed plugin gap | Evidence required / implementation boundary | Priority |
| --- | --- | --- | --- | --- |
| B1 | Smart-button single/double/long press in HAP and Matter | configureSmartButton creates a service and validValues; updateDevice only updates battery for stateless-button. No ProgrammableSwitchEvent delivery. Matter skips the class. | Capture the button report field, gesture values and repeat behavior, then send HAP event notifications and api.matter.switch.emitGesture. Repeated identical gestures must not be deduplicated as state. Existing supported label overstates behavior. | P1 |
| B2 | Fan speed, oscillation and Matter fan | configureFan only connects Active. fanSpeed is received from MQTT but never exposed as RotationSpeed; Matter skips IR fan. | Validate discrete speed values and command keys, optional swing support and feedback limitations of IR. Expose only verified functions. Documentation currently implies more speed support than code implements. | P1 |
| B3 | Proper HVAC/HeaterCooler and Matter thermostat | HAP maps vendor temperature to both current and target and sends HomeKit mode numbers as strings. Matter skips IR HVAC. | Separate measured room temperature from remote setpoint, map vendor modes explicitly, declare cooling/heating capabilities, limits and fan support. Do not report setpoint as an actual sensor reading. | P1 |
| B4 | Radar presence semantics | SensorRadar is grouped with motion sensors in both mappings. | Confirm sustained presence versus motion-event semantics. Use HAP OccupancySensor and the appropriate Matter occupancy feature where supported; retain real absence/hold behavior. | P2 |
| B5 | Blind stop, tilt and movement diagnostics | Position targeting exists; Matter stop explicitly fails; no HAP HoldPosition or tilt mapping. | Prove stop command, tilt fields and position direction for each model. Only then expose HoldPosition/stopMotion/tilt; actual position must not be inferred from target. | P2 |
| B6 | Air-quality/air-purifier functions | pm25 exists in the state type; Airpurifier/IrAirpurifier are marked partial with no services. | Check PM2.5 units and actual reports first; add read-only AirQualitySensor/PM2_5Density and Matter concentration measurement. Fan modes/filter-life commands require separate evidence. | P2 |
| B7 | RGBW colour temperature, Adaptive Lighting and vendor scenes | RGBW currently offers HSV plus a white-mode switch; Adaptive Lighting only supports LightWw. scene_data is stored but not exposed. | Prove adjustable white temperature and model ranges before enabling Adaptive Lighting. Known vendor scene payloads could become explicit preset controls. Scene state alone does not prove a control payload. | P2 |
| B8 | TV/media remote controls | IR TV, speaker and set-top boxes are power switches only. | Map verified input, volume, mute and remote keys to Television/InputSource/TelevisionSpeaker or relevant Matter media device types. An IR power toggle is not reliable absolute on/off without feedback. | P3 |
| B9 | Camera preview/live stream, then HKSV | REST has camera list/WebRTC config/access-config methods; no CameraController or media transport exists. | Build authenticated signalling and WebRTC-to-HomeKit media pipeline; establish snapshot, codec, reconnect and concurrency behavior. HKSV additionally needs recording delegate, fragmented media/prebuffer and motion triggers; it is not obtained by enabling CameraController. | P3, large |
| B10 | Lock and alarm services | Doorlocks, sirens and alarm-like devices are partial/unsupported. | First establish actual lock/alarm state semantics and permitted control operations. Read-only state can precede LockMechanism/Matter DoorLock or alarm controls. | P3 |

## Newly emerging upstream feature: Smart Automation in UI 6 alpha

The exact v6.0.1-alpha.20 source defines five rule types:

- Smart light groups: aggregate existing on/off, dimmable, colour or temperature lights.
- Door ajar: a contact remains open for a configured duration; optional repeats.
- Humidity control: distinct on/off thresholds drive an existing compatible target.
- Average temperature: aggregate sensor readings and drop stale sources.
- Security system: contact/motion inputs with an arming/bypass model.

The implementation currently discovers and monitors HAP services using HapClient. Therefore our existing HAP sensor/light outputs are the natural integration surface; Matter-only operation must not be assumed compatible. The plugin does not need to duplicate this rules engine. A dedicated UI-alpha compatibility test and usage recipes would be useful after A1/B1/B3. The UI alpha is explicitly not recommended for production; it is separate from the Hejhome plugin beta.

## Features not to confuse with missing plugin code

- Core/UI package updates, bulk updates, IPv6 advertiser options and bridge pairing UI largely belong to the host. Maintain compatibility, rather than reimplementing them in Hejhome.
- Matter multi-admin and HAP/Matter bridge coexistence are host capabilities. Per-device exposure and clear diagnostics are the remaining plugin work.
- Thread radio, native local Hejhome control and vendor-provided firmware updates do not follow from adding Matter to this cloud plugin.
- Historical charts or Eve-specific history would require explicit storage/protocol design or additional ecosystem libraries. Neither the current measurement clusters nor this investigation establishes a generic built-in Homebridge history feature.
- Robot-vacuum/water-valve/pump APIs exist upstream, but the current Hejhome registry contains no established corresponding integration. They are not ready backlog commitments.

## Suggested implementation order

1. Correct advertised capability gaps: button events, fan speed and HVAC semantics (B1–B3), starting with redacted device evidence.
2. Ship shared health/recovery and live diagnostics (A1, A2, A4), so automation does not consume stale normal-looking readings.
3. Add relative dimming, calibrated load indication, device-level settings and confirmed radar/air-quality mappings (A3, A5, A6, B4, B6).
4. Test UI 6 Smart Automation separately. Treat camera/HKSV and locks as dedicated later projects.

## Primary references

- [Homebridge changelog](https://github.com/homebridge/homebridge/blob/latest/CHANGELOG.md)
- [HAP services](https://developers.homebridge.io/HAP-NodeJS/classes/Service.html)
- [HAP characteristics](https://developers.homebridge.io/HAP-NodeJS/classes/Characteristic.html)
- [Matter API](https://github.com/homebridge-plugins/homebridge-matter/wiki/API-Reference)
- [Matter switches](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-6-Switches)
- [Matter lighting](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-4-Lighting)
- [Matter HVAC](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-9-HVAC)
- [Matter sensors](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-7-Sensors)
- [Matter closure devices](https://github.com/homebridge-plugins/homebridge-matter/wiki/Section-8-Closure)
- [Custom UI API](https://github.com/homebridge/plugin-ui-utils)
- [Smart Automation rule interfaces at alpha.20](https://github.com/homebridge/homebridge-config-ui-x/blob/v6.0.1-alpha.20/src/smart-automation/smart-automation.interfaces.ts)
- [Smart Automation HAP controller at alpha.20](https://github.com/homebridge/homebridge-config-ui-x/blob/v6.0.1-alpha.20/src/smart-automation/smart-automation-accessory.controller.ts)
- [UI alpha release status](https://github.com/homebridge/homebridge-config-ui-x/releases/tag/v6.0.1-alpha.20)
- [Camera controller](https://developers.homebridge.io/HAP-NodeJS/classes/CameraController.html)
- [Camera recording options](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraRecordingOptions.html)

## Validation

Read-only source/API comparison, exact npm dist-tag checks, upstream tagged-source inspection and repository documentation checks. No physical-device capability was inferred from API availability alone. No runtime source changes.
