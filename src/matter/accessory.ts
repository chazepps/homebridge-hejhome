import type { MatterAPI, MatterAccessory } from 'homebridge';
import { getDeviceCapability } from '../devices/capabilities.js';
import { isMomentaryPowerDevice, readVendorPower } from '../devices/power.js';
import { decodeAirPurifierPower } from '../devices/purifier.js';
import { calibratePm25 } from '../devices/airQuality.js';
import { whiteMiredToTemperaturePercent, whiteTemperaturePercentToMired } from '../lighting/temperature.js';
import type { MeterProfile } from '../features.js';
import type { HejDevice } from '../types.js';
import { meterClusters } from './metering.js';

type MatterAccessoryPart = NonNullable<MatterAccessory['parts']>[number];
type Send = (requirements: Record<string, unknown>) => Promise<void>;
type Handlers = NonNullable<MatterAccessory['handlers']>;

// Cloud control has no proven native transition. Bound the software approximation
// to one request per second, 20 requests and 20 seconds per move.
export class MatterDimmingController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private serial: Promise<void> = Promise.resolve();
  private virtualLevel: number | null = null;
  private readonly requestTimes: number[] = [];
  private recentTargets: Array<{ value: number; at: number }> = [];

  constructor(private readonly onError: (error: unknown) => void = () => {}) {}

  cancel(clearTargets = false): void {
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.virtualLevel = null;
    if (clearTargets) {
      this.recentTargets = [];
    }
  }

  expectsBrightness(value: unknown): boolean {
    const reported = number(value);
    this.pruneTargets();
    return reported !== null && this.recentTargets.some((target) => reported === target.value);
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.serial.catch(() => undefined);
  }

  async step(mode: number, size: number, transitionTime: number | null,
    read: () => number | null, write: (level: number) => Promise<void>): Promise<void> {
    await this.stop();
    validateMode(mode);
    bounded(size, 1, 254);
    if (transitionTime !== null && transitionTime !== undefined && transitionTime !== 0) {
      throw new Error('Timed relative dimming is not supported.');
    }
    return this.enqueue(async () => {
      const currentLevel = read();
      if (currentLevel === null) {
        throw new Error('Current brightness is unknown.');
      }
      const target = Math.max(1, Math.min(254, currentLevel + (mode === 0 ? size : -size)));
      await write(target);
    });
  }

  async move(mode: number, rate: number | null, read: () => number | null,
    write: (level: number) => Promise<void>): Promise<void> {
    await this.stop();
    validateMode(mode);
    if (rate === null || rate === undefined) {
      throw new Error('Move rate is required when no default rate is configured.');
    }
    bounded(rate, 1, 254);
    const start = read();
    if (start === null) {
      throw new Error('Current brightness is unknown.');
    }
    this.virtualLevel = start;
    const generation = this.generation;
    const startedAt = Date.now();
    let requests = 0;
    const tick = async () => {
      if (generation !== this.generation || requests >= 20 || Date.now() - startedAt >= 20_000) {
        return;
      }
      await this.enqueue(async () => {
        if (generation !== this.generation) {
          return;
        }
        const level = this.virtualLevel;
        if (level === null) {
          throw new Error('Current brightness is unknown.');
        }
        const target = Math.max(1, Math.min(254, level + (mode === 0 ? rate : -rate)));
        if (target === level) {
          this.cancel();
          return;
        }
        this.reserveRequest();
        this.pruneTargets();
        const planned = { value: vendorLevel(target), at: Date.now() };
        this.recentTargets.push(planned);
        if (this.recentTargets.length > 3) {
          this.recentTargets.shift();
        }
        try {
          await write(target);
        } catch (error) {
          this.recentTargets = this.recentTargets.filter((entry) => entry !== planned);
          throw error;
        }
        if (generation === this.generation) {
          this.virtualLevel = target;
          requests++;
        }
      });
      if (generation === this.generation && requests < 20 && Date.now() - startedAt < 20_000) {
        this.timer = setTimeout(() => {
          void tick().catch((error) => {
            this.cancel(true);
            this.onError(error);
          });
        }, 1000);
        this.timer.unref?.();
      }
    };
    await tick();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.serial.catch(() => undefined).then(task);
    this.serial = next;
    return next;
  }

  private reserveRequest(): void {
    const now = Date.now();
    while (this.requestTimes.length > 0 && now - this.requestTimes[0]! >= 20_000) {
      this.requestTimes.shift();
    }
    const last = this.requestTimes.at(-1);
    if ((last !== undefined && now - last < 1000) || this.requestTimes.length >= 20) {
      throw new Error('Continuous dimming request budget exceeded.');
    }
    // Count an attempted cloud request even when the vendor later rejects it.
    this.requestTimes.push(now);
  }

  private pruneTargets(): void {
    const now = Date.now();
    this.recentTargets = this.recentTargets.filter((target) => now - target.at <= 2000);
  }
}

