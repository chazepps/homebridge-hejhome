import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus, type API, type Logging, type MatterAPI, type MatterAccessory } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { HejhomePlatform } from '../src/platform.js';
import type { SceneContext } from '../src/scenes.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const scene: SceneContext = { familyId: 100, sceneId: 's8-main', name: 'Main recipe' };

/** Models the public Matter API boundary without running cloud commands or opening network ports. */
async function fixture(enabled = true) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-scene-matter-'));
  const host = new HomebridgeAPI();
  const published = new Map<string, MatterAccessory>();
  const states = new Map<string, Record<string, Record<string, unknown>>>();
  const matter = { deviceTypes, status: MatterStatus, uuid: host.hap.uuid,
    registerPlatformAccessories: async (_plugin: string, _platform: string, items: MatterAccessory[]) => {
      for (const item of items) {
        published.set(item.UUID, item);
        states.set(item.UUID, structuredClone(item.clusters ?? {}));
      }
    },
    updatePlatformAccessories: async (items: MatterAccessory[]) => {
      for (const item of items) {
        published.set(item.UUID, item);
      }
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, items: MatterAccessory[]) => {
      for (const item of items) {
        published.delete(item.UUID);
        states.delete(item.UUID);
      }
    },
    updateAccessoryState: async (uuid: string, cluster: string, attributes: Record<string, unknown>) => {
      const current = states.get(uuid);
      if (!current) {
        throw new Error('Endpoint missing');
      }
      current[cluster] = { ...current[cluster], ...attributes };
    },
    getAccessoryState: async (uuid: string, cluster: string) => states.get(uuid)?.[cluster],
  } as unknown as MatterAPI;
  const events = new Map<string, () => unknown>();
  const api = { hap: host.hap, matter, platformAccessory: host.platformAccessory,
    user: { storagePath: () => storage }, on: (event: string, callback: () => unknown) => events.set(event, callback),
    registerPlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: { scenes: enabled, matter: true } }, api);
  const client = { getScenes: vi.fn().mockResolvedValue([scene]), runScene: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
  const internal = platform as unknown as { client: typeof client;
    reconcileScenes(client: typeof client, families: Array<{ familyId: number; name: string }>, generation: number): Promise<void>;
    pruneHiddenPublications(): Promise<void> };
  internal.client = client;
  const shutdown = () => Promise.resolve(events.get('shutdown')?.());
  cleanups.push(async () => {
    await shutdown();
    await fs.rm(storage, { recursive: true, force: true, maxRetries: 5 });
  });
  const reconcile = (families = [{ familyId: 100, name: 'Home' }]) => internal.reconcileScenes(client, families, 0);
  const recipe = () => [...published.values()].find((item) => item.context?.scene);
  const press = () => recipe()!.handlers!.onOff!.on!({} as never);
  return { platform, api, client, matter, published, states, recipe, press, reconcile, shutdown, internal };
}

test('publishes a recipe on a Matter-only bridge and keeps its identity during rediscovery', async () => {
  const f = await fixture();
  await f.reconcile();
  const item = f.recipe();
  expect(item).toBeDefined();
  expect(item!.displayName).toBe('Main recipe');
  expect(item!.clusters?.onOff).toEqual({ onOff: false });
  expect(item!.context?.scene).toEqual(scene);
  f.client.getScenes.mockResolvedValue([{ ...scene, name: 'Renamed' }]);
  await f.reconcile();
  expect(f.published.size).toBe(1);
  expect(f.recipe()!.UUID).toBe(item!.UUID);
  expect(f.recipe()!.displayName).toBe('Renamed');
});

test('Matter on executes once, off does nothing, and another press runs again after the reset', async () => {
  const f = await fixture();
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  const item = f.recipe()!;
  await item.handlers!.onOff!.off!({} as never);
  expect(f.client.runScene).not.toHaveBeenCalled();
  await f.press();
  // Like Homebridge, commit the requested value after the handler resolves.
  await f.matter.updateAccessoryState(item.UUID, 'onOff', { onOff: true });
  await vi.waitFor(() => expect(f.states.get(item.UUID)?.onOff?.onOff).toBe(false), { timeout: 2000 });
  await f.press();
  expect(f.client.runScene.mock.calls).toEqual([[100, 's8-main'], [100, 's8-main']]);
});

