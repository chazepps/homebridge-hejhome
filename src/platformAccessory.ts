import type { PlatformAccessory, Service as HomebridgeService, WithUUID } from 'homebridge';

import type { HejRestClient } from './hej/rest.js';
import type { HejhomePlatform } from './platform.js';
import type { HejDevice, HejDeviceState } from './types.js';
import { getDeviceCapability, type DeviceCapability } from './devices/capabilities.js';

type PowerKey = `power${number}` | 'power';
type ServiceType = WithUUID<typeof HomebridgeService>;
type ServiceRegistry = Record<string, ServiceType | undefined>;
type AddServiceByType = (serviceType: ServiceType, name: string, subtype?: string) => HomebridgeService;

const ANALOG_CONTROL_DEBOUNCE_MS = 350;

export class HejhomePlatformAccessory {
  private readonly capability: DeviceCapability;
  private analogControlTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnalogControlRequirements: Record<string, unknown> | null = null;
  private readonly pendingAnalogControlEvents = new Set<string>();

  constructor(
    private readonly platform: HejhomePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: HejDevice,
    private readonly client: HejRestClient | null,
  ) {
    this.accessory.context.device = device;
    this.capability = getDeviceCapability(device.deviceType) ?? {
      deviceType: device.deviceType,
      label: '지원 확인 필요',
      serviceKind: 'relay-switch',
      supportStatus: 'partial',
      homeKitServices: ['Switch'],
    };

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelName ?? device.deviceType)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);

    this.removeStaleBaseServices();
    this.configureServices();
    this.updateDevice(device);
  }

  updateDevice(device: HejDevice): void {
    this.accessory.context.device = device;
    switch (this.capability.serviceKind) {
      case 'color-light':
        this.updateColorLight(device);
        break;
      case 'white-light':
        this.updateWhiteLight(device);
        break;
      case 'multi-switch':
        this.updatePowerServices(device, this.switchPowerKeys(device), this.platform.Service.Switch);
        break;
      case 'relay-switch':
      case 'ir-switch':
        this.updatePowerService(device, 'power', this.platform.Service.Switch);
        break;
      case 'outlet':
        this.updateOutlet(device);
        break;
      case 'power-strip':
        this.updatePowerServices(device, this.powerStripKeys(device), this.platform.Service.Outlet);
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
      case 'ir-thermostat':
        this.updateThermostat(device);
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
  }

  private configureServices(): void {
    switch (this.capability.serviceKind) {
      case 'color-light':
        this.configureColorLight();
        break;
      case 'white-light':
        this.configureWhiteLight();
        break;
      case 'multi-switch':
        this.configurePowerServices(this.switchPowerKeys(this.device), this.platform.Service.Switch, '스위치');
        break;
      case 'relay-switch':
      case 'ir-switch':
        this.configurePowerService(this.platform.Service.Switch, 'power', this.device.name);
        break;
      case 'outlet':
        this.configureOutlet();
        break;
      case 'power-strip':
        this.configurePowerServices(this.powerStripKeys(this.device), this.platform.Service.Outlet, '콘센트');
        break;
      case 'window-covering':
        this.configureWindowCovering();
        break;
      case 'motion-sensor':
        this.service(this.platform.Service.MotionSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.MotionDetected)
          .onGet(() => readMotionState(this.currentDevice()));
        this.configureBatteryService();
        break;
      case 'contact-sensor':
        this.service(this.platform.Service.ContactSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.ContactSensorState)
          .onGet(() => readContactState(this.platform, this.currentDevice()));
        this.configureBatteryService();
        break;
      case 'temperature-humidity-sensor':
        this.service(this.platform.Service.TemperatureSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
          .onGet(() => readNumberState(this.currentDevice(), 'temperature', 0));
        this.service(this.platform.Service.HumiditySensor, `${this.device.name} 습도`)
          .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
          .onGet(() => readNumberState(this.currentDevice(), 'humidity', 0));
        this.configureBatteryService();
        break;
      case 'leak-sensor':
        this.service(this.platform.Service.LeakSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.LeakDetected)
          .onGet(() => readLeakState(this.platform, this.currentDevice()));
        this.configureBatteryService();
        break;
      case 'smoke-sensor':
        this.service(this.platform.Service.SmokeSensor, this.device.name)
          .getCharacteristic(this.platform.Characteristic.SmokeDetected)
          .onGet(() => readSmokeState(this.platform, this.currentDevice()));
        this.configureBatteryService();
        break;
      case 'stateless-button':
        this.configureSmartButton();
        this.configureBatteryService();
        break;
      case 'ir-thermostat':
        this.configureThermostat();
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
      .onGet(() => readPowerState(this.currentDevice()) ?? false)
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'on'));
    light.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => readHsvState(this.currentDevice()).brightness)
      .onSet((value) => this.handleColorLightBrightnessSet(Number(value)));
    light.getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(() => readHsvState(this.currentDevice()).hue)
      .onSet((value) => this.handleHsvSet({ hue: Number(value) }, true));
    light.getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(() => readHsvState(this.currentDevice()).saturation)
      .onSet((value) => this.handleSaturationSet(Number(value)));
  }

  private configureWhiteLight(): void {
    const light = this.service(this.platform.Service.Lightbulb, this.device.name);
    light.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => readPowerState(this.currentDevice()) ?? false)
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'white-light.on'));
    light.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(() => readNumberState(this.currentDevice(), 'brightness', 100))
      .onSet((value) => this.scheduleAnalogControlSet({ brightness: clampNumber(Number(value), 0, 100) }, 'white-light.brightness'));
    light.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onGet(() => temperaturePercentToMired(readNumberState(this.currentDevice(), 'temperature', 100)))
      .onSet((value) => this.scheduleAnalogControlSet({ temperature: miredToTemperaturePercent(Number(value)) }, 'white-light.temperature'));
  }

  private configurePowerServices(keys: PowerKey[], serviceType: ServiceType, label: string): void {
    keys.forEach((key, index) => {
      const name = keys.length === 1 ? this.device.name : `${this.device.name} ${label} ${index + 1}`;
      this.configurePowerService(serviceType, key, name, key);
    });
  }

  private configurePowerService(serviceType: ServiceType, key: PowerKey, name: string, subtype?: string): void {
    this.service(serviceType, name, subtype)
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => readPowerStateByKey(this.currentDevice(), key))
      .onSet((value) => this.handlePowerSet(key, Boolean(value)));
  }

  private configureOutlet(): void {
    const outlet = this.service(this.platform.Service.Outlet, this.device.name);
    outlet.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => readPowerState(this.currentDevice()) ?? false)
      .onSet((value) => this.handleControlSet({ power: Boolean(value) }, 'outlet.on'));
    outlet.getCharacteristic(this.platform.Characteristic.OutletInUse)
      .onGet(() => readPowerState(this.currentDevice()) ?? false);
  }

  private configureWindowCovering(): void {
    const covering = this.service(this.platform.Service.WindowCovering, this.device.name);
    covering.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => readPosition(this.currentDevice()));
    covering.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(() => readTargetPosition(this.currentDevice()))
      .onSet((value) => this.handleControlSet({ percentControl: clampNumber(Number(value), 0, 100) }, 'window-covering.target-position'));
    covering.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => readPositionState(this.platform, this.currentDevice()));
  }

  private configureSmartButton(): void {
    const service = this.service(this.platform.Service.StatelessProgrammableSwitch, this.device.name, 'button1');
    service.setCharacteristic(this.platform.Characteristic.ServiceLabelIndex, 1);
    service.getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .setProps?.({
        validValues: [
          this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
          this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
          this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
        ],
      });
  }

  private configureThermostat(): void {
    const thermostat = this.service(this.platform.Service.Thermostat, this.device.name);
    thermostat.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => readNumberState(this.currentDevice(), 'temperature', 23));
    thermostat.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(() => readNumberState(this.currentDevice(), 'temperature', 23))
      .onSet((value) => this.handleControlSet({ temperature: clampNumber(Number(value), 16, 30) }, 'thermostat.temperature'));
    thermostat.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => readCurrentHeatingCoolingState(this.platform, this.currentDevice()));
    thermostat.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(() => readTargetHeatingCoolingState(this.platform, this.currentDevice()))
      .onSet((value) => this.handleControlSet({ mode: String(value) }, 'thermostat.mode'));
  }

  private configureFan(): void {
    const fanService = this.service(this.fanServiceType(), this.device.name);
    fanService.getCharacteristic(this.platform.Characteristic.Active ?? this.platform.Characteristic.On)
      .onGet(() => readPowerState(this.currentDevice()) ? 1 : 0)
      .onSet((value) => this.handleControlSet({ power: Number(value) === 1 || value === true }, 'fan.active'));
  }

  private configureBatteryService(): void {
    const state = this.currentDevice().deviceState;
    if (state?.battery === undefined && !this.capability.homeKitServices.includes('BatteryService')) {
      return;
    }
    const battery = this.service(this.batteryServiceType(), `${this.device.name} 배터리`);
    battery.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => clampNumber(readNumberState(this.currentDevice(), 'battery', 100), 0, 100));
    battery.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() => readNumberState(this.currentDevice(), 'battery', 100) <= 20
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
      await this.client.controlDevice(this.device.id, requirements);
      const next = mergeDeviceState(this.currentDevice(), requirements);
      this.updateDevice(next);
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
    if (!this.client) {
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
    if (forceColorMode && currentDevice.deviceState?.lightMode !== 'COLOR') {
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
    service.updateCharacteristic(this.platform.Characteristic.On, readPowerStateByKey(device, key));
  }

  private updateOutlet(device: HejDevice): void {
    const outlet = this.accessory.getService(this.platform.Service.Outlet);
    if (!outlet) {
      return;
    }
    const power = readPowerState(device) ?? false;
    outlet.updateCharacteristic(this.platform.Characteristic.On, power);
    outlet.updateCharacteristic(this.platform.Characteristic.OutletInUse, power);
  }

  private updateWindowCovering(device: HejDevice): void {
    const covering = this.accessory.getService(this.platform.Service.WindowCovering);
    if (!covering) {
      return;
    }
    covering.updateCharacteristic(this.platform.Characteristic.CurrentPosition, readPosition(device));
    covering.updateCharacteristic(this.platform.Characteristic.TargetPosition, readTargetPosition(device));
    covering.updateCharacteristic(this.platform.Characteristic.PositionState, readPositionState(this.platform, device));
  }

  private updateMotionSensor(device: HejDevice): void {
    this.accessory.getService(this.platform.Service.MotionSensor)
      ?.updateCharacteristic(this.platform.Characteristic.MotionDetected, readMotionState(device));
  }

  private updateContactSensor(device: HejDevice): void {
    this.accessory.getService(this.platform.Service.ContactSensor)
      ?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, readContactState(this.platform, device));
  }

  private updateTemperatureHumiditySensor(device: HejDevice): void {
    this.accessory.getService(this.platform.Service.TemperatureSensor)
      ?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, readNumberState(device, 'temperature', 0));
    this.accessory.getService(this.platform.Service.HumiditySensor)
      ?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, readNumberState(device, 'humidity', 0));
  }

  private updateLeakSensor(device: HejDevice): void {
    this.accessory.getService(this.platform.Service.LeakSensor)
      ?.updateCharacteristic(this.platform.Characteristic.LeakDetected, readLeakState(this.platform, device));
  }

  private updateSmokeSensor(device: HejDevice): void {
    this.accessory.getService(this.platform.Service.SmokeSensor)
      ?.updateCharacteristic(this.platform.Characteristic.SmokeDetected, readSmokeState(this.platform, device));
  }

  private updateBatteryService(device: HejDevice): void {
    const battery = this.accessory.getService(this.batteryServiceType());
    if (!battery) {
      return;
    }
    const level = clampNumber(readNumberState(device, 'battery', 100), 0, 100);
    battery.updateCharacteristic(this.platform.Characteristic.BatteryLevel, level);
    battery.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      level <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private updateThermostat(device: HejDevice): void {
    const thermostat = this.accessory.getService(this.platform.Service.Thermostat);
    if (!thermostat) {
      return;
    }
    thermostat.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, readNumberState(device, 'temperature', 23));
    thermostat.updateCharacteristic(this.platform.Characteristic.TargetTemperature, readNumberState(device, 'temperature', 23));
    thermostat.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, readCurrentHeatingCoolingState(this.platform, device));
    thermostat.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, readTargetHeatingCoolingState(this.platform, device));
  }

  private updateFan(device: HejDevice): void {
    const fanServiceType = this.fanServiceType();
    const activeCharacteristic = this.platform.Characteristic.Active ?? this.platform.Characteristic.On;
    this.accessory.getService(fanServiceType)
      ?.updateCharacteristic(activeCharacteristic, readPowerState(device) ? 1 : 0);
  }

  private service(serviceType: ServiceType, name: string, subtype?: string): HomebridgeService {
    const service = subtype
      ? this.accessory.getServiceById?.(serviceType, subtype)
      : this.accessory.getService(serviceType);
    if (service) {
      return service;
    }
    const addService = this.accessory.addService as unknown as AddServiceByType;
    return subtype
      ? addService.call(this.accessory, serviceType, name, subtype)
      : addService.call(this.accessory, serviceType, name);
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

  private currentDevice(): HejDevice {
    return this.accessory.context.device as HejDevice;
  }

  private switchPowerKeys(device: HejDevice): PowerKey[] {
    const match = /(?:Zigbee)?Switch(\d+)/.exec(device.deviceType);
    const count = match?.[1] ? Number(match[1]) : countPowerKeys(device.deviceState);
    return powerKeys(Math.max(1, count));
  }

  private powerStripKeys(device: HejDevice): PowerKey[] {
    const count = Math.max(4, countPowerKeys(device.deviceState));
    return powerKeys(count).filter((key) => key !== 'power5');
  }

  private removeStaleBaseServices(): void {
    const desired = new Set(this.capability.homeKitServices);
    const stale = [
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
    }

    if (['multi-switch', 'power-strip'].includes(this.capability.serviceKind)) {
      const baseServiceType = this.capability.serviceKind === 'multi-switch'
        ? this.platform.Service.Switch
        : this.platform.Service.Outlet;
      const baseService = this.accessory.getService(baseServiceType);
      if (baseService) {
        this.accessory.removeService(baseService);
      }
    }
  }
}

