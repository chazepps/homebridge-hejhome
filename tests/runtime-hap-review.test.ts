import { afterEach, expect, test, vi } from 'vitest';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejhomePlatform } from '../src/platform.js';
import type { HejDevice } from '../src/types.js';

const handlers: HejhomePlatformAccessory[] = [];
afterEach(() => {
  for (const handler of handlers.splice(0)) {
    handler.dispose();
  } vi.useRealTimers();
});
function colorFixture() {
  const api = new HomebridgeAPI();
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features: { matter: false, adaptiveLighting: false, meters: [] }, info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as HejhomePlatform;
  const device: HejDevice = { id: 'rgb-review', name: 'RGBW', deviceType: 'LightRgbw5',
    deviceState: { power: true, lightMode: 'WHITE', brightness: 40, hsvColor: { hue: 10, saturation: 20, brightness: 30 } } };
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  const client = { controlDevice: vi.fn(async () => undefined) };
  const handler = new HejhomePlatformAccessory(platform, accessory, device, client as never); handlers.push(handler);
  return { api, platform, accessory, client, handler };
}

test('a hue request must preserve brightness observed while its prerequisite color-mode request is pending', async () => {
  vi.useFakeTimers();
  const { api, accessory, client, handler } = colorFixture();
  let release!: () => void;
  client.controlDevice.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const hue = accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.Hue);
  const write = hue.handleSetRequest(80);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(client.controlDevice).toHaveBeenCalledWith('rgb-review', { lightMode: 'colour' });
  handler.observeExternal({ brightness: 70 });
  handler.updateDevice({ ...accessory.context.device, deviceState: { ...accessory.context.device.deviceState, brightness: 70 } });
  release(); await write;
  await vi.advanceTimersByTimeAsync(350);
  expect(client.controlDevice).toHaveBeenLastCalledWith('rgb-review', { hsvColor: { hue: 80, saturation: 100, brightness: 70 } });
});

test('restoring a white light without a temperature report must not replace its cache with a fabricated cold value', async () => {
  const api = new HomebridgeAPI();
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features: { matter: false, adaptiveLighting: false, meters: [] }, info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as HejhomePlatform;
  const device: HejDevice = { id: 'white-review', name: 'White', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50 } };
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  const characteristic = accessory.addService(api.hap.Service.Lightbulb).getCharacteristic(api.hap.Characteristic.ColorTemperature);
  characteristic.updateValue(220);
  const changes: unknown[] = []; characteristic.on('change', (event) => changes.push(event.newValue));
  const handler = new HejhomePlatformAccessory(platform, accessory, device, { controlDevice: vi.fn() } as never); handlers.push(handler);
  await expect(characteristic.handleGetRequest()).rejects.toBe(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  expect(changes).not.toContain(154);
  expect(characteristic.value).toBe(220);
});

test('outlet load reads respect runtime measurement invalidation after a connection epoch changes', async () => {
  const api = new HomebridgeAPI();
  let measurementReachable = true;
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features: { matter: false, adaptiveLighting: false, meters: [{ model: 'meter-review', power: { field: 'watts', multiplier: 1 } }] },
    getDeviceHealth: () => ({ reachable: true, reason: 'available' }),
    getMeasurementHealth: () => ({ reachable: measurementReachable, reason: measurementReachable ? 'available' : 'measurement-unknown' }),
    info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as HejhomePlatform;
  const device: HejDevice = { id: 'plug-review', name: 'Plug', deviceType: 'Plug', modelName: 'meter-review',
    deviceState: { power: true, watts: 10 } };
  const accessory = new api.platformAccessory(device.name, api.hap.uuid.generate(device.id));
  const handler = new HejhomePlatformAccessory(platform, accessory, device, { controlDevice: vi.fn() } as never); handlers.push(handler);
  handler.observeExternal({ watts: 10 }); handler.updateDevice(device);
  const inUse = accessory.getService(api.hap.Service.Outlet)!.getCharacteristic(api.hap.Characteristic.OutletInUse);
  expect(await inUse.handleGetRequest()).toBe(true);
  measurementReachable = false;
  await expect(inUse.handleGetRequest()).rejects.toBe(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
});

test('selecting white mode must preserve a brightness report received while white-mode acknowledgement is pending', async () => {
  vi.useFakeTimers();
  const { api, accessory, client, handler } = colorFixture();
  handler.updateDevice({ ...accessory.context.device, deviceState: { power: true, lightMode: 'COLOR', brightness: 40,
    hsvColor: { hue: 10, saturation: 20, brightness: 40 } } });
  let release!: () => void;
  client.controlDevice.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const saturation = accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.Saturation);
  const write = saturation.handleSetRequest(0);
  await vi.waitFor(() => expect(release).toBeDefined());
  const patch = { hsvColor: { hue: 10, saturation: 20, brightness: 70 }, brightness: 70 };
  handler.observeExternal(patch);
  handler.updateDevice({ ...accessory.context.device, deviceState: { ...accessory.context.device.deviceState, ...patch } });
  release(); await write; await vi.advanceTimersByTimeAsync(350);
  expect(client.controlDevice).toHaveBeenLastCalledWith('rgb-review', { brightness: 70 });
});


test('an external scene selection during a color-mode wait cancels the obsolete HSV continuation', async () => {
  vi.useFakeTimers();
  const { api, platform, accessory, handler } = colorFixture();
  let release!: () => void;
  const send = vi.fn(async () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  Object.assign(platform, { controlDevice: send });
  const hue = accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.Hue);
  const write = hue.handleSetRequest(80);
  await vi.waitFor(() => expect(release).toBeDefined());
  const patch = { lightMode: 'SCENE' as const, brightness: 70 };
  handler.observeExternal(patch);
  handler.updateDevice({ ...accessory.context.device, deviceState: { ...accessory.context.device.deviceState, ...patch } });
  release(); await write.catch(() => undefined); await vi.advanceTimersByTimeAsync(350);
  expect(send).toHaveBeenCalledTimes(1);
  expect(accessory.context.device.deviceState.lightMode).toBe('SCENE');
});

test('a color write cannot fabricate full brightness when the current brightness was never reported', async () => {
  vi.useFakeTimers();
  const { api, accessory, client, handler } = colorFixture();
  handler.updateDevice({ ...accessory.context.device, deviceState: { power: true, lightMode: 'WHITE' } });
  const hue = accessory.getService(api.hap.Service.Lightbulb)!.getCharacteristic(api.hap.Characteristic.Hue);
  const result = await hue.handleSetRequest(80).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
  await vi.advanceTimersByTimeAsync(350);
  expect(client.controlDevice).not.toHaveBeenCalled();
  expect(result).toEqual({ ok: false, error: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
});
