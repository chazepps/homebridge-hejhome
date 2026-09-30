import type { MatterAPI, MatterAccessory } from 'homebridge';
import { getDeviceCapability } from '../devices/capabilities.js';
import type { MeterProfile } from '../features.js';
import type { HejDevice } from '../types.js';
import { meterClusters } from './metering.js';

type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];
type Send = (requirements: Record<string, unknown>) => Promise<void>;
type Handlers = NonNullable<MatterAccessory['handlers']>;

export function createMatterAccessory(
  api: MatterAPI, current: () => HejDevice, send: Send, meters: MeterProfile[],
): MatterAccessory | null {
  const device = current();
  const kind = getDeviceCapability(device.deviceType)?.serviceKind;
  const types = api.deviceTypes;
  const state = device.deviceState ?? {};
  const accessory: MatterAccessory = {
    UUID: api.uuid.generate(`hejhome:matter:${device.id}`), displayName: device.name,
    serialNumber: device.id, manufacturer: 'Hejhome', model: device.modelName ?? device.deviceType,
    context: { deviceId: device.id }, deviceType: types.BridgedNode,
    clusters: { bridgedDeviceBasicInformation: { reachable: device.online !== false } },
  };
  const clusters = accessory.clusters!;
  const handlers: Handlers = {};
  const actuate = async (requirements: Record<string, unknown>) => {
    if (current().online === false) {
      throw new api.status.Failure('Hejhome device is offline.');
    }
    await send(requirements);
  };
  const power = (key: string): NonNullable<Handlers['onOff']> => ({
    on: () => actuate({ [key]: true }), off: () => actuate({ [key]: false }),
    toggle: () => actuate({ [key]: !current().deviceState?.[key] }),
  });
  const powerPart = (key: string, outlet: boolean): MatterAccessoryPart => ({
    id: key, displayName: `${device.name} ${key}`, deviceType: outlet ? types.OnOffOutlet : types.OnOffLight,
    clusters: { onOff: { onOff: state[key] === true } }, handlers: { onOff: power(key) },
  });
  switch (kind) {
    case 'relay-switch':
    case 'ir-switch':
    case 'outlet': {
      const key = state.power !== undefined || kind !== 'relay-switch' ? 'power' : 'power1';
      accessory.deviceType = kind === 'outlet' ? types.OnOffOutlet : types.OnOffLight;
      clusters.onOff = { onOff: state[key] === true };
      handlers.onOff = power(key);
      break;
    }
    case 'multi-switch':
    case 'power-strip': {
      const keys = kind === 'multi-switch'
        ? Array.from({ length: Number(/Switch(\d+)/.exec(device.deviceType)?.[1] ?? 1) }, (_, i) => `power${i + 1}`)
        : Array.from({ length: Math.max(4, ...Object.keys(state).map((k) => Number(/^power(\d+)$/.exec(k)?.[1] ?? 0))) },
          (_, i) => `power${i + 1}`).filter((k) => k !== 'power5');
      accessory.parts = keys.map((key) => powerPart(key, kind === 'power-strip'));
      break;
    }
    case 'white-light':
    case 'color-light': {
      accessory.deviceType = kind === 'white-light' ? types.ColorTemperatureLight : types.ExtendedColorLight;
      clusters.onOff = { onOff: state.power === true };
      const hsv = color(current());
      clusters.levelControl = { currentLevel: Math.max(1, Math.round(hsv.brightness * 254 / 100)) };
      handlers.onOff = power('power');
      const level = async (value: number, withOnOff: boolean) => {
        const brightness = bounded(value, 0, 254) * 100 / 254;
        const requirements = kind === 'color-light' && current().deviceState?.lightMode === 'COLOR'
          ? { hsvColor: { ...color(current()), brightness: Math.round(brightness) } }
          : { brightness: Math.round(brightness) };
        await actuate(withOnOff ? { ...requirements, power: value > 0 } : requirements);
      };
      handlers.levelControl = {
        moveToLevel: ({ level: value }) => level(value, false),
        moveToLevelWithOnOff: ({ level: value }) => level(value, true),
        // No native continuous transitions are evidenced by the cloud API.
        move: () => {
          throw new api.status.Failure('Continuous dimming is not supported.');
        },
        step: () => {
          throw new api.status.Failure('Relative dimming is not supported.');
        },
        stop: async () => {},
      };
      if (kind === 'white-light') {
        clusters.colorControl = {
          colorTemperatureMireds: toMired(number(state.temperature, 100)!), colorMode: 2,
          colorTempPhysicalMinMireds: 154, colorTempPhysicalMaxMireds: 333, coupleColorTempToLevelMinMireds: 154,
        };
        handlers.colorControl = { moveToColorTemperatureLogic: ({ colorTemperatureMireds }) => actuate({
          temperature: Math.round(Math.max(0, Math.min(100, (1_000_000 / bounded(colorTemperatureMireds, 154, 333) - 3000) / 35))),
        }) };
      } else {
        clusters.colorControl = { currentHue: Math.round(hsv.hue * 254 / 360),
          currentSaturation: Math.round(hsv.saturation * 254 / 100), colorMode: 0 };
        const setColor = async (partial: Partial<typeof hsv>) => {
          const next = { ...color(current()), ...partial };
          if (current().deviceState?.lightMode !== 'COLOR') {
            await actuate({ lightMode: 'colour' });
          }
          await actuate({ hsvColor: next });
        };
        handlers.colorControl = {
          moveToHueAndSaturationLogic: ({ hue, saturation }) => setColor({
            hue: Math.round(bounded(hue, 0, 254) * 360 / 254), saturation: Math.round(bounded(saturation, 0, 254) * 100 / 254),
          }),
          moveToHueLogic: ({ targetHue, isEnhancedHue }) => setColor({
            hue: Math.round(bounded(targetHue, 0, isEnhancedHue ? 65535 : 254) * 360 / (isEnhancedHue ? 65535 : 254)),
          }),
          moveToSaturationLogic: ({ targetSaturation }) => setColor({ saturation: Math.round(bounded(targetSaturation, 0, 254) * 100 / 254) }),
        };
      }
      break;
    }
    case 'window-covering':
      accessory.deviceType = types.WindowCovering;
      clusters.windowCovering = {
        type: 0, endProductType: 0, configStatus: { operational: true, onlineReserved: true, liftPositionAware: true },
        currentPositionLiftPercent100ths: closedPercent(state.percentState),
        targetPositionLiftPercent100ths: closedPercent(state.percentControl ?? state.percentState),
      };
      handlers.windowCovering = {
        upOrOpen: () => actuate({ percentControl: 100 }), downOrClose: () => actuate({ percentControl: 0 }),
        goToLiftPercentage: ({ liftPercent100thsValue }) => actuate({ percentControl: Math.round(100 - bounded(liftPercent100thsValue, 0, 10000) / 100) }),
        stopMotion: () => {
          throw new api.status.Failure('Stop command has not been verified for this model.');
        },
      };
      break;
    case 'temperature-humidity-sensor':
      accessory.parts = [
        { id: 'temperature', deviceType: types.TemperatureSensor, clusters: {
          temperatureMeasurement: { measuredValue: measurement(state.temperature, -273.15, 327.67) },
        } },
        { id: 'humidity', deviceType: types.HumiditySensor, clusters: {
          relativeHumidityMeasurement: { measuredValue: measurement(state.humidity, 0, 100) },
        } },
      ];
      break;
    case 'motion-sensor':
      accessory.deviceType = types.MotionSensor;
      clusters.occupancySensing = { occupancy: { occupied: state.motionDetected === true } };
      if (typeof state.motionDetected !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    case 'contact-sensor':
      accessory.deviceType = types.ContactSensor;
      clusters.booleanState = { stateValue: !(state.doorOpened === true || String(state.state).toUpperCase() === 'OPEN') };
      if (state.doorOpened === undefined && state.state === undefined) {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    case 'leak-sensor':
      accessory.deviceType = types.LeakSensor;
      clusters.booleanState = { stateValue: state.alarm === true };
      if (state.alarm === undefined) {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    case 'smoke-sensor':
      accessory.deviceType = types.SmokeSensor;
      clusters.smokeCoAlarm = { smokeState: state.alarm ? 2 : 0, expressedState: state.alarm ? 1 : 0 };
      if (state.alarm === undefined) {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    default:
      // IR HVAC, buttons, cameras and locks need additional command/event evidence.
      return null;
  }
  if (state.battery !== undefined) {
    const battery = number(state.battery);
    clusters.powerSource = { status: 1, order: 0, description: 'Battery',
      batPercentRemaining: battery === null ? null : Math.round(Math.max(0, Math.min(100, battery)) * 2) };
  }
  if (kind === 'outlet' || kind === 'power-strip') {
    Object.assign(clusters, meterClusters(device, meters));
  }
  accessory.handlers = handlers;
  return accessory;
}

function number(value: unknown, fallback: number | null = null): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error('Invalid Matter command value.');
  }
  return value;
}
function measurement(value: unknown, min: number, max: number): number | null {
  const parsed = number(value);
  return parsed === null || parsed < min || parsed > max ? null : Math.round(parsed * 100);
}
function closedPercent(value: unknown): number | null {
  const parsed = number(value);
  return parsed === null ? null : Math.round((100 - Math.max(0, Math.min(100, parsed))) * 100);
}
function toMired(percent: number): number {
  return Math.round(1_000_000 / (3000 + Math.max(0, Math.min(100, percent)) * 35));
}
function color(device: HejDevice) {
  const state = device.deviceState ?? {};
  return { hue: number(state.hsvColor?.hue, 0)!, saturation: state.lightMode === 'WHITE' ? 0 : number(state.hsvColor?.saturation, 0)!,
    brightness: number(state.lightMode === 'COLOR' ? state.hsvColor?.brightness ?? state.brightness : state.brightness, 100)! };
}
