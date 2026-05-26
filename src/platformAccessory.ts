import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { HejRestClient } from './hej/rest.js';
import type { HejhomePlatform } from './platform.js';
import type { HejDevice } from './types.js';

export class HejhomePlatformAccessory {
  private readonly service: Service;

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

    this.service = this.getPrimaryService();
    this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));
  }

  updateDevice(device: HejDevice): void {
    this.accessory.context.device = device;
    const value = readPowerState(device);
    if (value !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, value);
    }
  }

  private getPrimaryService(): Service {
    const serviceType = isLightDevice(this.device)
      ? this.platform.Service.Lightbulb
      : this.platform.Service.Switch;

    return this.accessory.getService(serviceType)
      ?? this.accessory.addService(serviceType, this.device.name);
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
}

function isLightDevice(device: HejDevice): boolean {
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