test('concurrent Matter presses retain one cloud call across rediscovery and both propagate failure', async () => {
  const f = await fixture();
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  let reject!: (error: Error) => void;
  f.client.runScene.mockImplementation(() => new Promise<void>((_done, fail) => {
    reject = fail;
  }));
  const outcomes = Promise.allSettled([f.press(), f.press()]);
  await vi.waitFor(() => expect(f.client.runScene).toHaveBeenCalledOnce());
  await f.reconcile();
  reject(new Error('cloud failure'));
  expect((await outcomes).map((item) => item.status)).toEqual(['rejected', 'rejected']);
  expect(f.client.runScene).toHaveBeenCalledOnce();
  f.client.runScene.mockResolvedValue(undefined);
  await f.press();
  expect(f.client.runScene).toHaveBeenCalledTimes(2);
});

test('a failed home list preserves its Matter recipes while an empty list removes only recipes', async () => {
  const f = await fixture();
  const physical = { UUID: 'physical', displayName: 'Physical', deviceType: deviceTypes.OnOffOutlet };
  await f.matter.registerPlatformAccessories('test', 'Hejhome', [physical]);
  f.platform.configureMatterAccessory(physical);
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  f.client.getScenes.mockRejectedValue(new Error('offline'));
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  f.client.getScenes.mockResolvedValue([]);
  await f.reconcile();
  expect([...f.published.keys()]).toEqual(['physical']);
});

test('a failed home list keeps a confirmed Matter recipe usable even when HAP registration failed', async () => {
  const f = await fixture();
  vi.mocked(f.api.registerPlatformAccessories).mockImplementation(() => {
    throw new Error('HAP full');
  });
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  await f.press();
  f.client.getScenes.mockRejectedValue(new Error('List temporarily unavailable'));
  await f.reconcile();
  await f.press();
  expect(f.client.runScene).toHaveBeenCalledTimes(2);
});

test('disabling recipes removes a cached Matter recipe without pruning physical devices', async () => {
  const on = await fixture();
  await on.reconcile();
  expect(on.recipe()).toBeDefined();
  const off = await fixture(false);
  const cached = on.recipe()!;
  await off.matter.registerPlatformAccessories('test', 'Hejhome', [cached]);
  off.platform.configureMatterAccessory(cached);
  await off.internal.pruneHiddenPublications();
  expect(off.published.size).toBe(0);
  expect(off.client.runScene).not.toHaveBeenCalled();
});

test('a stale recipe endpoint update cannot abort physical device initialization', async () => {
  const on = await fixture();
  await on.reconcile();
  expect(on.recipe()).toBeDefined();
  const cached = on.recipe()!;
  const restarted = await fixture();
  await restarted.matter.registerPlatformAccessories('test', 'Hejhome', [cached]);
  restarted.platform.configureMatterAccessory(cached);
  vi.spyOn(restarted.matter, 'updateAccessoryState').mockRejectedValueOnce(new Error('Endpoint unavailable'));
  await expect(restarted.internal.pruneHiddenPublications()).resolves.toBeUndefined();
});

test('disabling recipes retries a transient removal failure on the next watcher check', async () => {
  const on = await fixture();
  await on.reconcile();
  const off = await fixture(false);
  const cached = on.recipe()!;
  await off.matter.registerPlatformAccessories('test', 'Hejhome', [cached]);
  off.platform.configureMatterAccessory(cached);
  vi.spyOn(off.matter, 'unregisterPlatformAccessories').mockRejectedValueOnce(new Error('Temporary failure'));
  await off.internal.pruneHiddenPublications();
  expect(off.published.size).toBe(1);
  await off.internal.pruneHiddenPublications();
  expect(off.published.size).toBe(0);
});

test.each(['deletion', 'shutdown'])('a Matter run finishing after %s rejects instead of reporting success', async (operation) => {
  const f = await fixture();
  await f.reconcile();
  expect(f.recipe()).toBeDefined();
  let finish!: () => void;
  f.client.runScene.mockImplementation(() => new Promise<void>((done) => {
    finish = done;
  }));
  const outcome = Promise.allSettled([f.press()]);
  await vi.waitFor(() => expect(f.client.runScene).toHaveBeenCalledOnce());
  if (operation === 'deletion') {
    f.client.getScenes.mockResolvedValue([]);
    await f.reconcile();
  } else {
    await f.shutdown();
  }
  finish();
  expect((await outcome)[0]!.status).toBe('rejected');
});
