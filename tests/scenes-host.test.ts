import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { BridgeService } from '../node_modules/homebridge/dist/bridgeService.js';
import { HejhomePlatform } from '../src/platform.js';
import { sceneUuidSeed } from '../src/scenes.js';
import { SessionStore } from '../src/storage/sessionStore.js';

const rest = vi.hoisted(() => ({
  getFamilies: vi.fn(),
  getDevices: vi.fn(),
  getScenes: vi.fn(),
  runScene: vi.fn(),
}));
vi.mock('../src/hej/rest.js', () => ({ HejRestClient: class {
  getFamilies = rest.getFamilies;
  getDevices = rest.getDevices;
  getScenes = rest.getScenes;
  runScene = rest.runScene;
  dispose = vi.fn();
} }));
vi.mock('../src/hej/realtime.js', () => ({ HejRealtimeClient: class {
  connect = vi.fn(); disconnect = vi.fn();
} }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** Runs the platform against Homebridge's own bridge service, so registration goes through the real host cache and HAP bridge. */
async function hosted() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-scene-host-'));
  await new SessionStore(storage).save({ identifier: 'test', accessToken: 'test', jsessionId: 'test', usernameCookie: 'test',
    autoLogin: true, expiresAt: Date.now() + 3600000 });
  const host = new HomebridgeAPI();
  const service = new BridgeService(host, { getPlugin: () => undefined } as never, undefined as never,
    { cachedAccessoriesDir: storage, cachedAccessoriesItemName: 'cachedAccessories', externalAccessoriesItemName: 'externalAccessories' },
    { name: 'Test bridge' } as never);
  const events = new Map<string, () => unknown>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, user: { storagePath: () => storage },
    on: (event: string, callback: () => unknown) => events.set(event, callback),
    registerPlatformAccessories: host.registerPlatformAccessories.bind(host),
    unregisterPlatformAccessories: host.unregisterPlatformAccessories.bind(host),
    updatePlatformAccessories: host.updatePlatformAccessories.bind(host) } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: { scenes: true } }, api);
  const warn = vi.spyOn(platform, 'warn');
  const internal = platform as unknown as { sceneHandlers: Map<string, unknown>;
    initialize(): Promise<void>; refreshDiscovery(): Promise<void>; stopSessionWatcher(): void };
  cleanups.push(async () => {
    await events.get('shutdown')?.();
    await fs.rm(storage, { recursive: true, force: true, maxRetries: 5 });
  });
  const uuidOf = (sceneId: string) => host.hap.uuid.generate(sceneUuidSeed({ familyId: 100, sceneId }));
  const fillers = (count: number) => Array.from({ length: count }, (_, index) =>
    service.bridge.addBridgedAccessory(new host.hap.Accessory(`Filler ${index}`, host.hap.uuid.generate(`filler:${index}`))));
  return {
    platform, service, warn, internal, uuidOf, fillers, hap: host.hap,
    launch: async () => {
      await internal.initialize();
      internal.stopSessionWatcher();
    },
    rediscover: () => internal.refreshDiscovery(),
    /** Where each side currently has the scene: Homebridge's cache, the HAP bridge, the plugin and its handler. */
    state: (sceneId: string) => {
      const uuid = uuidOf(sceneId);
      const cached = (service as unknown as { cachedPlatformAccessories: PlatformAccessory[] }).cachedPlatformAccessories;
      return {
        cached: cached.some((accessory) => accessory.UUID === uuid),
        bridged: service.bridge.bridgedAccessories.some((accessory) => accessory.UUID === uuid),
        plugin: platform.accessories.has(uuid),
        handler: internal.sceneHandlers.has(uuid),
      };
    },
  };
}

const everywhere = { cached: true, bridged: true, plugin: true, handler: true };
const nowhere = { cached: false, bridged: false, plugin: false, handler: false };

function home(scenes: Array<{ name: string; sceneId: string }>) {
  rest.getFamilies.mockResolvedValue([{ familyId: 100, name: 'Home' }]);
  rest.getDevices.mockResolvedValue([]);
  rest.getScenes.mockResolvedValue(scenes);
  rest.runScene.mockResolvedValue(undefined);
}

test('a scene refused by a full bridge is taken back from Homebridge and is published once there is room', async () => {
  home([{ name: 'Main', sceneId: 's8-main' }]);
  const h = await hosted();
  const [freed] = h.fillers(149);
  await h.launch();
  expect(h.warn).toHaveBeenCalledWith('scene.register.failed', expect.objectContaining({ sceneId: 's8-main' }));
  expect(h.state('s8-main')).toEqual(nowhere);
  h.service.bridge.removeBridgedAccessory(freed!);
  await h.rediscover();
  expect(h.state('s8-main')).toEqual(everywhere);
  expect(h.warn).not.toHaveBeenCalledWith('discovery.failed', expect.anything());
  const bridged = h.service.bridge.bridgedAccessories.find((accessory) => accessory.UUID === h.uuidOf('s8-main'))!;
  await bridged.getService(h.hap.Service.Switch)!.getCharacteristic(h.hap.Characteristic.On).handleSetRequest(true);
  expect(rest.runScene).toHaveBeenCalledWith(100, 's8-main');
});

test('on a full bridge, a replaced scene makes room for its replacement', async () => {
  home([{ name: 'Old', sceneId: 's8-old' }]);
  const h = await hosted();
  h.fillers(148);
  await h.launch();
  expect(h.state('s8-old')).toEqual(everywhere);
  rest.getScenes.mockResolvedValue([{ name: 'New', sceneId: 's8-new' }]);
  await h.rediscover();
  expect(h.state('s8-old')).toEqual(nowhere);
  expect(h.state('s8-new')).toEqual(everywhere);
  expect(h.service.bridge.bridgedAccessories).toHaveLength(149);
});

test('a scene Homebridge fails to unregister does not fail discovery, and neither side keeps it', async () => {
  home([{ name: 'Main', sceneId: 's8-main' }]);
  const h = await hosted();
  await h.launch();
  expect(h.state('s8-main')).toEqual(everywhere);
  // The bridge loses the accessory behind the plugin's back, so Homebridge's own unregister throws.
  const bridged = h.service.bridge.bridgedAccessories.find((accessory) => accessory.UUID === h.uuidOf('s8-main'))!;
  h.service.bridge.removeBridgedAccessory(bridged);
  rest.getScenes.mockResolvedValue([]);
  await h.rediscover();
  expect(h.warn).toHaveBeenCalledWith('scene.unregister.failed', expect.anything());
  expect(h.warn).not.toHaveBeenCalledWith('discovery.failed', expect.anything());
  expect(h.state('s8-main')).toEqual(nowhere);
  rest.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
  await h.rediscover();
  expect(h.state('s8-main')).toEqual(everywhere);
});