function mergeDeviceState(device: HejDevice, patch: Record<string, unknown>): HejDevice {
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
  if (device.deviceState?.power !== undefined) {
    return Boolean(device.deviceState.power);
  }
  for (const key of powerKeys(6)) {
    if (device.deviceState?.[key] !== undefined) {
      return Boolean(device.deviceState[key]);
    }
  }
  return undefined;
}

function readPowerStateByKey(device: HejDevice, key: PowerKey): boolean {
  if (key === 'power') {
    return readPowerState(device) ?? false;
  }
  return Boolean(device.deviceState?.[key]);
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

function readPosition(device: HejDevice): number {
  return clampNumber(Number(device.deviceState?.percentState ?? device.deviceState?.percentControl ?? 0), 0, 100);
}

function readTargetPosition(device: HejDevice): number {
  return clampNumber(Number(device.deviceState?.percentControl ?? device.deviceState?.percentState ?? 0), 0, 100);
}

function readPositionState(platform: HejhomePlatform, device: HejDevice): number {
  const workState = String(device.deviceState?.workState ?? device.deviceState?.control ?? '').toLowerCase();
  if (workState.includes('open')) {
    return platform.Characteristic.PositionState.INCREASING;
  }
  if (workState.includes('close')) {
    return platform.Characteristic.PositionState.DECREASING;
  }
  return platform.Characteristic.PositionState.STOPPED;
}

function readCurrentHeatingCoolingState(platform: HejhomePlatform, device: HejDevice): number {
  const power = device.deviceState?.power as unknown;
  if (power === false || power === 'false' || power === '꺼짐') {
    return platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }
  return platform.Characteristic.CurrentHeatingCoolingState.COOL;
}

function readTargetHeatingCoolingState(platform: HejhomePlatform, device: HejDevice): number {
  const power = device.deviceState?.power as unknown;
  if (power === false || power === 'false' || power === '꺼짐') {
    return platform.Characteristic.TargetHeatingCoolingState.OFF;
  }
  const mode = Number(device.deviceState?.mode ?? 0);
  if (mode === 1) {
    return platform.Characteristic.TargetHeatingCoolingState.HEAT;
  }
  if (mode === 2) {
    return platform.Characteristic.TargetHeatingCoolingState.AUTO;
  }
  return platform.Characteristic.TargetHeatingCoolingState.COOL;
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
