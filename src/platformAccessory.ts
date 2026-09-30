import type { AdaptiveLightingController, PlatformAccessory, Service as HomebridgeService, WithUUID } from 'homebridge';

import type { HejRestClient } from './hej/rest.js';
import type { HejhomePlatform } from './platform.js';
import type { HejDevice, HejDeviceState } from './types.js';
import { getDeviceCapability, type DeviceCapability } from './devices/capabilities.js';

import { isMomentaryPowerDevice, readVendorPower } from './devices/power.js';
import { OutletLoadTracker } from './devices/load.js';

import { AdaptiveLightingSession } from './lighting/adaptive.js';

type PowerKey = `power${number}` | 'power';
type ServiceType = WithUUID<typeof HomebridgeService>;
type ServiceRegistry = Record<string, ServiceType | undefined>;
type AddServiceByType = (serviceType: ServiceType, name: string, subtype?: string) => HomebridgeService;

const ANALOG_CONTROL_DEBOUNCE_MS = 350;

export class HejhomePlatformAccessory {
  private adaptiveController: AdaptiveLightingController | undefined;
  private adaptiveSession: AdaptiveLightingSession | undefined;
  private disposed = false;
  private readonly momentaryPower: boolean;
  private readonly loadTracker: OutletLoadTracker | undefined;
  private readonly capability: DeviceCapability;
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

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelName ?? device.deviceType)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);

    const meter = this.platform.features?.meters?.find((profile) => profile.model === device.modelName);
    if (meter?.power) {
      this.loadTracker = new OutletLoadTracker(meter.power);
    }
    this.removeStaleBaseServices();
    this.configureServices();
    this.configureSensorFaults();
    this.updateDevice(device);
  }

  rebindClient(client: HejRestClient | null): void {
    this.client = client;
  }

  observeExternal(patch: HejDeviceState): void {
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
    if (requirements.temperature !== undefined) {
      this.adaptiveController?.disableAdaptiveLighting();
    }
  }

  dispose(reason: 'shutdown' | 'removal' = 'removal'): void {
    this.disposed = true;
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
    this.updateSensorFaults();
  }

  private sensorServices(): Array<[HomebridgeService, string]> {
    const result: Array<[HomebridgeService, string]> = [];
    for (const [type, key] of [
      [this.platform.Service.MotionSensor, 'motionDetected'], [this.platform.Service.ContactSensor, 'state'],
      [this.platform.Service.LeakSensor, 'alarm'], [this.platform.Service.SmokeSensor, 'alarm'],
      [this.platform.Service.TemperatureSensor, 'temperature'], [this.platform.Service.HumiditySensor, 'humidity'],
    ] as const) {
      const service = this.accessory.getService(type);
      if (service) {
        result.push([service, key]);
      }
    }
    return result;
  }

  private sensorFault(key: string): number {
    try {
      const device = this.readDevice();
      if (['temperature', 'humidity'].includes(key)) {
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
      .onGet(() => readHsvState(this.readDevice()).brightness)
      .onSet((value) => this.handleColorLightBrightnessSet(Number(value)));
    light.getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => readHsvState(this.readDevice()).hue)
      .onSet((value) => this.handleHsvSet({ hue: Number(value) }, true));
    light.getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => readHsvState(this.readDevice()).saturation)
      .onSet((value) => this.handleSaturationSet(Number(value)));
  }

  private configureWhiteLight(): void {
    const light = this.service(this.platform.Service.Lightbulb, this.device.name);
    light.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.readPower('power'))
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'white-light.on'));
    light.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => readNumberState(this.readDevice(), 'brightness', 100))
      .onSet((value) => this.scheduleAnalogControlSet({ brightness: clampNumber(Number(value), 0, 100) }, 'white-light.brightness'));
    light.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .updateValue?.(temperaturePercentToMired(readNumberState(this.currentDevice(), 'temperature', 100)));
    light.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onGet(() => temperaturePercentToMired(readNumberState(this.readDevice(), 'temperature', 100)))
      .setProps({ minValue: 154, maxValue: 333 })
      .onSet((value) => {
        const temperature = miredToTemperaturePercent(Number(value));
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
      } else {
        await this.client.controlDevice(this.device.id, requirements);
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

  private async handleColorLightBrightnessSet(value: number): Promise<void> {
    const currentDevice = this.currentDevice();
    const brightness = clampNumber(value, 0, 100);
    if (currentDevice.deviceState?.lightMode === 'WHITE') {
      this.scheduleAnalogControlSet({ brightness }, 'light.white.brightness');
      return;
    }
    await this.handleHsvSet({ brightness }, false);
  }

  private async handleSaturationSet(value: number): Promise<void> {
    const saturation = clampNumber(value, 0, 100);
    if (saturation === 0) {
      this.cancelAnalogControlSet('light.mode.white');
      await this.handleControlSet({ lightMode: 'white' }, 'light.mode.white');
      return;
    }
    await this.handleHsvSet({ saturation }, true);
  }

  private async handleHsvSet(
    partial: Partial<{ hue: number; saturation: number; brightness: number }>,
    forceColorMode: boolean,
  ): Promise<void> {
    const currentDevice = this.currentDevice();
    const nextHsv = {
      ...readHsvState(currentDevice),
      ...partial,
    };
    if (forceColorMode && nextHsv.saturation === 0) {
      nextHsv.saturation = 100;
    }
    if (forceColorMode && !['COLOR', 'COLOUR'].includes(String(currentDevice.deviceState?.lightMode))) {
      this.cancelAnalogControlSet('light.mode.colour');
      await this.handleControlSet({ lightMode: 'colour' }, 'light.mode');
    }
    this.scheduleAnalogControlSet({ hsvColor: nextHsv }, 'light.hsv');
  }

  private updateColorLight(device: HejDevice): void {
    const light = this.accessory.getService(this.platform.Service.Lightbulb);
    if (!light) {
      return;
    }
    const power = readPowerState(device);
    if (power !== undefined) {
      light.updateCharacteristic(this.platform.Characteristic.On, power);
    }
    const hsv = readHsvState(device);
    light.updateCharacteristic(this.platform.Characteristic.Brightness, hsv.brightness);
    light.updateCharacteristic(this.platform.Characteristic.Hue, hsv.hue);
    light.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.saturation);
  }

  private updateWhiteLight(device: HejDevice): void {
    const light = this.accessory.getService(this.platform.Service.Lightbulb);
    if (!light) {
      return;
    }
    const power = readPowerState(device);
    if (power !== undefined) {
      light.updateCharacteristic(this.platform.Characteristic.On, power);
    }
    light.updateCharacteristic(this.platform.Characteristic.Brightness, readNumberState(device, 'brightness', 100));
    light.updateCharacteristic(
      this.platform.Characteristic.ColorTemperature,
      temperaturePercentToMired(readNumberState(device, 'temperature', 100)),
    );
  }

  private updatePowerServices(device: HejDevice, keys: PowerKey[], serviceType: ServiceType): void {
    keys.forEach((key) => {
      this.updatePowerService(device, key, serviceType);
    });
  }

  private updatePowerService(device: HejDevice, key: PowerKey, serviceType: ServiceType): void {
    const service = this.accessory.getServiceById?.(serviceType, key)
      ?? this.accessory.getService(serviceType);
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
    const outlet = this.accessory.getService(this.powerServiceType(this.platform.Service.Outlet));
    if (!outlet) {
      return;
    }
    const power = readPowerState(device);
    if (power === undefined) {
      return;
    }
    outlet.updateCharacteristic(this.platform.Characteristic.On, power);
    if (this.powerServiceType(this.platform.Service.Outlet) === this.platform.Service.Outlet) {
      const load = this.loadTracker ? this.loadTracker.read() : power;
      if (load !== null) {
        outlet.updateCharacteristic(this.platform.Characteristic.OutletInUse, load);
      }
    }
  }

  private updateWindowCovering(device: HejDevice): void {
    const covering = this.accessory.getService(this.platform.Service.WindowCovering);
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
    this.accessory.getService(this.platform.Service.MotionSensor)
      ?.updateCharacteristic(this.platform.Characteristic.MotionDetected, readMotionState(device));
  }

  private updateContactSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'state')) {
      return;
    }
    this.accessory.getService(this.platform.Service.ContactSensor)
      ?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, readContactState(this.platform, device));
  }

  private updateTemperatureHumiditySensor(device: HejDevice): void {
    for (const [key, type, characteristic] of [
      ['temperature', this.platform.Service.TemperatureSensor, this.platform.Characteristic.CurrentTemperature],
      ['humidity', this.platform.Service.HumiditySensor, this.platform.Characteristic.CurrentRelativeHumidity],
    ] as const) {
      const value = numericState(device, key);
      if (value !== null) {
        this.accessory.getService(type)?.updateCharacteristic(characteristic, value);
      }
    }
  }

  private updateLeakSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'alarm')) {
      return;
    }
    this.accessory.getService(this.platform.Service.LeakSensor)
      ?.updateCharacteristic(this.platform.Characteristic.LeakDetected, readLeakState(this.platform, device));
  }

  private updateSmokeSensor(device: HejDevice): void {
    if (!hasSensorState(device, 'alarm')) {
      return;
    }
    this.accessory.getService(this.platform.Service.SmokeSensor)
      ?.updateCharacteristic(this.platform.Characteristic.SmokeDetected, readSmokeState(this.platform, device));
  }

  private updateBatteryService(device: HejDevice): void {
    const battery = this.accessory.getService(this.batteryServiceType());
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
      this.accessory.getService(fanServiceType)?.updateCharacteristic(activeCharacteristic, power ? 1 : 0);
    }
  }

  private service(serviceType: ServiceType, name: string, subtype?: string): HomebridgeService {
    const service = subtype
      ? this.accessory.getServiceById?.(serviceType, subtype)
      : this.accessory.getService(serviceType);
    if (service) {
      return service;
    }
    const addService = this.accessory.addService as unknown as AddServiceByType;
    const created = subtype
      ? addService.call(this.accessory, serviceType, name, subtype)
      : addService.call(this.accessory, serviceType, name);
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

  private readOutletInUse(): boolean {
    const device = this.readDevice();
    const load = this.loadTracker ? this.loadTracker.read() : readPowerState(device);
    if (load === null || load === undefined) {
      throw this.communicationError();
    }
    return load;
  }

  private deviceRole(): 'Lightbulb' | 'Outlet' | 'Switch' | undefined {
    if (!['relay-switch', 'multi-switch', 'outlet', 'power-strip'].includes(this.capability.serviceKind)) {
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
    return device.deviceState?.power !== undefined ? 'power' : 'power1';
  }

  private powerStripKeys(device: HejDevice): PowerKey[] {
    const count = Math.max(4, countPowerKeys(device.deviceState));
    return powerKeys(count).filter((key) => key !== 'power5');
  }

  private removeStaleBaseServices(): void {
    const desired = new Set(this.momentaryPower ? ['Switch'] : this.capability.homeKitServices);
    const role = this.deviceRole();
    if (role) {
      desired.delete('Switch');
      desired.delete('Outlet');
      desired.add(role);
    }
    const stale = [
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
      const service = this.accessory.getService(serviceType);
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
      const baseService = this.accessory.getService(baseServiceType);
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

function readHsvState(device: HejDevice): { hue: number; saturation: number; brightness: number } {
  const isWhiteMode = device.deviceState?.lightMode === 'WHITE';
  return {
    hue: clampNumber(Number(device.deviceState?.hsvColor?.hue ?? 0), 0, 360),
    saturation: isWhiteMode
      ? 0
      : clampNumber(Number(device.deviceState?.hsvColor?.saturation ?? 0), 0, 100),
    brightness: clampNumber(
      Number(isWhiteMode
        ? device.deviceState?.brightness ?? device.deviceState?.hsvColor?.brightness ?? 100
        : device.deviceState?.hsvColor?.brightness ?? device.deviceState?.brightness ?? 100),
      0,
      100,
    ),
  };
}

function readMotionState(device: HejDevice): boolean {
  return Boolean(device.deviceState?.motionDetected);
}

function readContactState(platform: HejhomePlatform, device: HejDevice): number {
  const state = String(device.deviceState?.state ?? '').toUpperCase();
  const opened = state === 'OPEN' || device.deviceState?.doorOpened === true;
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

function readNumberState(device: HejDevice, key: keyof HejDeviceState, fallback: number): number {
  const value = Number(device.deviceState?.[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
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

function temperaturePercentToMired(value: number): number {
  const kelvin = 3000 + (clampNumber(value, 0, 100) / 100 * 3500);
  return clampNumber(1_000_000 / kelvin, 140, 500);
}

function miredToTemperaturePercent(value: number): number {
  const kelvin = 1_000_000 / clampNumber(value, 140, 500);
  return clampNumber(((kelvin - 3000) / 3500) * 100, 0, 100);
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
    return typeof state?.doorOpened === 'boolean' || ['OPEN', 'CLOSED'].includes(String(state?.state).toUpperCase());
  }
  return typeof state?.[key] === 'boolean';
}
