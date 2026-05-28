# Hejhome Web API Notes

> Status: redacted API analysis for the Homebridge plugin

This directory records the Hejhome Web API behavior used by the plugin. It intentionally contains endpoint families, field names, payload meaning, and HomeKit mapping decisions only.

## Confidentiality Rule

- Do not include copied UI source, component names, local analysis paths, or generated bundle details.
- Do not include raw account identifiers, passwords, cookies, session ids, access tokens, or authorization header values.
- Do not include packet dumps. Summarize request order and field purpose instead.

## Authenticated REST Surface

| Purpose | Method | Endpoint Pattern | Notes |
| --- | --- | --- | --- |
| User profile | GET | `dashboard/config/user` | Used to confirm account identity and camera access metadata. |
| Home list | GET | `dashboard/family` | Returns homes with numeric `familyId` and display name. |
| Room list | GET | `dashboard/rooms/{familyId}` | Returns rooms for a home. |
| Device state | GET | `dashboard/{familyId}/devices-state?scope=shop` | Returns all devices for a home. |
| Room device state | GET | `dashboard/{familyId}/room/{roomId}/devices-state?scope=shop` | Returns devices scoped to one room. |
| Device command | POST | `dashboard/control/{deviceId}` | Body contains `requirments`, matching the web API spelling. |
| Camera list | GET | `dashboard/devices/camera` | Returns camera devices separately from normal device state discovery. |
| Camera WebRTC config | GET | `dashboard/webrtc/configs/{deviceId}` | Returns ICE/auth/signaling metadata for a camera. |
| Camera access config | POST | `dashboard/webrtc/access-config` | Creates short-lived MQTT/WebRTC signaling access data. |

## Control Payloads

| Device Family | Request Fields | HomeKit Mapping |
| --- | --- | --- |
| RGB/RGBW/LED light | `power`, `brightness`, `lightMode`, `hsvColor` | `Lightbulb` with on/off, brightness, hue, saturation. |
| White light | `power`, `brightness`, `temperature` | `Lightbulb` with on/off, brightness, color temperature. |
| Switch | `power1` through `power6` | One `Switch` service per gang. |
| Relay | `power` or `power1` | Single `Switch` service. |
| Plug | `power` plus power meter fields | `Outlet` service. Meter fields are read-only diagnostics for now. |
| Power strip | `power1` through socket fields, optional all-off field | One outlet-like service per controllable socket. |
| Curtain/Blind | `control`, `percentControl` | `WindowCovering` target position and current position. |
| IR air conditioner | `power`, `temperature`, `mode`, `fanSpeed` | Partial `Thermostat` support. Complex remote keys are deferred. |
| IR fan | `power`, `fanSpeed`, `swing` | Partial fan support. |
| IR TV/projector/etc. | `power` and remote key fields | Only clear power-like commands are considered safe for v1. |

## Realtime Status Mapping

Realtime updates arrive as status entries with a device id and code/value pairs. The plugin normalizes those codes before updating HomeKit.

| Realtime Code | Normalized State |
| --- | --- |
| `switch_led`, `switch_power` | `power` |
| `switch_1` through `switch_6` | `power1` through `power6` |
| `switch_usb1` | `power4` for power-strip USB control |
| `bright_value` | `brightness` percent |
| `work_mode` | `lightMode` |
| `colour_data` | `hsvColor` |
| `temp_value` | light color-temperature percent |
| `percent_state` | `percentState` |
| `percent_control` | `percentControl` |
| `control` | open/close command state |
| `pir` | `motionDetected` |
| `prm_switch`, `switch` | contact state where the device is a contact sensor |
| `va_temperature`, `prm_temperature` | `temperature` |
| `va_humidity`, `prm_content` | `humidity` |
| `battery` | `battery` |
| `cur_power`, `cur_current`, `cur_voltage` | plug meter diagnostics |
| `alarm_switch`, `alarm_state` | alarm-like sensor state |

## Camera Notes

Camera devices use a separate discovery endpoint and WebRTC signaling flow. The signaling flow is MQTT over WebSocket and exchanges offer, answer, candidate, and disconnect messages for an IPC topic.

HomeKit camera streaming is not implemented in this phase. The plugin records the endpoint and signaling contract so the next phase can design a proper Homebridge `CameraController` bridge, media relay, and FFmpeg or WebRTC-to-RTP pipeline without mixing camera risk into the general device rollout.

## Home And Room Selection

The first-login default is the first home with all of its rooms. Users can later change this in the Homebridge settings UI.

The runtime discovery filter supports:

- first home only
- all homes
- explicit homes and room ids

Changing this setting affects which devices are discovered and which stale accessories are removed on the next Homebridge restart or rediscovery.
