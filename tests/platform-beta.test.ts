import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { HejhomePlatform } from '../src/platform.js';
import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejDevice } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  } vi.useRealTimers();
});
async function fixture(adaptiveLighting = false, cachedAdaptive = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-beta-test-'));
  const host = new HomebridgeAPI();
  const listeners = new Map<string, () => void>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, on: (e: string, fn: () => void) => listeners.set(e, fn),
    user: { storagePath: () => dir }, updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: { adaptiveLighting } }, api);
  const client = { dispose: vi.fn(), controlDevice: vi.fn().mockResolvedValue(undefined) };
  const device: HejDevice = { id: 'w1', name: 'White light', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50, temperature: 30 } };
  const accessory = new host.platformAccessory(device.name, host.hap.uuid.generate(device.id));
  if (cachedAdaptive) {
    const light = accessory.addService(host.hap.Service.Lightbulb);
    light.addCharacteristic(host.hap.Characteristic.SupportedCharacteristicValueTransitionConfiguration);
    light.addCharacteristic(host.hap.Characteristic.CharacteristicValueTransitionControl);
    light.addCharacteristic(host.hap.Characteristic.CharacteristicValueActiveTransitionCount);
  }
  accessory.context.device = device;
  platform.configureAccessory(accessory);
  const internal = platform as unknown as { client: typeof client; createAccessoryHandler(a: PlatformAccessory, d: HejDevice): void };
  internal.client = client;
  internal.createAccessoryHandler(accessory, device);
  cleanup.push(async () => {
    listeners.get('shutdown')?.(); await new Promise((r) => setTimeout(r, 30)); await fs.rm(dir, { recursive: true, force: true });
  });
  return { platform, api, accessory, client, shutdown: () => listeners.get('shutdown')?.() };
}

describe('shared HAP/Matter runtime', () => {
  test('serializes commands from both protocols and only commits successful state', async () => {
    const { platform, accessory, client } = await fixture();
    let release!: () => void;
    client.controlDevice.mockImplementationOnce(() => new Promise<void>((r) => {
      release = r;
    }));
    const first = platform.controlDevice('w1', { power: false }, 'hap');
    const second = platform.controlDevice('w1', { power: true }, 'matter');
    await vi.waitFor(() => expect(client.controlDevice).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(client.controlDevice.mock.calls.map((c) => c[1])).toEqual([{ power: false }, { power: true }]);
    expect(accessory.context.device.deviceState.power).toBe(true);
    client.controlDevice.mockRejectedValueOnce(new Error('cloud refused'));
    await expect(platform.controlDevice('w1', { power: false }, 'matter')).rejects.toThrow('cloud refused');
    expect(accessory.context.device.deviceState.power).toBe(true);
  });
  test('a shutdown rejects queued controls instead of issuing more cloud commands', async () => {
    const { platform, client, shutdown } = await fixture();
    shutdown();
    await expect(platform.controlDevice('w1', { power: false }, 'matter')).rejects.toThrow('not ready');
    expect(client.controlDevice).not.toHaveBeenCalled();
  });
  test('Adaptive Lighting only registers for opted-in white lights', async () => {
    const off = await fixture();
    const on = await fixture(true);
    const characteristic = on.api.hap.Characteristic.SupportedCharacteristicValueTransitionConfiguration;
    expect(off.accessory.getService(off.api.hap.Service.Lightbulb)?.testCharacteristic(characteristic)).toBe(false);
    expect(on.accessory.getService(on.api.hap.Service.Lightbulb)?.testCharacteristic(characteristic)).toBe(true);
  });
  test('disposing an accessory cancels unsent analog commands', async () => {
    const { platform, api, accessory, client } = await fixture();
    const handler = new HejhomePlatformAccessory(platform, accessory, accessory.context.device, client as never);
    const light = accessory.getService(api.hap.Service.Lightbulb)!;
    await light.getCharacteristic(api.hap.Characteristic.Brightness).handleSetRequest(75);
    handler.dispose();
    await new Promise((r) => setTimeout(r, 400));
    expect(client.controlDevice).not.toHaveBeenCalled();
  });
});

test('disabling adaptive lighting removes restored controller characteristics', async () => {
  const { accessory, api } = await fixture(false, true);
  expect(accessory.getService(api.hap.Service.Lightbulb)!
    .testCharacteristic(api.hap.Characteristic.CharacteristicValueTransitionControl)).toBe(false);
});
