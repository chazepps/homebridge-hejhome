import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { HejRestClient } from './hej/rest.js';
import type { HejhomePlatform } from './platform.js';
import type { HejDevice } from './types.js';

export class HejhomePlatformAccessory {
  private readonly service: Service;
  private readonly serviceKind: 'color-light' | 'motion-sensor' | 'switch';

  constructor(
    private readonly platform: HejhomePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: HejDevice,
    private readonly client: HejRestClient | null,
  ) {
    this.accessory.context.device = device;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(this.platform.Characteristic.Model, device.modelName ?? device.deviceType)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.id);

    this.serviceKind = getServiceKind(device);
    this.removeStaleServices();
    this.service = this.getPrimaryService();
    this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

    if (this.serviceKind === 'motion-sensor') {
      this.service.getCharacteristic(this.platform.Characteristic.MotionDetected)
        .onGet(this.handleMotionGet.bind(this));
    } else {
      this.service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleOnGet.bind(this))
        .onSet(this.handleOnSet.bind(this));

      if (this.serviceKind === 'color-light') {
        this.service.getCharacteristic(this.platform.Characteristic.Brightness)
          .onGet(this.handleBrightnessGet.bind(this))
          .onSet(this.handleBrightnessSet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.Hue)
          .onGet(this.handleHueGet.bind(this))
          .onSet(this.handleHueSet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.Saturation)
          .onGet(this.handleSaturationGet.bind(this))
          .onSet(this.handleSaturationSet.bind(this));
      }
    }
  }

  updateDevice(device: HejDevice): void {
    this.accessory.context.device = device;
    if (this.serviceKind === 'motion-sensor') {
      this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, readMotionState(device));
      return;
    }

    const powerValue = readPowerState(device);
    if (powerValue !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, powerValue);
    }

    if (this.serviceKind === 'color-light') {
      const hsv = readHsvState(device);
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, hsv.brightness);
      this.service.updateCharacteristic(this.platform.Characteristic.Hue, hsv.hue);
      this.service.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.saturation);
    }
  }

  private getPrimaryService(): Service {
    const serviceType = this.serviceKind === 'motion-sensor'
      ? this.platform.Service.MotionSensor
      : this.serviceKind === 'color-light'
        ? this.platform.Service.Lightbulb
        : this.platform.Service.Switch;

    return this.accessory.getService(serviceType)
      ?? this.accessory.addService(serviceType, this.device.name);
  }

  private removeStaleServices(): void {
    const staleServiceTypes = this.serviceKind === 'motion-sensor'
      ? [this.platform.Service.Lightbulb, this.platform.Service.Switch]
      : this.serviceKind === 'color-light'
        ? [this.platform.Service.MotionSensor, this.platform.Service.Switch]
        : [this.platform.Service.Lightbulb, this.platform.Service.MotionSensor];

    for (const serviceType of staleServiceTypes) {
      const service = this.accessory.getService(serviceType);
      if (service) {
        this.accessory.removeService(service);
      }
    }
  }

  private async handleOnGet(): Promise<CharacteristicValue> {
    const value = readPowerState(this.accessory.context.device as HejDevice) ?? false;
    this.platform.debug('accessory.on.get', {
      deviceId: this.device.id,
      name: this.device.name,
      value,
    });
    return value;
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    if (!this.client) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const powerKey = primaryPowerKey(this.device);
    const nextValue = Boolean(value);
    this.platform.info('accessory.on.set.requested', {
      deviceId: this.device.id,
      name: this.device.name,
      powerKey,
      value: nextValue,
    });
    try {
      await this.client.controlDevice(this.device.id, { [powerKey]: nextValue });
      const nextDevice = {
        ...(this.accessory.context.device as HejDevice),
        deviceState: {
          ...((this.accessory.context.device as HejDevice).deviceState ?? {}),
          [powerKey]: nextValue,
        },
      };
      this.updateDevice(nextDevice);
      this.platform.info('accessory.on.set.succeeded', {
        deviceId: this.device.id,
        name: this.device.name,
        powerKey,
        value: nextValue,
      });
    } catch (error) {
      this.platform.error('accessory.on.set.failed', {
        deviceId: this.device.id,
        name: this.device.name,
        powerKey,
        value: nextValue,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handleBrightnessGet(): Promise<CharacteristicValue> {
    const value = readHsvState(this.accessory.context.device as HejDevice).brightness;
    this.platform.debug('accessory.brightness.get', {
      deviceId: this.device.id,
      name: this.device.name,
      value,
    });
    return value;
  }

  private async handleBrightnessSet(value: CharacteristicValue): Promise<void> {
    await this.handleHsvSet({ brightness: Number(value) }, false);
  }

  private async handleHueGet(): Promise<CharacteristicValue> {
    const value = readHsvState(this.accessory.context.device as HejDevice).hue;
    this.platform.debug('accessory.hue.get', {
      deviceId: this.device.id,
      name: this.device.name,
      value,
    });
    return value;
  }

  private async handleHueSet(value: CharacteristicValue): Promise<void> {
    await this.handleHsvSet({ hue: Number(value) }, true);
  }

  private async handleSaturationGet(): Promise<CharacteristicValue> {
    const value = readHsvState(this.accessory.context.device as HejDevice).saturation;
    this.platform.debug('accessory.saturation.get', {
      deviceId: this.device.id,
      name: this.device.name,
      value,
    });
    return value;
  }

  private async handleSaturationSet(value: CharacteristicValue): Promise<void> {
    await this.handleHsvSet({ saturation: Number(value) }, true);
  }

  private async handleHsvSet(
    partial: Partial<{ hue: number; saturation: number; brightness: number }>,
    forceColorMode: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const currentDevice = this.accessory.context.device as HejDevice;
    const nextHsv = {
      ...readHsvState(currentDevice),
      ...partial,
    };
    this.platform.info('accessory.hsv.set.requested', {
      deviceId: this.device.id,
      name: this.device.name,
      forceColorMode,
      stateKeys: Object.keys(partial),
      value: nextHsv,
    });

    try {
      if (forceColorMode && currentDevice.deviceState?.lightMode !== 'COLOR') {
        await this.client.controlDevice(this.device.id, { lightMode: 'colour' });
      }
      await this.client.controlDevice(this.device.id, { hsvColor: nextHsv });
      const nextDeviceState = {
        ...(currentDevice.deviceState ?? {}),
        hsvColor: nextHsv,
        brightness: nextHsv.brightness,
      };
      if (forceColorMode) {
        nextDeviceState.lightMode = 'COLOR' as const;
      }
      const nextDevice = {
        ...currentDevice,
        deviceState: nextDeviceState,
      };
      this.updateDevice(nextDevice);
      this.platform.info('accessory.hsv.set.succeeded', {
        deviceId: this.device.id,
        name: this.device.name,
        stateKeys: Object.keys(partial),
        value: nextHsv,
      });
    } catch (error) {
      this.platform.error('accessory.hsv.set.failed', {
        deviceId: this.device.id,
        name: this.device.name,
        stateKeys: Object.keys(partial),
        value: nextHsv,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handleMotionGet(): Promise<CharacteristicValue> {
    const value = readMotionState(this.accessory.context.device as HejDevice);
    this.platform.debug('accessory.motion.get', {
      deviceId: this.device.id,
      name: this.device.name,
      value,
    });
    return value;
  }
}

function getServiceKind(device: HejDevice): 'color-light' | 'motion-sensor' | 'switch' {
  if (device.deviceType === 'SensorMo') {
    return 'motion-sensor';
  }
  if (isColorLightDevice(device)) {
    return 'color-light';
  }
  return 'switch';
}

function isColorLightDevice(device: HejDevice): boolean {
  return ['LightRgbw5', 'LedStripRgbw2'].includes(device.deviceType);
}

function primaryPowerKey(device: HejDevice): string {
  if (device.deviceState?.power1 !== undefined) {
    return 'power1';
  }
  if (device.deviceState?.power2 !== undefined) {
    return 'power2';
  }
  return 'power';
}

function readPowerState(device: HejDevice): boolean | undefined {
  if (device.deviceState?.power !== undefined) {
    return device.deviceState.power;
  }
  if (device.deviceState?.power1 !== undefined) {
    return device.deviceState.power1;
  }
  if (device.deviceState?.power2 !== undefined) {
    return device.deviceState.power2;
  }
  return undefined;
}

function readHsvState(device: HejDevice): { hue: number; saturation: number; brightness: number } {
  return {
    hue: clampNumber(device.deviceState?.hsvColor?.hue ?? 0, 0, 360),
    saturation: clampNumber(device.deviceState?.hsvColor?.saturation ?? 0, 0, 100),
    brightness: clampNumber(device.deviceState?.hsvColor?.brightness ?? device.deviceState?.brightness ?? 100, 0, 100),
  };
}

function readMotionState(device: HejDevice): boolean {
  return Boolean(device.deviceState?.motionDetected);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}
