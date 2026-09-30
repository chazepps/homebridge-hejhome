import type { AdaptiveLightingController, PlatformAccessory, Service as HomebridgeService, WithUUID } from 'homebridge';

import type { HejRestClient } from './hej/rest.js';
import type { HejhomePlatform } from './platform.js';
import type { HejDevice, HejDeviceState } from './types.js';
import { getDeviceCapability, supportsDeviceRole, type DeviceCapability } from './devices/capabilities.js';

import { isMomentaryPowerDevice, readVendorPower } from './devices/power.js';
import { decodeAirPurifierPower } from './devices/purifier.js';
import { calibratePm25 } from './devices/airQuality.js';
import { OutletLoadTracker } from './devices/load.js';
import { measurementFreshnessMs } from './runtime/health.js';
import { IrHapButtons } from './media/irHapButtons.js';

import { AdaptiveLightingSession } from './lighting/adaptive.js';
import { whiteMiredToTemperaturePercent, whiteTemperaturePercentToMired } from './lighting/temperature.js';

type PowerKey = `power${number}` | 'power';
type ServiceType = WithUUID<typeof HomebridgeService>;
type ServiceRegistry = Record<string, ServiceType | undefined>;
type AddServiceByType = (serviceType: ServiceType, name: string, subtype?: string) => HomebridgeService;

const ANALOG_CONTROL_DEBOUNCE_MS = 350;

export class HejhomePlatformAccessory {
  private adaptiveController: AdaptiveLightingController | undefined;
  private adaptiveSession: AdaptiveLightingSession | undefined;
  private disposed = false;
  private colorControlQueue: Promise<void> = Promise.resolve();
  private lightingObservationRevision = 0;
  private readonly observedColor = new Map<'hue' | 'saturation' | 'brightness', { revision: number; value: number }>();
  private observedLightMode: { revision: number; mode: 'white' | 'color' | 'scene' } | undefined;
  private readonly momentaryPower: boolean;
  private readonly loadTracker: OutletLoadTracker | undefined;
  private readonly loadField: string | undefined;
  private readonly capability: DeviceCapability;
  private readonly irButtons: IrHapButtons;
  private canonicalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private powerResetTimer: ReturnType<typeof setTimeout> | null = null;
  private analogControlTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnalogControlRequirements: Record<string, unknown> | null = null;
  private readonly pendingAnalogControlEvents = new Set<string>();

