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
