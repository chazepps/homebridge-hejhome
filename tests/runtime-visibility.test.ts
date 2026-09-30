import fs from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus, type API, type Logging, type MatterAPI, type MatterAccessory } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { HejhomePlatform } from '../src/platform.js';
import { SessionStore } from '../src/storage/sessionStore.js';
import type { HejDevice } from '../src/types.js';

vi.mock('../src/hej/rest.js', () => ({ HejRestClient: class {
  getFamilies = vi.fn(async () => {
    throw new Error('Hejhome API request failed: 401 dashboard/family');
  });
  dispose = vi.fn();
} }));
vi.mock('../src/hej/realtime.js', () => ({ HejRealtimeClient: class {
  connect = vi.fn(); disconnect = vi.fn();
} }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function restoredFixture(matterEnabled: boolean, sessionPresent: boolean) {
  const storage = await fs.mkdtemp('/tmp/hej-visibility-');
  if (sessionPresent) {
    await new SessionStore(storage).save({ identifier: 'test', accessToken: 'test', jsessionId: 'test', usernameCookie: 'test',
      autoLogin: true, expiresAt: Date.now() + 3600000 });
  }
  const host = new HomebridgeAPI(); const events = new Map<string, () => void | Promise<unknown>>();
  const matter = { deviceTypes, status: MatterStatus, uuid: { generate: (id: string) => `matter:${id}` },
    registerPlatformAccessories: vi.fn(async () => undefined), unregisterPlatformAccessories: vi.fn(async () => undefined),
    updatePlatformAccessories: vi.fn(async () => undefined), updateAccessoryState: vi.fn(async () => undefined) } as unknown as MatterAPI;
  const api = { hap: host.hap, matter, platformAccessory: host.platformAccessory, user: { storagePath: () => storage },
    on: (event: string, callback: () => void | Promise<unknown>) => events.set(event, callback),
    registerPlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: { matter: matterEnabled, devices: {
    blocked: { visibility: 'hidden' }, 'homekit-only': { visibility: 'homekit' }, 'matter-only': { visibility: 'matter' },
  } } }, api);
  const cached = new Map<string, InstanceType<typeof host.platformAccessory>>();
  for (const id of ['blocked', 'allowed', 'homekit-only', 'matter-only']) {
    const device: HejDevice = { id, name: id, deviceType: 'ZigbeeSwitch1', online: true, deviceState: { power: true } };
    const accessory = new host.platformAccessory(id, host.hap.uuid.generate(id));
    accessory.context.device = device;
    cached.set(id, accessory); platform.configureAccessory(accessory);
    platform.configureMatterAccessory({ UUID: `matter:${id}`, displayName: id, context: { deviceId: id },
      clusters: { bridgedDeviceBasicInformation: { reachable: true } } } as unknown as MatterAccessory);
  }
  cleanups.push(async () => {
    await events.get('shutdown')?.(); await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.rm(storage, { recursive: true, force: true });
  });
  return { platform, api, matter, cached, launch: () => (platform as unknown as { initialize(): Promise<void> }).initialize() };
}

for (const sessionPresent of [false, true]) {
  for (const matterEnabled of [false, true]) {
    test(`local publication policy applies with ${sessionPresent ? '401 discovery' : 'no session'} and Matter ${matterEnabled}`, async () => {
      const { platform, api, matter, cached, launch } = await restoredFixture(matterEnabled, sessionPresent);
      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
      expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
      expect(matter.updateAccessoryState).not.toHaveBeenCalled();
      await launch();
      expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id).sort()).toEqual(['allowed', 'homekit-only']);
      const hiddenHap = vi.mocked(api.unregisterPlatformAccessories).mock.calls.flatMap((call) => call[2].map((accessory) => accessory.context.device.id));
      expect(hiddenHap.sort()).toEqual(['blocked', 'matter-only']);
      const hiddenMatter = vi.mocked(matter.unregisterPlatformAccessories).mock.calls.flatMap((call) => call[2].map((accessory) => accessory.context.deviceId));
      expect(hiddenMatter.sort()).toEqual(matterEnabled ? ['blocked', 'homekit-only'] : ['allowed', 'blocked', 'homekit-only', 'matter-only']);
      if (matterEnabled) {
        expect(matter.updateAccessoryState).toHaveBeenCalledWith('matter:allowed', 'bridgedDeviceBasicInformation', { reachable: false });
      }
      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
      await expect(cached.get('allowed')!.getService(platform.Service.Switch)!.getCharacteristic(platform.Characteristic.On).handleGetRequest())
        .rejects.toBe(platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  }
}

test('legacy unsupported or deferred HAP caches are unpublished after launch, while missing IDs are preserved', async () => {
  const { platform, api, launch } = await restoredFixture(true, false);
  for (const type of ['UnknownRobot', 'HomeCamera', 'SmartButton']) {
    const accessory = new api.platformAccessory(type, api.hap.uuid.generate(type));
    accessory.context.device = { id: type, name: type, deviceType: type, deviceState: { power: true, battery: 50 } };
    accessory.addService(platform.Service.Switch).setCharacteristic(platform.Characteristic.On, true);
    platform.configureAccessory(accessory);
  }
  const noId = new api.platformAccessory('No identity', api.hap.uuid.generate('no-identity'));
  noId.context.device = { name: 'No identity', deviceType: 'UnknownRobot' };
  platform.configureAccessory(noId);
  expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  await launch();
  const removed = vi.mocked(api.unregisterPlatformAccessories).mock.calls.flatMap((call) => call[2].map((accessory) => accessory.displayName));
  expect(removed).toEqual(expect.arrayContaining(['UnknownRobot', 'HomeCamera', 'SmartButton']));
  expect(removed).not.toContain('No identity');
  expect(platform.accessories.has(noId.UUID)).toBe(true);
});