  constructor(
    private readonly platform: HejhomePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: HejDevice,
    private client: HejRestClient | null,
  ) {
    this.accessory.context.device = device;
    this.momentaryPower = isMomentaryPowerDevice(device);
    this.capability = getDeviceCapability(device.deviceType) ?? {
      deviceType: device.deviceType,
      label: '지원 확인 필요',
      serviceKind: 'unsupported',
      supportStatus: 'unsupported',
      homeKitServices: [],
    };

    this.baseService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelName ?? device.deviceType)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);

    const meter = this.platform.features?.meters?.find((profile) => profile.model === device.modelName);
    if (meter?.power) {
      this.loadField = meter.power.field;
      this.loadTracker = new OutletLoadTracker(meter.power, measurementFreshnessMs(device, meter.power.field, this.platform.features) ?? 300000);
    }
    this.removeStaleBaseServices();
    this.configureServices();
    this.configureAirQuality();
    this.irButtons = new IrHapButtons({
      accessory: this.accessory, Service: this.platform.Service, Characteristic: this.platform.Characteristic,
      deviceType: device.deviceType, enabled: this.platform.features?.devices?.[device.id]?.remoteButtons === true,
      send: (command) => this.platform.controlRemoteButton(device.id, command),
      ensureAvailable: () => {
        this.readDevice();
        this.requireClient();
      },
    });
    this.configureSensorFaults();
    this.updateDevice(device);
  }

  rebindClient(client: HejRestClient | null): void {
    this.client = client;
  }

  observeExternal(patch: HejDeviceState): void {
    const reportedMode = normalizedLightMode(patch.lightMode);
    this.lightingObservationRevision++;
    if (reportedMode) {
      this.observedLightMode = { revision: this.lightingObservationRevision, mode: reportedMode };
    }
    const observation = mergeDeviceState(this.currentDevice(), patch);
    const activeMode = normalizedLightMode(observation.deviceState?.lightMode);
    const changedColorKeys: Array<'hue' | 'saturation' | 'brightness'> = activeMode === 'white'
      ? patch.brightness !== undefined ? ['brightness'] : []
      : patch.hsvColor ? ['hue', 'saturation', 'brightness'] : [];
    for (const key of changedColorKeys) {
      const value = knownColorComponent(observation, key);
      if (value !== undefined) {
        this.observedColor.set(key, { revision: this.lightingObservationRevision, value });
      }
    }
    if (reportedMode && reportedMode !== normalizedLightMode(this.currentDevice().deviceState?.lightMode)) {
      this.cancelAnalogControlSet('newer-light-mode');
    }
    if (this.pendingAnalogControlRequirements) {
      const pending = this.pendingAnalogControlRequirements;
      for (const key of Object.keys(patch)) {
        delete pending[key];
      }
      if (Object.keys(pending).length === 0) {
        this.cancelAnalogControlSet('newer-device-report');
      }
    }
    this.adaptiveSession?.observe(patch);
    this.loadTracker?.observe(patch);
  }

  prepareExternalControl(requirements: Record<string, unknown>): void {
    this.cancelAnalogControlSet('external-control');
    if (requirements.temperature !== undefined || requirements.hsvColor !== undefined
      || requirements.lightMode !== undefined || requirements.sceneValues !== undefined) {
      this.adaptiveController?.disableAdaptiveLighting();
    }
  }

  dispose(reason: 'shutdown' | 'removal' = 'removal'): void {
    this.disposed = true;
    this.irButtons.dispose();
    if (this.momentaryPower) {
      this.baseService(this.platform.Service.Switch)?.updateCharacteristic(this.platform.Characteristic.On, false);
    }
    this.cancelAnalogControlSet('shutdown-or-removal');
    if (this.canonicalRefreshTimer) {
      clearTimeout(this.canonicalRefreshTimer);
      this.canonicalRefreshTimer = null;
    }
    if (this.powerResetTimer) {
      clearTimeout(this.powerResetTimer);
      this.powerResetTimer = null;
    }
    // Detach persistence before stopping the automatic timer: keep the last saved schedule.
    this.adaptiveController?.setupStateChangeDelegate(() => undefined);
    this.adaptiveController?.disableAdaptiveLighting();
    if (this.adaptiveController && reason === 'removal') {
      this.accessory.removeController(this.adaptiveController);
    }
  }

  updateDevice(device: HejDevice): void {
    this.accessory.context.device = device;
    if (this.momentaryPower) {
      this.updatePowerService(device, 'power', this.platform.Service.Switch);
      return;
    }
    switch (this.capability.serviceKind) {
      case 'color-light':
        this.updateColorLight(device);
        break;
      case 'white-light':
        this.updateWhiteLight(device);
        break;
      case 'multi-switch':
        this.updatePowerServices(device, this.switchPowerKeys(device), this.powerServiceType(this.platform.Service.Switch));
        break;
      case 'relay-switch':
        this.updatePowerService(device, this.relayPowerKey(device), this.powerServiceType(this.platform.Service.Switch));
        break;
      case 'ir-switch':
        this.updatePowerService(device, 'power', this.powerServiceType(this.platform.Service.Switch));
        break;
      case 'outlet':
        this.updateOutlet(device);
        break;
      case 'power-strip':
        this.updatePowerServices(device, this.powerStripKeys(device), this.powerServiceType(this.platform.Service.Outlet));
        break;
      case 'window-covering':
        this.updateWindowCovering(device);
        break;
      case 'motion-sensor':
        this.updateMotionSensor(device);
        this.updateBatteryService(device);
        break;
      case 'contact-sensor':
        this.updateContactSensor(device);
        this.updateBatteryService(device);
        break;
      case 'temperature-humidity-sensor':
        this.updateTemperatureHumiditySensor(device);
        this.updateBatteryService(device);
        break;
      case 'leak-sensor':
        this.updateLeakSensor(device);
        this.updateBatteryService(device);
        break;
      case 'smoke-sensor':
        this.updateSmokeSensor(device);
        this.updateBatteryService(device);
        break;
      case 'ir-fan':
        this.updateFan(device);
        break;
      case 'stateless-button':
      case 'camera':
      case 'unsupported':
        this.updateBatteryService(device);
        break;
    }
    this.updateAirQuality(device);
    this.updateSensorFaults();
  }

  private sensorServices(): Array<[HomebridgeService, string]> {
    const result: Array<[HomebridgeService, string]> = [];
    for (const [type, key] of [
      [this.platform.Service.MotionSensor, 'motionDetected'], [this.platform.Service.ContactSensor, 'state'],
      [this.platform.Service.LeakSensor, 'alarm'], [this.platform.Service.SmokeSensor, 'alarm'],
      [this.platform.Service.TemperatureSensor, 'temperature'], [this.platform.Service.HumiditySensor, 'humidity'],
      [this.platform.Service.AirQualitySensor, 'pm25'],
    ] as const) {
      const service = this.baseService(type);
      if (service) {
        result.push([service, key]);
      }
    }
    return result;
  }

  private sensorFault(key: string): number {
    try {
      const device = this.readDevice();
      if (key === 'pm25') {
        this.readPm25();
      } else if (['temperature', 'humidity'].includes(key)) {
        this.readMeasurement(key);
      } else if (!hasSensorState(device, key)) {
        throw this.communicationError();
      }
      return this.platform.Characteristic.StatusFault.NO_FAULT;
    } catch {
      return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
    }
  }

  private configureSensorFaults(): void {
    if (!this.platform.Characteristic.StatusFault) {
      return;
    }
    for (const [service, key] of this.sensorServices()) {
      service.getCharacteristic(this.platform.Characteristic.StatusFault).onGet(() => this.sensorFault(key));
    }
  }

  private updateSensorFaults(): void {
    if (!this.platform.Characteristic.StatusFault) {
      return;
    }
    for (const [service, key] of this.sensorServices()) {
      service.updateCharacteristic(this.platform.Characteristic.StatusFault, this.sensorFault(key));
    }
  }

  private hasCalibratedAirQuality(): boolean {
    const multiplier = this.platform.features?.devices?.[this.device.id]?.pm25Multiplier;
    return this.device.deviceType === 'Airpurifier' && typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier > 0;
  }

  private readPm25(): number {
    const device = this.readDevice();
    const multiplier = this.platform.features?.devices?.[device.id]?.pm25Multiplier;
    const value = calibratePm25(device.deviceState?.pm25, multiplier);
    if (value === null || this.platform.getMeasurementHealth?.(device.id, 'pm25')?.reachable === false) {
      throw this.communicationError();
    }
    return value;
  }

  private configureAirQuality(): void {
    if (!this.hasCalibratedAirQuality()) {
      return;
    }
    const service = this.service(this.platform.Service.AirQualitySensor, `${this.device.name} 미세먼지`);
    service.getCharacteristic(this.platform.Characteristic.AirQuality).onGet(() => {
      this.readDevice();
      return this.platform.Characteristic.AirQuality.UNKNOWN;
    });
    service.getCharacteristic(this.platform.Characteristic.PM2_5Density)
      .setProps({ minStep: null }).onGet(() => this.readPm25());
  }

  private updateAirQuality(device: HejDevice): void {
    if (!this.hasCalibratedAirQuality()) {
      return;
    }
    const service = this.baseService(this.platform.Service.AirQualitySensor);
    if (!service) {
      return;
    }
    service.updateCharacteristic(this.platform.Characteristic.AirQuality, this.platform.Characteristic.AirQuality.UNKNOWN);
    const value = calibratePm25(device.deviceState?.pm25, this.platform.features?.devices?.[device.id]?.pm25Multiplier);
    if (value !== null && this.platform.getMeasurementHealth?.(device.id, 'pm25')?.reachable !== false) {
      service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, value);
    }
  }

  private configureServices(): void {
    if (this.momentaryPower) {
      this.configurePowerService(this.platform.Service.Switch, 'power', this.device.name);
      return;
    }
    switch (this.capability.serviceKind) {
      case 'color-light':
        this.configureColorLight();
        break;
      case 'white-light':
        this.configureWhiteLight();
        break;
      case 'multi-switch':
        this.configurePowerServices(this.switchPowerKeys(this.device), this.powerServiceType(this.platform.Service.Switch), '스위치');
        break;
      case 'relay-switch':
        this.configurePowerService(this.powerServiceType(this.platform.Service.Switch), this.relayPowerKey(this.device), this.device.name);
        break;
      case 'ir-switch':
        this.configurePowerService(this.platform.Service.Switch, 'power', this.device.name);
        break;
      case 'outlet':
        this.configureOutlet();
        break;
      case 'power-strip':
        this.configurePowerServices(this.powerStripKeys(this.device), this.powerServiceType(this.platform.Service.Outlet), '콘센트');
        break;
      case 'window-covering':
        this.configureWindowCovering();
        break;
      case 'motion-sensor':
        this.service(this.platform.Service.MotionSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.MotionDetected)
          .onGet(() => readMotionState(this.readDevice()));
        this.configureBatteryService();
        break;
      case 'contact-sensor':
        this.service(this.platform.Service.ContactSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.ContactSensorState)
          .onGet(() => readContactState(this.platform, this.readDevice()));
        this.configureBatteryService();
        break;
      case 'temperature-humidity-sensor':
        this.service(this.platform.Service.TemperatureSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .onGet(() => this.readMeasurement('temperature'));
        this.service(this.platform.Service.HumiditySensor, `${this.device.name} 습도`)
          .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
          .onGet(() => this.readMeasurement('humidity'));
        this.configureBatteryService();
        break;
      case 'leak-sensor':
        this.service(this.platform.Service.LeakSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.LeakDetected)
          .onGet(() => readLeakState(this.platform, this.readDevice()));
        this.configureBatteryService();
        break;
      case 'smoke-sensor':
        this.service(this.platform.Service.SmokeSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.SmokeDetected)
          .onGet(() => readSmokeState(this.platform, this.readDevice()));
        this.configureBatteryService();
        break;
      case 'stateless-button':
        this.configureBatteryService();
        break;
      case 'ir-fan':
        this.configureFan();
        break;
      case 'camera':
      case 'unsupported':
        this.configureBatteryService();
        break;
    }
  }

  private configureColorLight(): void {
    const light = this.service(this.platform.Service.Lightbulb, this.device.name);
    light.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.readPower('power'))
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'on'));
    light.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.readColorComponent('brightness'))
      .onSet((value) => this.enqueueColorControl(() => this.handleColorLightBrightnessSet(Number(value))));
    light.getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => this.readColorComponent('hue'))
      .onSet((value) => this.enqueueColorControl(() => this.handleHsvSet({ hue: Number(value) }, true)));
    light.getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => this.readColorComponent('saturation'))
      .onSet((value) => this.enqueueColorControl(() => this.handleSaturationSet(Number(value))));
  }

  private configureWhiteLight(): void {
    const light = this.service(this.platform.Service.Lightbulb, this.device.name);
    light.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.readPower('power'))
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'white-light.on'));
    light.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => this.readWhitePercent('brightness'))
      .onSet((value) => this.scheduleAnalogControlSet({ brightness: clampNumber(Number(value), 0, 100) }, 'white-light.brightness'));
    const colorTemperature = light.getCharacteristic(this.platform.Characteristic.ColorTemperature);
    const initialTemperature = whiteTemperaturePercentToMired(this.currentDevice().deviceState?.temperature);
    if (initialTemperature !== null) {
      colorTemperature.updateValue?.(initialTemperature);
    } else if (typeof colorTemperature.value === 'number' && (colorTemperature.value < 154 || colorTemperature.value > 333)) {
      // A newly constructed HAP characteristic defaults to 140 mired. Do not publish a made-up measured value.
      colorTemperature.value = null;
    }
    colorTemperature
      .onGet(() => whiteTemperaturePercentToMired(this.readWhitePercent('temperature'))!)
      .setProps({ minValue: 154, maxValue: 333 })
      .onSet((value) => {
        const temperature = whiteMiredToTemperaturePercent(value);
        if (temperature === null) {
          throw this.communicationError();
        }
        this.adaptiveSession?.commanded(temperature);
        this.scheduleAnalogControlSet({ temperature }, 'white-light.temperature');
      });
    if (this.platform.features?.adaptiveLighting) {
      this.adaptiveController = new this.platform.api.hap.AdaptiveLightingController(light);
      this.adaptiveSession = new AdaptiveLightingSession(this.adaptiveController);
      this.accessory.configureController(this.adaptiveController);
    } else {
      for (const type of [this.platform.Characteristic.SupportedCharacteristicValueTransitionConfiguration,
        this.platform.Characteristic.CharacteristicValueTransitionControl,
        this.platform.Characteristic.CharacteristicValueActiveTransitionCount]) {
        if (light.testCharacteristic(type)) {
          light.removeCharacteristic(light.getCharacteristic(type));
        }
      }
    }
  }

  private configurePowerServices(keys: PowerKey[], serviceType: ServiceType, label: string): void {
    keys.forEach((key, index) => {
      const name = keys.length === 1 ? this.device.name : `${this.device.name} ${label} ${index + 1}`;
      this.configurePowerService(serviceType, key, name, key);
    });
  }

  private configurePowerService(serviceType: ServiceType, key: PowerKey, name: string, subtype?: string): void {
    const service = this.service(serviceType, this.momentaryPower ? `${name} 전원 버튼` : name, subtype);
    if (this.momentaryPower && key === 'power') {
      service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => {
          this.readDevice();
          return false;
        })
        .onSet(async (value) => {
          if (value === true || value === 1) {
            await this.handleControlSet({ power: true }, 'remote.power-button');
          }
          if (this.powerResetTimer) {
            clearTimeout(this.powerResetTimer);
          }
          // HAP commits the requested value after onSet resolves; reset in the next event-loop turn.
          this.powerResetTimer = setTimeout(() => {
            this.powerResetTimer = null;
            if (!this.disposed) {
              service.updateCharacteristic(this.platform.Characteristic.On, false);
            }
          }, 0);
        });
      return;
    }
    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.readPower(key))
      .onSet((value) => this.handlePowerSet(key, Boolean(value)));
    if (serviceType === this.platform.Service.Outlet) {
      service.getCharacteristic(this.platform.Characteristic.OutletInUse).onGet(() => this.readPower(key));
    }
  }

  private configureOutlet(): void {
    const outlet = this.service(this.powerServiceType(this.platform.Service.Outlet), this.device.name);
    outlet.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.readPower('power'))
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'outlet.on'));
    if (this.powerServiceType(this.platform.Service.Outlet) === this.platform.Service.Outlet) {
      outlet.getCharacteristic(this.platform.Characteristic.OutletInUse).onGet(() => this.readOutletInUse());
    }
  }

  private configureWindowCovering(): void {
    const covering = this.service(this.platform.Service.WindowCovering, this.device.name);
    covering.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => this.readMeasurement('percentState'));
    covering.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(() => {
        const value = readTargetPosition(this.readDevice());
        if (value === undefined) {
          throw this.communicationError();
        }
        return value;
      })
      .onSet((value) => this.handleControlSet({ percentControl: clampNumber(Number(value), 0, 100) }, 'window-covering.target-position'));
    covering.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => {
        const state = readPositionState(this.platform, this.readDevice());
        if (state === undefined) {
          throw this.communicationError();
        }
        return state;
      });
  }

  private configureFan(): void {
    const fanService = this.service(this.fanServiceType(), this.device.name);
    fanService.getCharacteristic(this.platform.Characteristic.Active ?? this.platform.Characteristic.On)
      .onGet(() => this.readPower('power') ? 1 : 0)
      .onSet((value) => this.handleControlSet({ power: Number(value) === 1 || value === true }, 'fan.active'));
  }

  private configureBatteryService(): void {
    const state = this.currentDevice().deviceState;
    if (state?.battery === undefined && !this.capability.homeKitServices.includes('BatteryService')) {
      return;
    }
    const battery = this.service(this.batteryServiceType(), `${this.device.name} 배터리`);
    battery.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => clampNumber(this.readBattery(), 0, 100));
    battery.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() => this.readBattery() <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }

  private async handlePowerSet(key: PowerKey, value: boolean): Promise<void> {
    await this.handleControlSet({ [key]: value }, `power.${key}`);
  }

  private async handleControlSet(requirements: Record<string, unknown>, event: string): Promise<void> {
    this.requireClient();
    await this.sendControlSet(requirements, event);
  }

  private async sendControlSet(requirements: Record<string, unknown>, event: string): Promise<void> {
    if (!this.client) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.platform.info('accessory.control.set.requested', {
      deviceId: this.device.id,
      name: this.device.name,
      event,
      stateKeys: Object.keys(requirements),
    });
    try {
      if (this.platform.controlDevice) {
        await this.platform.controlDevice(this.device.id, requirements, 'hap');
        if (this.disposed) {
          throw this.communicationError();
        }
      } else {
        await this.client.controlDevice(this.device.id, requirements);
        if (this.disposed) {
          throw this.communicationError();
        }
        const patch = { ...requirements };
        if (this.momentaryPower) {
          delete patch.power;
        }
        this.updateDevice(mergeDeviceState(this.currentDevice(), patch));
      }
      this.scheduleCanonicalRefresh();
      this.platform.info('accessory.control.set.succeeded', {
        deviceId: this.device.id,
        name: this.device.name,
        event,
        stateKeys: Object.keys(requirements),
      });
    } catch (error) {
      this.platform.error('accessory.control.set.failed', {
        deviceId: this.device.id,
        name: this.device.name,
        event,
        stateKeys: Object.keys(requirements),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private scheduleCanonicalRefresh(): void {
    if (this.canonicalRefreshTimer) {
      clearTimeout(this.canonicalRefreshTimer);
    }
    // HAP stores the requested value after onSet resolves. Publish the latest canonical state after that write.
    this.canonicalRefreshTimer = setTimeout(() => {
      this.canonicalRefreshTimer = null;
      if (!this.disposed) {
        this.updateDevice(this.currentDevice());
      }
    }, 0);
  }

  private scheduleAnalogControlSet(requirements: Record<string, unknown>, event: string): void {
    this.requireClient();
    this.pendingAnalogControlRequirements = {
      ...(this.pendingAnalogControlRequirements ?? {}),
      ...requirements,
    };
    this.pendingAnalogControlEvents.add(event);
    this.updateDevice(mergeDeviceState(this.currentDevice(), requirements));
    this.platform.info('accessory.control.set.debounce.queued', {
      deviceId: this.device.id,
      name: this.device.name,
      event,
      delayMs: ANALOG_CONTROL_DEBOUNCE_MS,
      stateKeys: Object.keys(this.pendingAnalogControlRequirements),
    });
    if (this.analogControlTimer) {
      clearTimeout(this.analogControlTimer);
    }
    this.analogControlTimer = setTimeout(() => {
      void this.flushAnalogControlSet().catch((error) => {
        this.platform.error('accessory.control.set.debounce.failed', {
          deviceId: this.device.id,
          name: this.device.name,
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ANALOG_CONTROL_DEBOUNCE_MS);
  }

  private async flushAnalogControlSet(): Promise<void> {
    const requirements = this.pendingAnalogControlRequirements;
    if (!requirements || Object.keys(requirements).length === 0) {
      return;
    }
    const event = [...this.pendingAnalogControlEvents].join('+') || 'analog';
    this.pendingAnalogControlRequirements = null;
    this.pendingAnalogControlEvents.clear();
    this.analogControlTimer = null;
    await this.sendControlSet(requirements, `debounced.${event}`);
  }

  private cancelAnalogControlSet(reason: string): void {
    if (this.analogControlTimer) {
      clearTimeout(this.analogControlTimer);
      this.analogControlTimer = null;
    }
    if (!this.pendingAnalogControlRequirements) {
      return;
    }
    this.platform.info('accessory.control.set.debounce.cancelled', {
      deviceId: this.device.id,
      name: this.device.name,
      reason,
      stateKeys: Object.keys(this.pendingAnalogControlRequirements),
    });
    this.pendingAnalogControlRequirements = null;
    this.pendingAnalogControlEvents.clear();
  }

  private requireClient(): HejRestClient {
    if (this.disposed || !this.client) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.client;
  }

  private enqueueColorControl(action: () => Promise<void>): Promise<void> {
    const command = this.colorControlQueue.catch(() => undefined).then(() => {
      this.requireClient();
      return action();
    });
    this.colorControlQueue = command;
    return command;
  }

  private readColorComponent(key: 'hue' | 'saturation' | 'brightness'): number {
    const value = knownColorComponent(this.readDevice(), key);
    if (value === undefined) {
      throw this.communicationError();
    }
    return value;
  }

  private readWhitePercent(key: 'brightness' | 'temperature'): number {
    const value = numericState(this.readDevice(), key);
    if (value === null || value < 0 || value > 100) {
      throw this.communicationError();
    }
    return value;
  }

  private async handleColorLightBrightnessSet(value: number): Promise<void> {
    const currentDevice = this.currentDevice();
    const brightness = clampNumber(value, 0, 100);
    if (currentDevice.deviceState?.lightMode === 'WHITE') {
      this.scheduleAnalogControlSet({ brightness }, 'light.white.brightness');
      return;
    }
    await this.handleHsvSet({ brightness }, currentDevice.deviceState?.lightMode === 'SCENE');
  }

  private async handleSaturationSet(value: number): Promise<void> {
    const saturation = clampNumber(value, 0, 100);
    if (saturation === 0) {
      this.readColorComponent('brightness');
      const currentDevice = this.currentDevice();
      const revision = this.lightingObservationRevision;
      this.cancelAnalogControlSet('light.mode.white');
      if (currentDevice.deviceState?.lightMode !== 'WHITE') {
        await this.handleControlSet({ lightMode: 'white' }, 'light.mode.white');
      }
      const basis = this.colorStateAfterMode(currentDevice, revision, 'white');
      if (basis && basis.brightness !== undefined) {
        this.scheduleAnalogControlSet({ brightness: basis.brightness }, 'light.white.brightness');
      }
      return;
    }
    await this.handleHsvSet({ saturation }, true);
  }

  private async handleHsvSet(
    partial: Partial<{ hue: number; saturation: number; brightness: number }>,
    forceColorMode: boolean,
  ): Promise<void> {
    const currentDevice = this.currentDevice();
    const observationRevision = this.lightingObservationRevision;
    this.completeColorCommand({ ...this.colorStateAfterMode(currentDevice, observationRevision, 'color'), ...partial }, forceColorMode);
    if (forceColorMode && !['COLOR', 'COLOUR'].includes(String(currentDevice.deviceState?.lightMode))) {
      this.cancelAnalogControlSet('light.mode.colour');
      await this.handleControlSet({ lightMode: 'colour' }, 'light.mode');
    }
    const basis = this.colorStateAfterMode(currentDevice, observationRevision, 'color');
    if (!basis) {
      return;
    }
    const nextHsv = this.completeColorCommand({ ...basis, ...partial }, forceColorMode);
    this.scheduleAnalogControlSet({ hsvColor: nextHsv }, 'light.hsv');
  }

  private colorStateAfterMode(device: HejDevice, revision: number, target: 'white' | 'color') {
    const mode = this.observedLightMode;
    if (mode && mode.revision > revision && mode.mode !== normalizedLightMode(device.deviceState?.lightMode) && mode.mode !== target) {
      return undefined;
    }
    const basis = { hue: knownColorComponent(device, 'hue'), saturation: knownColorComponent(device, 'saturation'),
      brightness: knownColorComponent(device, 'brightness') };
    // A mode echo alone is not a new sample of the destination mode's stored brightness/color.
    for (const [key, observed] of this.observedColor) {
      if (observed.revision > revision) {
        basis[key] = observed.value;
      }
    }
    return basis;
  }

  private completeColorCommand(
    value: { hue?: number | undefined; saturation?: number | undefined; brightness?: number | undefined },
    forceColorMode: boolean,
  ): { hue: number; saturation: number; brightness: number } {
    const { hue, brightness } = value;
    const saturation = forceColorMode && value.saturation === 0 ? 100 : value.saturation;
    if (hue === undefined || saturation === undefined || brightness === undefined
      || !Number.isFinite(hue) || hue < 0 || hue > 360
      || !Number.isFinite(saturation) || saturation < 0 || saturation > 100
      || !Number.isFinite(brightness) || brightness < 0 || brightness > 100) {
      throw this.communicationError();
    }
    return { hue, saturation, brightness };
  }

  private updateColorLight(device: HejDevice): void {
    const light = this.baseService(this.platform.Service.Lightbulb);
    if (!light) {
      return;
    }
    const power = readPowerState(device);
    if (power !== undefined) {
      light.updateCharacteristic(this.platform.Characteristic.On, power);
    }
    for (const [key, characteristic] of [
      ['brightness', this.platform.Characteristic.Brightness], ['hue', this.platform.Characteristic.Hue],
      ['saturation', this.platform.Characteristic.Saturation],
    ] as const) {
      const value = knownColorComponent(device, key);
      if (value !== undefined) {
        light.updateCharacteristic(characteristic, value);
      }
    }
  }

  private updateWhiteLight(device: HejDevice): void {
    const light = this.baseService(this.platform.Service.Lightbulb);
    if (!light) {
      return;
    }
    const power = readPowerState(device);
    if (power !== undefined) {
      light.updateCharacteristic(this.platform.Characteristic.On, power);
    }
    const brightness = numericState(device, 'brightness');
    const temperature = numericState(device, 'temperature');
    if (brightness !== null && brightness >= 0 && brightness <= 100) {
      light.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    }
    if (temperature !== null && temperature >= 0 && temperature <= 100) {
      light.updateCharacteristic(this.platform.Characteristic.ColorTemperature, whiteTemperaturePercentToMired(temperature)!);
    }
  }

  private updatePowerServices(device: HejDevice, keys: PowerKey[], serviceType: ServiceType): void {
    keys.forEach((key) => {
      this.updatePowerService(device, key, serviceType);
    });
  }

  private updatePowerService(device: HejDevice, key: PowerKey, serviceType: ServiceType): void {
    const service = this.accessory.getServiceById?.(serviceType, key)
      ?? this.baseService(serviceType);
    if (!service) {
      return;
    }
    const power = this.momentaryPower ? false : readPowerStateByKey(device, key);
    if (power !== undefined) {
      service.updateCharacteristic(this.platform.Characteristic.On, power);
      if (serviceType === this.platform.Service.Outlet) {
        service.updateCharacteristic(this.platform.Characteristic.OutletInUse, power);
      }
    }
  }

  private updateOutlet(device: HejDevice): void {
    const outlet = this.baseService(this.powerServiceType(this.platform.Service.Outlet));
    if (!outlet) {
      return;
    }
    const power = readPowerState(device);
    if (power === undefined) {
      return;
    }
    outlet.updateCharacteristic(this.platform.Characteristic.On, power);
    if (this.powerServiceType(this.platform.Service.Outlet) === this.platform.Service.Outlet) {
      const load = this.loadTracker ? this.calibratedOutletLoad() : power;
      if (load !== null) {
        outlet.updateCharacteristic(this.platform.Characteristic.OutletInUse, load);
      }
    }
  }

  private updateWindowCovering(device: HejDevice): void {
    const covering = this.baseService(this.platform.Service.WindowCovering);
    if (!covering) {
      return;
    }
    const position = numericState(device, 'percentState');
    if (position !== null) {
      covering.updateCharacteristic(this.platform.Characteristic.CurrentPosition, clampNumber(position, 0, 100));
    }
    const target = readTargetPosition(device);
    if (target !== undefined) {
      covering.updateCharacteristic(this.platform.Characteristic.TargetPosition, target);
    }
    const movement = readPositionState(this.platform, device);
    if (movement !== undefined) {
      covering.updateCharacteristic(this.platform.Characteristic.PositionState, movement);
    }
  }

  private updateMotionSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'motionDetected')) {
      return;
    }
    this.baseService(this.platform.Service.MotionSensor)
      ?.updateCharacteristic(this.platform.Characteristic.MotionDetected, readMotionState(device));
  }

  private updateContactSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'state')) {
      return;
    }
    this.baseService(this.platform.Service.ContactSensor)
      ?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, readContactState(this.platform, device));
  }

  private updateTemperatureHumiditySensor(device: HejDevice): void {
    for (const [key, type, characteristic] of [
      ['temperature', this.platform.Service.TemperatureSensor, this.platform.Characteristic.CurrentTemperature],
      ['humidity', this.platform.Service.HumiditySensor, this.platform.Characteristic.CurrentRelativeHumidity],
    ] as const) {
      const value = numericState(device, key);
      if (value !== null) {
        this.baseService(type)?.updateCharacteristic(characteristic, value);
      }
    }
  }

  private updateLeakSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'alarm')) {
      return;
    }
    this.baseService(this.platform.Service.LeakSensor)
      ?.updateCharacteristic(this.platform.Characteristic.LeakDetected, readLeakState(this.platform, device));
  }

  private updateSmokeSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'alarm')) {
      return;
    }
    this.baseService(this.platform.Service.SmokeSensor)
      ?.updateCharacteristic(this.platform.Characteristic.SmokeDetected, readSmokeState(this.platform, device));
  }

  private updateBatteryService(device: HejDevice): void {
    const battery = this.baseService(this.batteryServiceType());
    if (!battery) {
      return;
    }
    const raw = numericState(device, 'battery');
    if (raw === null) {
      return;
    }
    const level = clampNumber(raw, 0, 100);
    battery.updateCharacteristic(this.platform.Characteristic.BatteryLevel, level);
    battery.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      level <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private updateFan(device: HejDevice): void {
    const fanServiceType = this.fanServiceType();
    const activeCharacteristic = this.platform.Characteristic.Active ?? this.platform.Characteristic.On;
    const power = readPowerState(device);
    if (power !== undefined) {
      this.baseService(fanServiceType)?.updateCharacteristic(activeCharacteristic, power ? 1 : 0);
    }
  }

  private baseService(serviceType: ServiceType): HomebridgeService | undefined {
    const first = this.accessory.getService(serviceType);
    if (!first?.subtype) {
      return first;
    }
    // Stable remote-* switches must never be reused as the device's base power service.
    return this.accessory.services.find((service) => service.UUID === first.UUID && !service.subtype);
  }

  private service(serviceType: ServiceType, name: string, subtype?: string): HomebridgeService {
    const service = subtype
      ? this.accessory.getServiceById?.(serviceType, subtype)
      : this.baseService(serviceType);
    if (service) {
      return service;
    }
    const addService = this.accessory.addService as unknown as AddServiceByType;
    // HAP requires a subtype-less service to be inserted before siblings of the same type.
    // Cached remote buttons can precede a newly restored base power service; preserve their objects and subtypes.
    const siblings = !subtype && Array.isArray(this.accessory.services)
      ? this.accessory.services.filter((candidate) => candidate.UUID === serviceType.UUID && candidate.subtype) : [];
    for (const sibling of siblings) {
      this.accessory.removeService(sibling);
    }
    const created = subtype
      ? addService.call(this.accessory, serviceType, name, subtype)
      : addService.call(this.accessory, serviceType, name);
    for (const sibling of siblings) {
      this.accessory.addService(sibling);
    }
    return created;
  }

  private batteryServiceType(): ServiceType {
    const services = this.platform.Service as unknown as ServiceRegistry;
    const serviceType = services.BatteryService ?? services.Battery;
    if (!serviceType) {
      throw new Error('Homebridge Battery service is unavailable');
    }
    return serviceType;
  }

  private fanServiceType(): ServiceType {
    const services = this.platform.Service as unknown as ServiceRegistry;
    const serviceType = services.Fanv2 ?? services.Fan;
    if (!serviceType) {
      throw new Error('Homebridge Fan service is unavailable');
    }
    return serviceType;
  }

  private communicationError(): Error {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private readDevice(requireSensorState = true): HejDevice {
    if (this.disposed || this.platform.getDeviceHealth?.(this.device.id)?.reachable === false) {
      throw this.communicationError();
    }
    const device = this.currentDevice();
    const required = !requireSensorState ? null : this.capability.serviceKind === 'motion-sensor' ? 'motionDetected'
      : this.capability.serviceKind === 'contact-sensor' ? 'state'
        : ['leak-sensor', 'smoke-sensor'].includes(this.capability.serviceKind) ? 'alarm' : null;
    if (required && !hasSensorState(device, required)) {
      throw this.communicationError();
    }
    return device;
  }

  private readPower(key: PowerKey): boolean {
    const power = readPowerStateByKey(this.readDevice(), key);
    if (power === undefined) {
      throw this.communicationError();
    }
    return power;
  }

  private readBattery(): number {
    const value = numericState(this.readDevice(false), 'battery');
    if (value === null) {
      throw this.communicationError();
    }
    return value;
  }

  private readMeasurement(key: string): number {
    const device = this.readDevice();
    const value = numericState(device, key);
    if (value === null || this.platform.getMeasurementHealth?.(device.id, key)?.reachable === false) {
      throw this.communicationError();
    }
    return value;
  }

  private calibratedOutletLoad(): boolean | null {
    if (this.loadField && this.platform.getMeasurementHealth?.(this.device.id, this.loadField)?.reachable === false) {
      this.loadTracker?.invalidate();
      return null;
    }
    return this.loadTracker?.read() ?? null;
  }

  private readOutletInUse(): boolean {
    const device = this.readDevice();
    const load = this.loadTracker ? this.calibratedOutletLoad() : readPowerState(device);
    if (load === null || load === undefined) {
      throw this.communicationError();
    }
    return load;
  }

  private deviceRole(): 'Lightbulb' | 'Outlet' | 'Switch' | undefined {
    if (!supportsDeviceRole(this.device.deviceType)) {
      return undefined;
    }
    const role = this.platform.features?.devices?.[this.device.id]?.role;
    return role === 'light' ? 'Lightbulb' : role === 'outlet' ? 'Outlet' : role === 'switch' ? 'Switch' : undefined;
  }

  private powerServiceType(fallback: ServiceType): ServiceType {
    const role = this.deviceRole();
    return role ? this.platform.Service[role] : fallback;
  }

  private currentDevice(): HejDevice {
    return this.accessory.context.device as HejDevice;
  }

  private switchPowerKeys(device: HejDevice): PowerKey[] {
    const match = /(?:Zigbee)?Switch(\d+)/.exec(device.deviceType);
    const count = match?.[1] ? Number(match[1]) : countPowerKeys(device.deviceState);
    return powerKeys(Math.max(1, count));
  }

  private relayPowerKey(device: HejDevice): PowerKey {
    if (device.deviceType === 'Airpurifier') {
      return 'power';
    }
    return device.deviceState?.power !== undefined ? 'power' : 'power1';
  }

  private powerStripKeys(device: HejDevice): PowerKey[] {
    const count = Math.max(4, countPowerKeys(device.deviceState));
    return powerKeys(count).filter((key) => key !== 'power5');
  }

  private removeStaleBaseServices(): void {
    const desired = new Set(this.momentaryPower ? ['Switch'] : this.capability.homeKitServices);
    if (this.hasCalibratedAirQuality()) {
      desired.add('AirQualitySensor');
    }
    const role = this.deviceRole();
    if (role) {
      desired.delete('Switch');
      desired.delete('Outlet');
      desired.add(role);
    }
    const stale = [
      ['AirQualitySensor', this.platform.Service.AirQualitySensor],
      ['StatelessProgrammableSwitch', this.platform.Service.StatelessProgrammableSwitch],
      ['Lightbulb', this.platform.Service.Lightbulb],
      ['MotionSensor', this.platform.Service.MotionSensor],
      ['Switch', this.platform.Service.Switch],
      ['Outlet', this.platform.Service.Outlet],
      ['WindowCovering', this.platform.Service.WindowCovering],
      ['ContactSensor', this.platform.Service.ContactSensor],
      ['TemperatureSensor', this.platform.Service.TemperatureSensor],
      ['HumiditySensor', this.platform.Service.HumiditySensor],
      ['LeakSensor', this.platform.Service.LeakSensor],
      ['SmokeSensor', this.platform.Service.SmokeSensor],
      ['Thermostat', this.platform.Service.Thermostat],
      ['Fan', this.fanServiceType()],
    ] as const;

    for (const [name, serviceType] of stale) {
      if (desired.has(name) || !serviceType) {
        continue;
      }
      const service = this.baseService(serviceType);
      if (service) {
        this.accessory.removeService(service);
      }
      for (const key of [...powerKeys(6), 'button1']) {
        const child = this.accessory.getServiceById?.(serviceType, key);
        if (child) {
          this.accessory.removeService(child);
        }
      }
    }

    if (['multi-switch', 'power-strip'].includes(this.capability.serviceKind)) {
      const baseServiceType = this.capability.serviceKind === 'multi-switch'
        ? this.powerServiceType(this.platform.Service.Switch)
        : this.powerServiceType(this.platform.Service.Outlet);
      const baseService = this.baseService(baseServiceType);
      if (baseService) {
        this.accessory.removeService(baseService);
      }
    }
  }
}

export function mergeDeviceState(device: HejDevice, patch: Record<string, unknown>): HejDevice {
  const deviceState = {
    ...(device.deviceState ?? {}),
    ...patch,
  };
  if (typeof patch.hsvColor === 'object' && patch.hsvColor) {
    const brightness = Number((patch.hsvColor as { brightness?: unknown }).brightness);
    if (Number.isFinite(brightness)) {
      deviceState.brightness = brightness;
    }
  }
  if (patch.lightMode === 'colour') {
    deviceState.lightMode = 'COLOR';
  }
  if (patch.lightMode === 'white') {
    deviceState.lightMode = 'WHITE';
  }
  return {
    ...device,
    deviceState,
  };
}

function readPowerState(device: HejDevice): boolean | undefined {
  if (device.deviceType === 'Airpurifier') {
    return decodeAirPurifierPower(device.deviceState?.power) ?? undefined;
  }
  const power = readVendorPower(device);
  if (power !== undefined) {
    return power;
  }
  for (const key of powerKeys(6)) {
    if (typeof device.deviceState?.[key] === 'boolean') {
      return device.deviceState[key] as boolean;
    }
  }
  return undefined;
}

function readPowerStateByKey(device: HejDevice, key: PowerKey): boolean | undefined {
  if (key === 'power') {
    return readPowerState(device);
  }
  const value = device.deviceState?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readMotionState(device: HejDevice): boolean {
  return Boolean(device.deviceState?.motionDetected);
}

function readContactState(platform: HejhomePlatform, device: HejDevice): number {
  const state = String(device.deviceState?.state ?? '').toUpperCase();
  const opened = device.deviceType === 'ZigbeeDoorlock' ? device.deviceState?.doorOpened === true
    : state === 'OPEN' || device.deviceState?.doorOpened === true;
  return opened
    ? platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    : platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
}

function readLeakState(platform: HejhomePlatform, device: HejDevice): number {
  return device.deviceState?.alarm
    ? platform.Characteristic.LeakDetected.LEAK_DETECTED
    : platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
}

function readSmokeState(platform: HejhomePlatform, device: HejDevice): number {
  return device.deviceState?.alarm
    ? platform.Characteristic.SmokeDetected.SMOKE_DETECTED
    : platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
}

function readTargetPosition(device: HejDevice): number | undefined {
  const value = numericState(device, 'percentControl') ?? numericState(device, 'percentState');
  return value === null ? undefined : clampNumber(value, 0, 100);
}

function readPositionState(platform: HejhomePlatform, device: HejDevice): number | undefined {
  const workState = String(device.deviceState?.workState ?? '').toLowerCase();
  if (workState === 'open') {
    return platform.Characteristic.PositionState.INCREASING;
  }
  if (workState === 'close' || workState === 'closing') {
    return platform.Characteristic.PositionState.DECREASING;
  }
  return workState === 'stop' ? platform.Characteristic.PositionState.STOPPED : undefined;
}

function countPowerKeys(state: HejDeviceState | null | undefined): number {
  if (!state) {
    return 1;
  }
  return Object.keys(state).filter((key) => /^power\d+$/.test(key)).length || 1;
}

function powerKeys(count: number): PowerKey[] {
  return Array.from({ length: count }, (_, index) => `power${index + 1}` as PowerKey);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function numericState(device: HejDevice, key: string): number | null {
  const raw = device.deviceState?.[key];
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function hasSensorState(device: HejDevice, key: string): boolean {
  const state = device.deviceState;
  if (key === 'state') {
    if (device.deviceType === 'ZigbeeDoorlock') {
      return typeof state?.doorOpened === 'boolean';
    }
    return typeof state?.doorOpened === 'boolean' || ['OPEN', 'CLOSED'].includes(String(state?.state).toUpperCase());
  }
  return typeof state?.[key] === 'boolean';
}

function knownColorComponent(device: HejDevice, key: 'hue' | 'saturation' | 'brightness'): number | undefined {
  const state = device.deviceState;
  const white = state?.lightMode === 'WHITE';
  if (key === 'saturation' && white) {
    return 0;
  }
  const raw = key === 'brightness' && white ? state?.brightness : state?.hsvColor?.[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > (key === 'hue' ? 360 : 100)) {
    return undefined;
  }
  return raw;
}

function normalizedLightMode(value: unknown): 'white' | 'color' | 'scene' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const mode = value.toLowerCase();
  return mode === 'colour' || mode === 'color' ? 'color' : mode === 'white' || mode === 'scene' ? mode : undefined;
}
