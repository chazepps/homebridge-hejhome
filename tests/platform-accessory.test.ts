import { describe, expect, test, vi } from 'vitest';

import type { CharacteristicValue, Service } from 'homebridge';

import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejRestClient } from '../src/hej/rest.js';
import type { HejhomePlatform } from '../src/platform.js';
import type { HejDevice } from '../src/types.js';

describe('HejhomePlatformAccessory', () => {
  test('exposes LightRgbw5 as a color light and sends Hej RGBW control payloads', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('거실 스탠드', 'uuid:light-1', platform);
    const client = createClientMock();
    const device = deviceFixture({
      id: 'light-1',
      name: '거실 스탠드',
      deviceType: 'LightRgbw5',
      modelName: 'GKW-MD081',
      deviceState: {
        power: true,
        lightMode: 'WHITE',
        hsvColor: {
          hue: 10,
          saturation: 20,
          brightness: 30,
        },
        brightness: 30,
      },
    });

    new HejhomePlatformAccessory(platform, accessory, device, client);

    const lightService = accessory.service('Lightbulb');
    expect(lightService).toBeDefined();
    expect(accessory.service('Switch')).toBeUndefined();
    expect(lightService?.characteristics.has('On')).toBe(true);
    expect(lightService?.characteristics.has('Brightness')).toBe(true);
    expect(lightService?.characteristics.has('Hue')).toBe(true);
    expect(lightService?.characteristics.has('Saturation')).toBe(true);

    await lightService?.characteristic('Hue').setValue(120);

    expect(client.controlDevice).toHaveBeenNthCalledWith(1, 'light-1', { lightMode: 'colour' });
    expect(client.controlDevice).toHaveBeenNthCalledWith(2, 'light-1', {
      hsvColor: {
        hue: 120,
        saturation: 20,
        brightness: 30,
      },
    });
    expect((accessory.context.device as HejDevice).deviceState?.lightMode).toBe('COLOR');
    expect((accessory.context.device as HejDevice).deviceState?.hsvColor?.hue).toBe(120);

    await lightService?.characteristic('Brightness').setValue(44);

    expect(client.controlDevice).toHaveBeenLastCalledWith('light-1', {
      hsvColor: {
        hue: 120,
        saturation: 20,
        brightness: 44,
      },
    });
  });

  test('exposes SensorMo as a motion sensor and updates MotionDetected from device state', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('모션 센서', 'uuid:motion-1', platform);
    accessory.addService('Switch', 'legacy switch');
    const device = deviceFixture({
      id: 'motion-1',
      name: '모션 센서',
      deviceType: 'SensorMo',
      modelName: 'GKZ-MO021',
      deviceState: {
        battery: 74,
        motionDetected: false,
      },
    });

    const handler = new HejhomePlatformAccessory(platform, accessory, device, null);

    const motionService = accessory.service('MotionSensor');
    expect(motionService).toBeDefined();
    expect(accessory.service('Switch')).toBeUndefined();
    await expect(motionService?.characteristic('MotionDetected').getValue()).resolves.toBe(false);

    handler.updateDevice({
      ...device,
      deviceState: {
        battery: 74,
        motionDetected: true,
      },
    });

    expect(motionService?.updates).toContainEqual({
      characteristic: 'MotionDetected',
      value: true,
    });
  });
});

function createPlatformMock(): HejhomePlatform {
  const hapStatusError = class HapStatusError extends Error {
    constructor(public readonly status: number) {
      super(`HAP status ${status}`);
    }
  };

  return {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      Lightbulb: 'Lightbulb',
      MotionSensor: 'MotionSensor',
      Switch: 'Switch',
    },
    Characteristic: {
      BatteryLevel: 'BatteryLevel',
      Brightness: 'Brightness',
      Hue: 'Hue',
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      MotionDetected: 'MotionDetected',
      Name: 'Name',
      On: 'On',
      Saturation: 'Saturation',
      SerialNumber: 'SerialNumber',
    },
    api: {
      hap: {
        HapStatusError: hapStatusError,
        HAPStatus: {
          SERVICE_COMMUNICATION_FAILURE: -70402,
        },
      },
    },
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as HejhomePlatform;
}

function createClientMock(): HejRestClient {
  return {
    controlDevice: vi.fn(async () => undefined),
  } as unknown as HejRestClient;
}

function createAccessoryMock(displayName: string, uuid: string, platform: HejhomePlatform): AccessoryMock {
  const accessory = new AccessoryMock(displayName, uuid);
  accessory.addService(platform.Service.AccessoryInformation, 'Accessory Information');
  return accessory;
}

function deviceFixture(overrides: Partial<HejDevice>): HejDevice {
  return {
    id: 'device-1',
    name: 'Device',
    deviceType: 'ZigbeeSwitch1',
    deviceState: {},
    ...overrides,
  };
}

class AccessoryMock {
  public context: Record<string, unknown> = {};
  private readonly services = new Map<string, ServiceMock>();

  constructor(
    public readonly displayName: string,
    public readonly UUID: string,
  ) {}

  getService(type: string): ServiceMock | undefined {
    return this.services.get(type);
  }

  addService(type: string, name: string): ServiceMock {
    const service = new ServiceMock(type, name);
    this.services.set(type, service);
    return service;
  }

  removeService(service: Service): void {
    for (const [type, current] of this.services) {
      if (current === service) {
        this.services.delete(type);
      }
    }
  }

  service(type: string): ServiceMock | undefined {
    return this.services.get(type);
  }
}

class ServiceMock {
  public readonly characteristics = new Map<string, CharacteristicMock>();
  public readonly setValues: Array<{ characteristic: string; value: CharacteristicValue }> = [];
  public readonly updates: Array<{ characteristic: string; value: CharacteristicValue }> = [];

  constructor(
    public readonly type: string,
    public readonly name: string,
  ) {}

  setCharacteristic(characteristic: string, value: CharacteristicValue): this {
    this.setValues.push({ characteristic, value });
    return this;
  }

  getCharacteristic(characteristic: string): CharacteristicMock {
    return this.characteristic(characteristic);
  }

  updateCharacteristic(characteristic: string, value: CharacteristicValue): this {
    this.updates.push({ characteristic, value });
    return this;
  }

  characteristic(characteristic: string): CharacteristicMock {
    const current = this.characteristics.get(characteristic);
    if (current) {
      return current;
    }
    const next = new CharacteristicMock(characteristic);
    this.characteristics.set(characteristic, next);
    return next;
  }
}

class CharacteristicMock {
  private getHandler: (() => CharacteristicValue | Promise<CharacteristicValue>) | null = null;
  private setHandler: ((value: CharacteristicValue) => void | Promise<void>) | null = null;

  constructor(public readonly name: string) {}

  onGet(handler: () => CharacteristicValue | Promise<CharacteristicValue>): this {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: (value: CharacteristicValue) => void | Promise<void>): this {
    this.setHandler = handler;
    return this;
  }

  async getValue(): Promise<CharacteristicValue> {
    if (!this.getHandler) {
      throw new Error(`Missing onGet handler for ${this.name}`);
    }
    return await this.getHandler();
  }

  async setValue(value: CharacteristicValue): Promise<void> {
    if (!this.setHandler) {
      throw new Error(`Missing onSet handler for ${this.name}`);
    }
    await this.setHandler(value);
  }
}