function validateMode(mode: number): void {
  if (mode !== 0 && mode !== 1) {
    throw new Error('Invalid dimming direction.');
  }
}
function vendorLevel(level: number): number {
  return Math.max(1, Math.round(level * 100 / 254));
}

export function createMatterAccessory(
  api: MatterAPI, current: () => HejDevice, send: Send, meters: MeterProfile[],
  dimmer = new MatterDimmingController(),
  pm25Multiplier?: number,
): MatterAccessory | null {
  const device = current();
  const kind = getDeviceCapability(device.deviceType)?.serviceKind;
  if (kind === 'ir-switch' && (isMomentaryPowerDevice(device) || readVendorPower(device) === undefined)) {
    return null;
  }
  const types = api.deviceTypes;
  const state = device.deviceState ?? {};
  const label = matterLabel(device.name);
  const accessory: MatterAccessory = {
    UUID: api.uuid.generate(`hejhome:matter:${device.id}`), displayName: label,
    serialNumber: device.id, manufacturer: 'Hejhome', model: device.modelName ?? device.deviceType,
    context: { deviceId: device.id }, deviceType: types.BridgedNode,
    clusters: { bridgedDeviceBasicInformation: { reachable: device.online !== false } },
  };
  const clusters = accessory.clusters!;
  const handlers: Handlers = {};
  const actuate = async (requirements: Record<string, unknown>) => {
    if (kind === 'ir-switch' && readVendorPower(current()) === undefined) {
      throw new api.status.Failure('IR power state is unknown.');
    }
    if (current().online === false) {
      throw new api.status.Failure('Hejhome device is offline.');
    }
    await send(requirements);
  };
  const power = (key: string): NonNullable<Handlers['onOff']> => ({
    on: () => actuate({ [key]: true }), off: () => actuate({ [key]: false }),
    toggle: async () => {
      const value = kind === 'ir-switch' ? readVendorPower(current())
        : current().deviceType === 'Airpurifier' ? decodeAirPurifierPower(current().deviceState?.power)
          : current().deviceState?.[key];
      if (typeof value !== 'boolean') {
        throw new api.status.Failure('Current power state is unknown.');
      }
      await actuate({ [key]: !value });
    },
  });
  const powerPart = (key: string, outlet: boolean): MatterAccessoryPart => ({
    id: key, displayName: `${label} ${key.slice('power'.length)}`, deviceType: outlet ? types.OnOffOutlet : types.OnOffLight,
    clusters: { onOff: typeof state[key] === 'boolean' ? { onOff: state[key] === true } : {} }, handlers: { onOff: power(key) },
  });
  switch (kind) {
    case 'relay-switch':
    case 'ir-switch':
    case 'outlet': {
      const key = device.deviceType === 'Airpurifier' || state.power !== undefined || kind !== 'relay-switch' ? 'power' : 'power1';
      accessory.deviceType = kind === 'outlet' || device.deviceType === 'Airpurifier' ? types.OnOffOutlet : types.OnOffLight;
      const powerState = kind === 'ir-switch' ? readVendorPower(device)
        : device.deviceType === 'Airpurifier' ? decodeAirPurifierPower(state.power) : state[key];
      clusters.onOff = typeof powerState === 'boolean' ? { onOff: powerState } : {};
      if (typeof powerState !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
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
      if (keys.some((key) => typeof state[key] !== 'boolean')) {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    }
    case 'white-light':
    case 'color-light': {
      accessory.deviceType = kind === 'white-light' ? types.ColorTemperatureLight : types.ExtendedColorLight;
      clusters.onOff = typeof state.power === 'boolean' ? { onOff: state.power } : {};
      if (typeof state.power !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      const hsv = knownColor(current());
      const knownBrightness = brightness(current());
      clusters.levelControl = knownBrightness === null
        ? { minLevel: 1, maxLevel: 254 }
        : { currentLevel: Math.max(1, Math.round(knownBrightness * 254 / 100)), minLevel: 1, maxLevel: 254 };
      if (knownBrightness === null) {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      const lightPower = power('power');
      handlers.onOff = {
        on: async () => {
          await dimmer.stop();
          await lightPower.on!({});
        },
        off: async () => {
          await dimmer.stop();
          await lightPower.off!({});
        },
        toggle: async () => {
          await dimmer.stop();
          await lightPower.toggle!({});
        },
      };
      const level = async (value: number, withOnOff: boolean) => {
        const brightness = bounded(value, 0, 254) * 100 / 254;
        const vendorBrightness = withOnOff && value === 0 ? 0 : Math.max(1, Math.round(brightness));
        const currentState = current();
        const existingColor = kind === 'color-light' && isColorMode(currentState.deviceState?.lightMode)
          ? knownColor(currentState) : null;
        if (kind === 'color-light' && isColorMode(currentState.deviceState?.lightMode) && !existingColor) {
          throw new Error('Current colour is unknown.');
        }
        const requirements = existingColor
          ? { hsvColor: { ...existingColor, brightness: vendorBrightness } }
          : { brightness: vendorBrightness };
        await actuate(withOnOff ? { ...requirements, power: value > 0 } : requirements);
      };
      const readLevel = () => {
        const value = brightness(current());
        return value === null ? null : Math.max(1, Math.round(value * 254 / 100));
      };
      handlers.levelControl = {
        moveToLevel: async ({ level: value }) => {
          await dimmer.stop();
          await level(value, false);
        },
        moveToLevelWithOnOff: async ({ level: value }) => {
          await dimmer.stop();
          await level(value, true);
        },
        move: ({ moveMode, rate }) => dimmer.move(moveMode, rate, readLevel, (value) => level(value, false)),
        step: ({ stepMode, stepSize, transitionTime }) =>
          dimmer.step(stepMode, stepSize, transitionTime, readLevel, (value) => level(value, false)),
        stop: () => dimmer.stop(),
      };
      if (kind === 'white-light') {
        const temperatureMired = whiteTemperaturePercentToMired(state.temperature);
        clusters.colorControl = {
          ...(temperatureMired !== null ? { colorTemperatureMireds: temperatureMired } : {}),
          colorMode: 2,
          colorTempPhysicalMinMireds: 154, colorTempPhysicalMaxMireds: 333, coupleColorTempToLevelMinMireds: 154,
        };
        if (temperatureMired === null) {
          clusters.bridgedDeviceBasicInformation = { reachable: false };
        }
        handlers.colorControl = { moveToColorTemperatureLogic: async ({ colorTemperatureMireds }) => {
          const temperature = whiteMiredToTemperaturePercent(colorTemperatureMireds);
          if (temperature === null) {
            throw new api.status.Failure('Invalid white-light colour temperature.');
          }
          await dimmer.stop();
          await actuate({ temperature });
        } };
      } else {
        clusters.colorControl = { ...(hsv ? { currentHue: Math.round(hsv.hue * 254 / 360),
          currentSaturation: Math.round(hsv.saturation * 254 / 100) } : {}), colorMode: 0 };
        if (!hsv) {
          clusters.bridgedDeviceBasicInformation = { reachable: false };
        }
        const setColor = async (partial: Partial<{ hue: number; saturation: number; brightness: number }>) => {
          await dimmer.stop();
          const nextColor = (snapshot: HejDevice) => {
            const next = { hue: partial.hue ?? number(snapshot.deviceState?.hsvColor?.hue),
              saturation: partial.saturation ?? number(snapshot.deviceState?.hsvColor?.saturation),
              brightness: partial.brightness ?? brightness(snapshot) };
            if (next.hue === null || next.saturation === null || next.brightness === null
              || next.hue < 0 || next.hue > 360 || next.saturation < 0 || next.saturation > 100) {
              throw new Error('Current colour is unknown.');
            }
            return next;
          };
          const currentState = current();
          nextColor(currentState);
          if (!isColorMode(currentState.deviceState?.lightMode)) {
            await actuate({ lightMode: 'colour' });
          }
          await actuate({ hsvColor: nextColor(current()) });
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
      clusters.occupancySensing = typeof state.motionDetected === 'boolean'
        ? { occupancy: { occupied: state.motionDetected } } : {};
      if (typeof state.motionDetected !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    case 'contact-sensor':
      accessory.deviceType = types.ContactSensor;
      {
        const opened = typeof state.doorOpened === 'boolean' ? state.doorOpened
          : device.deviceType === 'ZigbeeDoorlock' ? null
            : state.state === 'OPEN' ? true : state.state === 'CLOSED' ? false : null;
        clusters.booleanState = opened === null ? {} : { stateValue: !opened };
        if (opened === null) {
          clusters.bridgedDeviceBasicInformation = { reachable: false };
        }
      }
      break;
    case 'leak-sensor':
      accessory.deviceType = types.LeakSensor;
      clusters.booleanState = typeof state.alarm === 'boolean' ? { stateValue: state.alarm } : {};
      if (typeof state.alarm !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    case 'smoke-sensor':
      accessory.deviceType = types.SmokeSensor;
      clusters.smokeCoAlarm = typeof state.alarm === 'boolean'
        ? { smokeState: state.alarm ? 2 : 0, expressedState: state.alarm ? 1 : 0 } : {};
      if (typeof state.alarm !== 'boolean') {
        clusters.bridgedDeviceBasicInformation = { reachable: false };
      }
      break;
    default:
      // IR HVAC, buttons, cameras and locks need additional command/event evidence.
      return null;
  }
  if (device.deviceType === 'Airpurifier' && typeof pm25Multiplier === 'number'
    && Number.isFinite(pm25Multiplier) && pm25Multiplier > 0) {
    const airQualityType = types.AirQualitySensor.with(
      types.AirQualitySensor.requirements.server.optional.Pm25ConcentrationMeasurement.with('NumericMeasurement'));
    accessory.parts = [{ id: 'air-quality', displayName: `${label} PM2.5`, deviceType: airQualityType,
      clusters: { airQuality: { airQuality: 0 }, pm25ConcentrationMeasurement: {
        measuredValue: calibratePm25(state.pm25, pm25Multiplier), measurementMedium: 0, measurementUnit: 4,
      } } }];
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
function isColorMode(mode: unknown): boolean {
  return mode === 'COLOR' || mode === 'COLOUR';
}
function matterLabel(name: string): string {
  // Installed Matter.js validates nodeLabel with JavaScript UTF-16 length <= 32.
  // Iterate code points so truncation never leaves half of a surrogate pair.
  let result = '';
  for (const symbol of name) {
    if (result.length + symbol.length > 32) {
      break;
    }
    result += symbol;
  }
  return result;
}
function brightness(device: HejDevice): number | null {
  const state = device.deviceState;
  if (!state) {
    return null;
  }
  const raw = isColorMode(state.lightMode) ? state.hsvColor?.brightness ?? state.brightness : state.brightness;
  const value = number(raw);
  return value !== null && value >= 0 && value <= 100 ? value : null;
}
function knownColor(device: HejDevice): { hue: number; saturation: number; brightness: number } | null {
  const hue = number(device.deviceState?.hsvColor?.hue);
  const saturation = number(device.deviceState?.hsvColor?.saturation);
  const value = brightness(device);
  return hue !== null && hue >= 0 && hue <= 360 && saturation !== null && saturation >= 0 && saturation <= 100
    && value !== null ? { hue, saturation, brightness: value } : null;
}
