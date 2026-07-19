import { describe, expect, test, vi } from 'vitest';

import type { CharacteristicValue, Service } from 'homebridge';

import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejRestClient } from '../src/hej/rest.js';
import type { HejhomePlatform } from '../src/platform.js';
import type { HejDevice } from '../src/types.js';

describe('HejhomePlatformAccessory', () => {
  test('exposes LightRgbw5 as a color light and sends Hej RGBW control payloads', async () => {
    vi.useFakeTimers();
    try {
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
      expect(client.controlDevice).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenNthCalledWith(2, 'light-1', {
        hsvColor: {
          hue: 120,
          saturation: 100,
          brightness: 30,
        },
      });
      expect((accessory.context.device as HejDevice).deviceState?.lightMode).toBe('COLOR');
      expect((accessory.context.device as HejDevice).deviceState?.hsvColor?.hue).toBe(120);

      await lightService?.characteristic('Brightness').setValue(44);
      expect(client.controlDevice).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenLastCalledWith('light-1', {
        hsvColor: {
          hue: 120,
          saturation: 100,
          brightness: 44,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('debounces rapid RGBW color brightness changes into one Hej request', async () => {
    vi.useFakeTimers();
    try {
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
          lightMode: 'COLOR',
          hsvColor: {
            hue: 120,
            saturation: 80,
            brightness: 30,
          },
        },
      });

      new HejhomePlatformAccessory(platform, accessory, device, client);

      const lightService = accessory.service('Lightbulb');
      await lightService?.characteristic('Brightness').setValue(40);
      await lightService?.characteristic('Brightness').setValue(55);
      await lightService?.characteristic('Brightness').setValue(70);

      expect(client.controlDevice).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenCalledTimes(1);
      expect(client.controlDevice).toHaveBeenCalledWith('light-1', {
        hsvColor: {
          hue: 120,
          saturation: 80,
          brightness: 70,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('treats HomeKit zero saturation as RGBW white mode and debounces white brightness', async () => {
    vi.useFakeTimers();
    try {
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
          lightMode: 'COLOR',
          hsvColor: {
            hue: 120,
            saturation: 80,
            brightness: 55,
          },
        },
      });

      new HejhomePlatformAccessory(platform, accessory, device, client);

      const lightService = accessory.service('Lightbulb');
      await lightService?.characteristic('Saturation').setValue(0);

      expect(client.controlDevice).toHaveBeenCalledTimes(1);
      expect(client.controlDevice).toHaveBeenCalledWith('light-1', { lightMode: 'white' });
      expect((accessory.context.device as HejDevice).deviceState?.lightMode).toBe('WHITE');
      await expect(lightService?.characteristic('Saturation').getValue()).resolves.toBe(0);

      await lightService?.characteristic('Brightness').setValue(72);
      expect(client.controlDevice).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenCalledTimes(2);
      expect(client.controlDevice).toHaveBeenLastCalledWith('light-1', { brightness: 72 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('switches RGBW white mode back to colour before sending debounced HSV color', async () => {
    vi.useFakeTimers();
    try {
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
          brightness: 64,
          hsvColor: {
            hue: 0,
            saturation: 0,
            brightness: 64,
          },
        },
      });

      new HejhomePlatformAccessory(platform, accessory, device, client);

      const lightService = accessory.service('Lightbulb');
      await lightService?.characteristic('Hue').setValue(240);

      expect(client.controlDevice).toHaveBeenCalledTimes(1);
      expect(client.controlDevice).toHaveBeenCalledWith('light-1', { lightMode: 'colour' });

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenCalledTimes(2);
      expect(client.controlDevice).toHaveBeenLastCalledWith('light-1', {
        hsvColor: {
          hue: 240,
          saturation: 100,
          brightness: 64,
        },
      });
    } finally {
      vi.useRealTimers();
    }
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

  test('exposes white lights with brightness and color temperature controls', async () => {
    vi.useFakeTimers();
    try {
      const platform = createPlatformMock();
      const accessory = createAccessoryMock('전구 (WW)', 'uuid:white-1', platform);
      const client = createClientMock();
      const device = deviceFixture({
        id: 'white-1',
        name: '전구 (WW)',
        deviceType: 'LightWw3',
        modelName: 'GKW-LB031-WW',
        deviceState: {
          power: true,
          brightness: 75,
          temperature: 100,
        },
      });

      new HejhomePlatformAccessory(platform, accessory, device, client);

      const lightService = accessory.service('Lightbulb');
      expect(lightService?.characteristics.has('On')).toBe(true);
      expect(lightService?.characteristics.has('Brightness')).toBe(true);
      expect(lightService?.characteristics.has('ColorTemperature')).toBe(true);

      await lightService?.characteristic('ColorTemperature').setValue(250);
      expect(client.controlDevice).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(client.controlDevice).toHaveBeenLastCalledWith('white-1', {
        temperature: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('controls RelayController devices with the observed power1 datapoint', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('렉 환풍기', 'uuid:relay-1', platform);
    const client = createClientMock();
    const device = deviceFixture({
      id: 'relay-1',
      name: '렉 환풍기',
      deviceType: 'RelayController',
      modelName: 'LKW-RC031',
      deviceState: {
        power1: false,
      },
    });

    new HejhomePlatformAccessory(platform, accessory, device, client);

    const relayService = accessory.service('Switch');
    await expect(relayService?.characteristic('On').getValue()).resolves.toBe(false);
    await relayService?.characteristic('On').setValue(true);

    expect(client.controlDevice).toHaveBeenCalledWith('relay-1', { power1: true });
  });

  test('exposes multi-gang switches as separate switch services', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('거실 스위치', 'uuid:switch-1', platform);
    const client = createClientMock();
    const device = deviceFixture({
      id: 'switch-1',
      name: '거실 스위치',
      deviceType: 'Switch4',
      deviceState: {
        power1: true,
        power2: false,
        power3: false,
        power4: true,
      },
    });

    new HejhomePlatformAccessory(platform, accessory, device, client);

    expect(accessory.serviceBySubtype('Switch', 'power1')).toBeDefined();
    expect(accessory.serviceBySubtype('Switch', 'power4')).toBeDefined();

    await accessory.serviceBySubtype('Switch', 'power3')?.characteristic('On').setValue(true);

    expect(client.controlDevice).toHaveBeenCalledWith('switch-1', { power3: true });
  });

  test('exposes curtain devices as window coverings', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('거실 커튼', 'uuid:curtain-1', platform);
    const client = createClientMock();
    const device = deviceFixture({
      id: 'curtain-1',
      name: '거실 커튼',
      deviceType: 'Curtain',
      deviceState: {
        percentState: 20,
        percentControl: 20,
        control: 'close',
      },
    });

    new HejhomePlatformAccessory(platform, accessory, device, client);

    const covering = accessory.service('WindowCovering');
    expect(covering?.characteristics.has('CurrentPosition')).toBe(true);
    expect(covering?.characteristics.has('TargetPosition')).toBe(true);
    expect(covering?.characteristics.has('PositionState')).toBe(true);

    await covering?.characteristic('TargetPosition').setValue(85);

    expect(client.controlDevice).toHaveBeenCalledWith('curtain-1', { percentControl: 85 });
  });

  test('exposes temperature and humidity sensors with battery service', async () => {
    const platform = createPlatformMock();
    const accessory = createAccessoryMock('온습도 센서', 'uuid:sensor-1', platform);
    const device = deviceFixture({
      id: 'sensor-1',
      name: '온습도 센서',
      deviceType: 'SensorTh2',
      deviceState: {
        temperature: 23,
        humidity: 55,
        battery: 77,
      },
    });

    new HejhomePlatformAccessory(platform, accessory, device, null);

    await expect(accessory.service('TemperatureSensor')?.characteristic('CurrentTemperature').getValue()).resolves.toBe(23);
    await expect(accessory.service('HumiditySensor')?.characteristic('CurrentRelativeHumidity').getValue()).resolves.toBe(55);
    await expect(accessory.service('BatteryService')?.characteristic('BatteryLevel').getValue()).resolves.toBe(77);
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
      BatteryService: 'BatteryService',
      ContactSensor: 'ContactSensor',
      Fanv2: 'Fanv2',
      HumiditySensor: 'HumiditySensor',
      LeakSensor: 'LeakSensor',
      Lightbulb: 'Lightbulb',
      MotionSensor: 'MotionSensor',
      Outlet: 'Outlet',
      SmokeSensor: 'SmokeSensor',
      StatelessProgrammableSwitch: 'StatelessProgrammableSwitch',
      Switch: 'Switch',
      TemperatureSensor: 'TemperatureSensor',
      Thermostat: 'Thermostat',
      WindowCovering: 'WindowCovering',
    },
    Characteristic: {
      Active: 'Active',
      BatteryLevel: 'BatteryLevel',
      Brightness: 'Brightness',
      ColorTemperature: 'ColorTemperature',
      ContactSensorState: Object.assign('ContactSensorState', {
        CONTACT_DETECTED: 0,
        CONTACT_NOT_DETECTED: 1,
      }),
      CurrentHeatingCoolingState: Object.assign('CurrentHeatingCoolingState', {
        OFF: 0,
        COOL: 2,
      }),
      CurrentPosition: 'CurrentPosition',
      CurrentRelativeHumidity: 'CurrentRelativeHumidity',
      CurrentTemperature: 'CurrentTemperature',
      Hue: 'Hue',
      LeakDetected: Object.assign('LeakDetected', {
        LEAK_DETECTED: 1,
        LEAK_NOT_DETECTED: 0,
      }),
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      MotionDetected: 'MotionDetected',
      Name: 'Name',
      On: 'On',
      OutletInUse: 'OutletInUse',
      PositionState: Object.assign('PositionState', {
        DECREASING: 0,
        INCREASING: 1,
        STOPPED: 2,
      }),
      ProgrammableSwitchEvent: Object.assign('ProgrammableSwitchEvent', {
        SINGLE_PRESS: 0,
        DOUBLE_PRESS: 1,
        LONG_PRESS: 2,
      }),
      Saturation: 'Saturation',
      SerialNumber: 'SerialNumber',
      ServiceLabelIndex: 'ServiceLabelIndex',
      SmokeDetected: Object.assign('SmokeDetected', {
        SMOKE_DETECTED: 1,
        SMOKE_NOT_DETECTED: 0,
      }),
      StatusLowBattery: Object.assign('StatusLowBattery', {
        BATTERY_LEVEL_NORMAL: 0,
        BATTERY_LEVEL_LOW: 1,
      }),
      TargetHeatingCoolingState: Object.assign('TargetHeatingCoolingState', {
        OFF: 0,
        HEAT: 1,
        COOL: 2,
        AUTO: 3,
      }),
      TargetPosition: 'TargetPosition',
      TargetTemperature: 'TargetTemperature',
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

  addService(type: string, name: string, subtype?: string): ServiceMock {
    const service = new ServiceMock(type, name, subtype);
    this.services.set(serviceKey(type, subtype), service);
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

  getServiceById(type: string, subtype: string): ServiceMock | undefined {
    return this.serviceBySubtype(type, subtype);
  }

  serviceBySubtype(type: string, subtype: string): ServiceMock | undefined {
    return this.services.get(serviceKey(type, subtype));
  }
}

class ServiceMock {
  public readonly characteristics = new Map<string, CharacteristicMock>();
  public readonly setValues: Array<{ characteristic: string; value: CharacteristicValue }> = [];
  public readonly updates: Array<{ characteristic: string; value: CharacteristicValue }> = [];

  constructor(
    public readonly type: string,
    public readonly name: string,
    public readonly subtype?: string,
  ) {}

  setCharacteristic(characteristic: string, value: CharacteristicValue): this {
    this.setValues.push({ characteristic: String(characteristic), value });
    return this;
  }

  getCharacteristic(characteristic: string): CharacteristicMock {
    return this.characteristic(String(characteristic));
  }

  updateCharacteristic(characteristic: string, value: CharacteristicValue): this {
    this.updates.push({ characteristic: String(characteristic), value });
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

function serviceKey(type: string, subtype?: string): string {
  return subtype ? `${type}:${subtype}` : type;
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
