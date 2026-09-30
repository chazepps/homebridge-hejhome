import { describe, expect, test, vi } from 'vitest';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejhomePlatform } from '../src/platform.js';
import type { AdaptiveLightingController } from 'homebridge';
import type { HejDevice } from '../src/types.js';

function fixture(deviceType = 'IrTv', adaptiveLighting = false) {
  const api = new HomebridgeAPI();
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features: { adaptiveLighting }, info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as HejhomePlatform;
  const device: HejDevice = { id: 'test-device', name: 'Device', deviceType,
    deviceState: deviceType === 'LightWw1' ? { power: true, brightness: 50, temperature: 50 } : {} };
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  const client = { controlDevice: vi.fn().mockResolvedValue(undefined) };
  const handler = new HejhomePlatformAccessory(platform, accessory, device, client as never);
  return { api, platform, accessory, handler, client };
}

describe('real HAP lifecycle', () => {
  test('unknown devices never receive generic relay controls and cached switches are removed', () => {
    for (const deviceType of ['UnknownDevice', 'IrUnknownDevice']) {
      const { api, platform, accessory, handler, client } = fixture(deviceType);
      expect(accessory.getService(api.hap.Service.Switch)).toBeUndefined();
      handler.dispose();
      const legacy = accessory.addService(api.hap.Service.Switch, 'Legacy relay');
      legacy.getCharacteristic(api.hap.Characteristic.On).updateValue(true);
      const restored = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
      expect(accessory.getService(api.hap.Service.Switch)).toBeUndefined();
      expect(accessory.services).toHaveLength(1);
      expect(client.controlDevice).not.toHaveBeenCalled();
      restored.dispose();
    }
  });

  test('resets the cached momentary switch after HAP completes each write', async () => {
    const { api, accessory, handler, client } = fixture();
    const on = accessory.getService(api.hap.Service.Switch)!.getCharacteristic(api.hap.Characteristic.On);
    const values: unknown[] = [];
    on.on('change', (event) => values.push(event.newValue));
    for (let click = 0; click < 2; click++) {
      await on.handleSetRequest(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(on.value).toBe(false);
      expect(values.at(-1)).toBe(false);
    }
    expect(client.controlDevice).toHaveBeenCalledTimes(2);
    handler.dispose();
  });

  test('preserves newer reported state after a slow control write resolves', async () => {
    const { api, platform, accessory, handler } = fixture('RelayController');
    handler.updateDevice({ ...accessory.context.device, deviceState: { power1: false } });
    let complete!: () => void;
    Object.assign(platform, { controlDevice: () => new Promise<void>((resolve) => {
      complete = resolve;
    }) });
    const on = accessory.getService(api.hap.Service.Switch)!.getCharacteristic(api.hap.Characteristic.On);
    const write = on.handleSetRequest(true);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    // The runtime receives newer MQTT state and refuses to overwrite it with the old command ACK.
    handler.updateDevice({ ...accessory.context.device, deviceState: { power1: false } });
    complete();
    await write;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(on.value).toBe(false);
    handler.dispose();
  });

  test('shutdown retains serialized active schedule, actual removal purges it', () => {
    const { accessory, handler } = fixture('LightWw1', true);
    // Exercise real HAP serialization/storage and removal semantics, without waiting for HomeKit pairing.
    const internal = accessory as unknown as { _associatedHAPAccessory: {
      controllers: Record<string, { controller: AdaptiveLightingController }>;
      controllerStorage: { handleStateChange(controller: unknown): void; controllerData: Record<string, unknown> };
    } };
    const hap = internal._associatedHAPAccessory;
    const controller = Object.values(hap.controllers)[0]!.controller;
    const schedule = { activeTransition: {
      iid: 10, brightnessCharacteristicIID: 11, transitionStartMillis: Date.now(), timeMillisOffset: 0,
      transitionId: '00000000-0000-4000-8000-000000000001', transitionStartBuffer: '0000000000000000',
      brightnessAdjustmentRange: { minBrightnessValue: 0, maxBrightnessValue: 100 },
      transitionCurve: [
        { temperature: 220, brightnessAdjustmentFactor: 0, transitionTime: 0 },
        { temperature: 300, brightnessAdjustmentFactor: 0, transitionTime: 86400000 },
      ], updateInterval: 60000, notifyIntervalThreshold: 600000,
    } };
    controller.deserialize(schedule);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    hap.controllerStorage.handleStateChange(controller);
    const before = structuredClone(hap.controllerStorage.controllerData);
    handler.dispose('shutdown');
    expect(hap.controllerStorage.controllerData).toEqual(before);
    expect(Object.keys(hap.controllers)).toHaveLength(1);
    const restored = fixture('LightWw1', true);
    const restoredHap = (restored.accessory as unknown as typeof internal)._associatedHAPAccessory;
    const restoredController = Object.values(restoredHap.controllers)[0]!.controller;
    const saved = Object.values(before)[0] as { data: Parameters<AdaptiveLightingController['deserialize']>[0] };
    restoredController.deserialize(saved.data);
    expect(restoredController.isAdaptiveLightingActive()).toBe(true);
    expect(restoredController.serialize()).toEqual(schedule);
    restored.handler.dispose('removal');
    accessory.removeController(controller as never);
    expect(hap.controllerStorage.controllerData).toEqual({});
  });
});

test('native RGBW writes leave scenes, serialize mode changes, and keep color brightness when selecting white', async () => {
  vi.useFakeTimers();
  const { api, accessory, handler, client } = fixture('LightRgbw5');
  try {
    handler.updateDevice({ ...accessory.context.device, deviceState: { power: true, lightMode: 'SCENE', brightness: 20,
      hsvColor: { hue: 30, saturation: 60, brightness: 70 } } });
    const light = accessory.getService(api.hap.Service.Lightbulb)!;
    expect(light.testCharacteristic(api.hap.Characteristic.ColorTemperature)).toBe(false);
    await Promise.all([
      light.getCharacteristic(api.hap.Characteristic.Hue).handleSetRequest(240),
      light.getCharacteristic(api.hap.Characteristic.Saturation).handleSetRequest(75),
    ]);
    await vi.advanceTimersByTimeAsync(400);
    expect(client.controlDevice).toHaveBeenCalledTimes(2);
    expect(client.controlDevice).toHaveBeenNthCalledWith(1, 'test-device', { lightMode: 'colour' });
    expect(client.controlDevice).toHaveBeenLastCalledWith('test-device', { hsvColor: { hue: 240, saturation: 75, brightness: 70 } });
    await light.getCharacteristic(api.hap.Characteristic.Saturation).handleSetRequest(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(client.controlDevice).toHaveBeenLastCalledWith('test-device', { brightness: 70 });
    expect(light.getCharacteristic(api.hap.Characteristic.Brightness).value).toBe(70);
    expect(light.getCharacteristic(api.hap.Characteristic.Saturation).value).toBe(0);
  } finally {
    handler.dispose();
    vi.useRealTimers();
  }
});

test('native white light temperature endpoints use only the documented white-light range', async () => {
  vi.useFakeTimers();
  const { api, accessory, handler, client } = fixture('LightWw1');
  try {
    const temperature = accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.ColorTemperature);
    expect(temperature.props.minValue).toBe(154);
    expect(temperature.props.maxValue).toBe(333);
    await temperature.handleSetRequest(333);
    await vi.advanceTimersByTimeAsync(400);
    expect(client.controlDevice).toHaveBeenLastCalledWith('test-device', { temperature: 0 });
    await temperature.handleSetRequest(154);
    await vi.advanceTimersByTimeAsync(400);
    expect(client.controlDevice).toHaveBeenLastCalledWith('test-device', { temperature: 100 });
  } finally {
    handler.dispose();
    vi.useRealTimers();
  }
});

test('remote button opt-in preserves the base power switch and stable cached button subtypes', async () => {
  const { api, platform, accessory, handler, client } = fixture('IrTv');
  handler.dispose();
  accessory.removeService(accessory.getService(api.hap.Service.Switch)!);
  const cachedVolume = accessory.addService(api.hap.Service.Switch, 'Cached volume', 'remote-volume-up');
  const remote = vi.fn().mockResolvedValue(undefined);
  Object.assign(platform, { features: { devices: { 'test-device': { remoteButtons: true } } }, controlRemoteButton: remote });
  const enabled = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
  const base = accessory.services.find((service) => service.UUID === api.hap.Service.Switch.UUID && !service.subtype);
  expect(base).toBeDefined();
  expect(accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')).toBe(cachedVolume);
  expect(accessory.services.filter((service) => service.subtype?.startsWith('remote-'))).toHaveLength(6);
  await cachedVolume.getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(remote).toHaveBeenCalledExactlyOnceWith('test-device', { type: 'volume', direction: 'up' });
  expect(client.controlDevice).not.toHaveBeenCalled();
  expect(cachedVolume.getCharacteristic(api.hap.Characteristic.On).value).toBe(false);
  enabled.dispose();
  Object.assign(platform, { features: { devices: { 'test-device': { remoteButtons: false } } } });
  const disabled = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
  expect(accessory.services.filter((service) => service.subtype?.startsWith('remote-'))).toHaveLength(0);
  expect(accessory.services).toContain(base);
  disabled.dispose();
});

test('fan power-feedback shape changes keep remote button identities on the same accessory', () => {
  const { api, platform, accessory, handler, client } = fixture('IrFan');
  handler.dispose();
  Object.assign(platform, { features: { devices: { 'test-device': { remoteButtons: true } } },
    controlRemoteButton: vi.fn().mockResolvedValue(undefined) });
  const pulse = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
  const button = accessory.getServiceById(api.hap.Service.Switch, 'remote-fan-speed');
  expect(button).toBeDefined();
  pulse.dispose();
  const knownDevice = { ...accessory.context.device, deviceState: { power: true } };
  const known = new HejhomePlatformAccessory(platform, accessory, knownDevice, client as never);
  expect(accessory.getService(api.hap.Service.Fanv2)).toBeDefined();
  expect(accessory.services.some((service) => service.UUID === api.hap.Service.Switch.UUID && !service.subtype)).toBe(false);
  expect(accessory.getServiceById(api.hap.Service.Switch, 'remote-fan-speed')).toBe(button);
  known.dispose();
  const unknown = new HejhomePlatformAccessory(platform, accessory, { ...knownDevice, deviceState: {} }, client as never);
  expect(accessory.getService(api.hap.Service.Fanv2)).toBeUndefined();
  expect(accessory.services.some((service) => service.UUID === api.hap.Service.Switch.UUID && !service.subtype)).toBe(true);
  expect(accessory.getServiceById(api.hap.Service.Switch, 'remote-fan-speed')).toBe(button);
  expect(accessory.services.filter((service) => service.subtype?.startsWith('remote-'))).toHaveLength(2);
  unknown.dispose();
});

test('opt-in calibrated PM2.5 is read-only, unknown on invalid or stale data, and removable without changing power', async () => {
  const { api, platform, accessory, handler, client } = fixture('Airpurifier');
  expect(accessory.getService(api.hap.Service.AirQualitySensor)).toBeUndefined();
  const powerService = accessory.getService(api.hap.Service.Switch)!;
  handler.dispose();
  let fresh = true;
  Object.assign(platform, { features: { devices: { 'test-device': { pm25Multiplier: 0.1 } } },
    getMeasurementHealth: () => ({ reachable: fresh, reason: fresh ? 'available' : 'measurement-stale' }) });
  const enabled = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
  const air = accessory.getService(api.hap.Service.AirQualitySensor)!;
  expect(air).toBeDefined();
  const density = air.getCharacteristic(api.hap.Characteristic.PM2_5Density);
  expect(density.props.perms).not.toContain('pw');
  await expect(density.handleGetRequest()).rejects.toBe(-70402);
  for (const raw of [null, 'invalid', -1, Infinity, 10001]) {
    enabled.updateDevice({ ...accessory.context.device, deviceState: { power: true, pm25: raw } });
    await expect(density.handleGetRequest()).rejects.toBe(-70402);
    await expect(air.getCharacteristic(api.hap.Characteristic.StatusFault).handleGetRequest()).resolves.toBe(1);
  }
  for (const [raw, value] of [[0, 0], [35, 3.5], [10000, 1000]]) {
    enabled.updateDevice({ ...accessory.context.device, deviceState: { power: true, pm25: raw } });
    await expect(density.handleGetRequest()).resolves.toBe(value);
    await expect(air.getCharacteristic(api.hap.Characteristic.AirQuality).handleGetRequest()).resolves.toBe(0);
    await expect(air.getCharacteristic(api.hap.Characteristic.StatusFault).handleGetRequest()).resolves.toBe(0);
  }
  fresh = false;
  enabled.updateDevice(accessory.context.device);
  await expect(density.handleGetRequest()).rejects.toBe(-70402);
  await expect(air.getCharacteristic(api.hap.Characteristic.StatusFault).handleGetRequest()).resolves.toBe(1);
  enabled.dispose();
  Object.assign(platform, { features: { devices: {} } });
  const disabled = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
  expect(accessory.getService(api.hap.Service.AirQualitySensor)).toBeUndefined();
  expect(accessory.getService(api.hap.Service.Switch)).toBe(powerService);
  expect(client.controlDevice).not.toHaveBeenCalled();
  disabled.dispose();
});

test('base IR power cannot stay on when disposal races its command or reset tick', async () => {
  const pendingFixture = fixture('IrTv');
  let complete!: () => void;
  pendingFixture.client.controlDevice.mockImplementationOnce(() => new Promise<void>((resolve) => {
    complete = resolve;
  }));
  const on = pendingFixture.accessory.getService(pendingFixture.api.hap.Service.Switch)!
    .getCharacteristic(pendingFixture.api.hap.Characteristic.On);
  const pending = on.handleSetRequest(true);
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  pendingFixture.handler.dispose();
  complete();
  await expect(pending).rejects.toBeDefined();
  expect(on.value).toBe(false);

  vi.useFakeTimers();
  try {
    const completed = fixture('IrTv');
    const power = completed.accessory.getService(completed.api.hap.Service.Switch)!.getCharacteristic(completed.api.hap.Characteristic.On);
    await power.handleSetRequest(true);
    completed.handler.dispose();
    await vi.runAllTimersAsync();
    expect(power.value).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('mode-only echoes do not replace the brightness carried between white and color modes', async () => {
  vi.useFakeTimers();
  try {
    for (const colorToWhite of [false, true]) {
      const { api, accessory, handler, client } = fixture('LightRgbw5');
      handler.updateDevice({ ...accessory.context.device, deviceState: { power: true,
        lightMode: colorToWhite ? 'COLOR' : 'WHITE', brightness: colorToWhite ? 20 : 64,
        hsvColor: { hue: 30, saturation: 60, brightness: colorToWhite ? 70 : 30 } } });
      client.controlDevice.mockImplementationOnce(async () => {
        const patch = { lightMode: colorToWhite ? 'WHITE' : 'COLOR' } as const;
        handler.observeExternal(patch);
        handler.updateDevice({ ...accessory.context.device, deviceState: { ...accessory.context.device.deviceState, ...patch } });
      });
      const light = accessory.getService(api.hap.Service.Lightbulb)!;
      await light.getCharacteristic(colorToWhite ? api.hap.Characteristic.Saturation : api.hap.Characteristic.Hue)
        .handleSetRequest(colorToWhite ? 0 : 80);
      await vi.advanceTimersByTimeAsync(400);
      expect(client.controlDevice).toHaveBeenLastCalledWith('test-device', colorToWhite
        ? { brightness: 70 } : { hsvColor: { hue: 80, saturation: 100, brightness: 64 } });
      handler.dispose();
    }
  } finally {
    vi.useRealTimers();
  }
});

test('legacy purifier role overrides cannot turn its power service into a light or outlet', async () => {
  for (const role of ['light', 'outlet']) {
    const { api, platform, accessory, handler, client } = fixture('Airpurifier');
    const originalPower = accessory.getService(api.hap.Service.Switch)!;
    handler.dispose();
    accessory.addService(role === 'light' ? api.hap.Service.Lightbulb : api.hap.Service.Outlet, 'Legacy role');
    Object.assign(platform, { features: { devices: { 'test-device': { role, pm25Multiplier: 0.1 } } } });
    const restored = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
    expect(accessory.getService(api.hap.Service.Switch)).toBe(originalPower);
    expect(accessory.getService(api.hap.Service.Lightbulb)).toBeUndefined();
    expect(accessory.getService(api.hap.Service.Outlet)).toBeUndefined();
    expect(accessory.getService(api.hap.Service.AirQualitySensor)).toBeDefined();
    await originalPower.getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
    expect(client.controlDevice).toHaveBeenCalledExactlyOnceWith('test-device', { power: true });
    restored.dispose();
  }
});

test('power-strip role overrides preserve outlet identities and physical command keys', async () => {
  for (const deviceType of ['PowerStrip', 'PowerStrip2']) {
    for (const role of ['light', 'switch']) {
      const { api, platform, accessory, handler, client } = fixture(deviceType);
      handler.dispose();
      Object.assign(platform, { features: { devices: { 'test-device': { role } } } });
      const device = { ...accessory.context.device, deviceState: { power1: true, power2: false, power3: false, power4: true } };
      const restored = new HejhomePlatformAccessory(platform, accessory, device, client as never);
      const serviceType = role === 'light' ? api.hap.Service.Lightbulb : api.hap.Service.Switch;
      expect(accessory.getService(api.hap.Service.Outlet)).toBeUndefined();
      expect(accessory.services.filter((service) => service.UUID === serviceType.UUID)).toHaveLength(4);
      const channel3 = accessory.getServiceById(serviceType, 'power3')!.getCharacteristic(api.hap.Characteristic.On);
      await expect(channel3.handleGetRequest()).resolves.toBe(false);
      await channel3.handleSetRequest(true);
      expect(client.controlDevice).toHaveBeenCalledExactlyOnceWith('test-device', { power3: true });
      expect(accessory.getServiceById(serviceType, 'power1')!.getCharacteristic(api.hap.Characteristic.On).value).toBe(true);
      restored.dispose();
    }
  }
});
