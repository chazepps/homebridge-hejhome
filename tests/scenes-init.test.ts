import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { API, Logging } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
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

const cachedSeed = { familyId: 100, sceneId: 's8-main', name: 'Main' };

/** Restores a scene cached from home 100, then starts the platform for real with a saved session. */
async function launched() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-scene-init-'));
  await new SessionStore(storage).save({ identifier: 'test', accessToken: 'test', jsessionId: 'test', usernameCookie: 'test',
    autoLogin: true, expiresAt: Date.now() + 3600000 });
  const host = new HomebridgeAPI();
  const events = new Map<string, () => void | Promise<unknown>>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, user: { storagePath: () => storage },
    on: (event: string, callback: () => void | Promise<unknown>) => events.set(event, callback),
    registerPlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: { scenes: true } }, api);
  const cached = new host.platformAccessory('Main', host.hap.uuid.generate(sceneUuidSeed(cachedSeed)));
  cached.context.scene = cachedSeed;
  platform.configureAccessory(cached);
  cleanups.push(async () => {
    await events.get('shutdown')?.(); await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.rm(storage, { recursive: true, force: true });
  });
  return { platform, api, launch: () => (platform as unknown as { initialize(): Promise<void> }).initialize() };
}

test('after a real start, a cached scene from another home is refused when the new list fails', async () => {
  rest.getFamilies.mockResolvedValue([{ familyId: 200, name: 'New home' }]);
  rest.getDevices.mockResolvedValue([]);
  rest.getScenes.mockRejectedValue(new Error('offline'));
  const f = await launched();
  await f.launch();
  expect(rest.getScenes).toHaveBeenCalledWith(200);
  await expect(f.platform.runScene(cachedSeed)).rejects.toThrow('not confirmed');
  expect(rest.runScene).not.toHaveBeenCalled();
});

test('after a real start, a cached scene is runnable once the current home lists it', async () => {
  rest.getFamilies.mockResolvedValue([{ familyId: 100, name: 'Home' }]);
  rest.getDevices.mockResolvedValue([]);
  rest.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
  rest.runScene.mockResolvedValue(undefined);
  const f = await launched();
  await f.launch();
  await f.platform.runScene(cachedSeed);
  expect(rest.runScene).toHaveBeenCalledWith(100, 's8-main');
  await expect(f.platform.runScene({ ...cachedSeed, sceneId: 's8-other' })).rejects.toThrow('not confirmed');
});
