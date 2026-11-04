import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { API, Characteristic, Logging, PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { normalizeFeatures } from '../src/features.js';
import { HejRestClient } from '../src/hej/rest.js';
import { HejhomePlatform } from '../src/platform.js';
import { sceneUuidSeed } from '../src/scenes.js';
import type { HejFamily, HejScene, HejSession } from '../src/types.js';

const session: HejSession = { identifier: 'user@example.test', autoLogin: true, accessToken: 'test',
  jsessionId: 'test', usernameCookie: 'test', expiresAt: 1 };

describe('scene REST calls', () => {
  test('lists scenes by the family-id query and drops malformed entries', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({
      result: [{ name: 'Main', sceneId: 's8-main' }, { name: 'No id' }, null, { name: 'Empty', sceneId: '' },
        { name: '  ', sceneId: 's8-blank' }] }) });
    const client = new HejRestClient(session, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await client.getScenes(100)).toEqual([{ name: 'Main', sceneId: 's8-main' }]);
    expect(fetch.mock.calls[0]![0]).toBe('https://square.hej.so/dashboard/scene?family-id=100');
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
  });
  test('rejects a scene list that is not the documented shape', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ result: {} }) });
    const client = new HejRestClient(session, { fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.getScenes(100)).rejects.toThrow('not recognised');
  });
  test('runs a scene with a body-less POST identified only by the query string', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const client = new HejRestClient(session, { fetch: fetch as unknown as typeof globalThis.fetch });
    await client.runScene(100, 's8-a/b');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://square.hej.so/dashboard/scene/?family-id=100&scene-id=s8-a%2Fb');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
  test('a failed run is reported', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' });
    const client = new HejRestClient(session, { fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.runScene(100, 's8-main')).rejects.toThrow('500');
  });
});

describe('scene option', () => {
  test('is disabled unless explicitly enabled', () => {
    expect(normalizeFeatures(undefined).scenes).toBeUndefined();
    expect(normalizeFeatures({ scenes: false }).scenes).toBeUndefined();
    expect(normalizeFeatures({ scenes: true }).scenes).toBe(true);
    expect(() => normalizeFeatures({ scenes: 'true' })).toThrow();
  });
});

const family: HejFamily = { familyId: 100, name: 'Home' };
const other: HejFamily = { familyId: 200, name: 'Other' };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
});

async function fixture(scenes: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-scene-test-'));
  const host = new HomebridgeAPI();
  const listeners = new Map<string, () => unknown>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, on: (e: string, fn: () => unknown) => listeners.set(e, fn),
    user: { storagePath: () => dir }, updatePlatformAccessories: vi.fn(), registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: scenes ? { scenes } : {} }, api);
  const client = { dispose: vi.fn(), getScenes: vi.fn(), runScene: vi.fn().mockResolvedValue(undefined) };
  const internal = platform as unknown as { client: typeof client; sceneHandlers: Map<string, unknown>;
    reconcileScenes(c: typeof client, families: HejFamily[], generation: number): Promise<void> };
  internal.client = client;
  let stopped: Promise<unknown> | undefined;
  const shutdown = () => stopped ??= Promise.resolve(listeners.get('shutdown')?.());
  cleanup.push(async () => {
    await shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const reconcile = (families: HejFamily[] = [family]) => internal.reconcileScenes(client, families, 0);
  const switchOf = (accessory: PlatformAccessory): Characteristic =>
    accessory.getService(host.hap.Service.Switch)!.getCharacteristic(host.hap.Characteristic.On);
  /** Publishes the given scenes and returns the On characteristic of the first one. */
  const publish = async (scenes: HejScene[] = [{ name: 'Main', sceneId: 's8-main' }]) => {
    client.getScenes.mockResolvedValue(scenes);
    await reconcile();
    return switchOf([...platform.accessories.values()][0]!);
  };
  const names = () => [...platform.accessories.values()].map((entry) => entry.displayName).sort();
  const failure = host.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
  return { platform, api, host, client, internal, shutdown, reconcile, publish, switchOf, names, failure };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('scene accessories', () => {
  test('publishes one switch per scene with stable UUIDs', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }, { name: 'Balcony', sceneId: 's8-balcony' }]);
    await f.reconcile();
    expect(f.api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    const uuid = f.host.hap.uuid.generate(sceneUuidSeed({ familyId: 100, sceneId: 's8-main' }));
    const accessory = f.platform.accessories.get(uuid)!;
    expect(accessory.displayName).toBe('Main');
    expect(accessory.context.scene).toEqual({ familyId: 100, sceneId: 's8-main', name: 'Main' });
    expect(accessory.getService(f.host.hap.Service.Switch)).toBeDefined();
    await f.reconcile();
    expect(f.api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    expect(f.platform.accessories.get(uuid)).toBe(accessory);
  });
  test('removed scenes are unpublished, but a failed list keeps the existing ones', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }, { name: 'Balcony', sceneId: 's8-balcony' }]);
    await f.reconcile();
    f.client.getScenes.mockRejectedValue(new Error('offline'));
    await f.reconcile();
    expect(f.platform.accessories.size).toBe(2);
    expect(f.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await f.reconcile();
    expect(f.platform.accessories.size).toBe(1);
    expect(f.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
  test('does nothing while the option is off and never runs a scene', async () => {
    const f = await fixture(false);
    await f.reconcile();
    expect(f.client.getScenes).not.toHaveBeenCalled();
    await expect(f.platform.runScene({ familyId: 100, sceneId: 's8-main', name: 'Main' })).rejects.toThrow('not ready');
    expect(f.client.runScene).not.toHaveBeenCalled();
  });
  test('a cached scene is restored with its handler and is unpublished when the option is turned off', async () => {
    const on = await fixture(true);
    const seed = { familyId: 100, sceneId: 's8-main', name: 'Main' };
    const uuid = on.host.hap.uuid.generate(sceneUuidSeed(seed));
    const cached = new on.host.platformAccessory('Main', uuid);
    cached.context.scene = seed;
    on.platform.configureAccessory(cached);
    expect(cached.getService(on.host.hap.Service.Switch)).toBeDefined();
    const off = await fixture(false);
    const stale = new off.host.platformAccessory('Main', uuid);
    stale.context.scene = seed;
    off.platform.configureAccessory(stale);
    await (off.platform as unknown as { pruneHiddenPublications(): Promise<void> }).pruneHiddenPublications();
    expect(off.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [stale]);
    expect(off.platform.accessories.size).toBe(0);
  });
  test('refuses a scene that the current account has not confirmed', async () => {
    const f = await fixture(true);
    const seed = { familyId: 100, sceneId: 's8-main', name: 'Main' };
    const cached = new f.host.platformAccessory('Main', f.host.hap.uuid.generate(sceneUuidSeed(seed)));
    cached.context.scene = seed;
    f.platform.configureAccessory(cached);
    await expect(f.platform.runScene(seed)).rejects.toThrow('not confirmed');
    f.client.getScenes.mockResolvedValue([seed]);
    await f.reconcile();
    await f.platform.runScene(seed);
    expect(f.client.runScene).toHaveBeenCalledWith(100, 's8-main');
    await expect(f.platform.runScene({ ...seed, familyId: 200 })).rejects.toThrow('not confirmed');
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
  });
  test('a failed list does not confirm cached scenes, and an empty list is a normal result', async () => {
    const f = await fixture(true);
    const seed = { familyId: 100, sceneId: 's8-main', name: 'Main' };
    const cached = new f.host.platformAccessory('Main', f.host.hap.uuid.generate(sceneUuidSeed(seed)));
    cached.context.scene = seed;
    f.platform.configureAccessory(cached);
    f.client.getScenes.mockRejectedValue(new Error('offline'));
    await f.reconcile();
    await expect(f.platform.runScene(seed)).rejects.toThrow('not confirmed');
    expect(f.platform.accessories.size).toBe(1);
    f.client.getScenes.mockResolvedValue([]);
    await f.reconcile();
    expect(f.platform.accessories.size).toBe(0);
    expect(f.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
  test('a scene that cannot be registered does not abort the others, and its refused copy is taken back', async () => {
    const f = await fixture(true);
    const warn = vi.spyOn(f.platform, 'warn');
    f.client.getScenes.mockResolvedValue([{ name: 'Bad', sceneId: 's8-bad' }, { name: 'Good', sceneId: 's8-good' }]);
    let refused: unknown;
    f.api.registerPlatformAccessories = vi.fn((_plugin: string, _platform: string, accessories: Array<{ displayName: string }>) => {
      if (accessories[0]!.displayName === 'Bad') {
        refused = accessories[0];
        throw new Error('Cannot Bridge more than 149 Accessories');
      }
    });
    await f.reconcile();
    expect(f.names()).toEqual(['Good']);
    expect(f.internal.sceneHandlers.size).toBe(1);
    expect(f.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [refused]);
    expect(warn).toHaveBeenCalledWith('scene.register.failed', expect.objectContaining({ sceneId: 's8-bad' }));
  });
  test('replacing a scene unpublishes the old one before registering the new one', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Old', sceneId: 's8-old' }]);
    await f.reconcile();
    f.client.getScenes.mockResolvedValue([{ name: 'New', sceneId: 's8-new' }]);
    await f.reconcile();
    const unregister = f.api.unregisterPlatformAccessories as ReturnType<typeof vi.fn>;
    const register = f.api.registerPlatformAccessories as ReturnType<typeof vi.fn>;
    expect(unregister.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[1]!);
    expect(f.names()).toEqual(['New']);
  });
  test('a scene that cannot be unregistered does not abort the others and leaves no handler behind', async () => {
    const f = await fixture(true);
    const warn = vi.spyOn(f.platform, 'warn');
    const old = await f.publish([{ name: 'Old', sceneId: 's8-old' }]);
    f.api.unregisterPlatformAccessories = vi.fn(() => {
      throw new Error('Cannot find the bridged Accessory to remove.');
    });
    f.client.getScenes.mockResolvedValue([{ name: 'New', sceneId: 's8-new' }]);
    await expect(f.reconcile()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('scene.unregister.failed', expect.any(Object));
    expect(f.names()).toEqual(['New']);
    expect(f.internal.sceneHandlers.size).toBe(1);
    await expect(old.handleSetRequest(true)).rejects.toBe(f.failure);
    expect(f.client.runScene).not.toHaveBeenCalled();
  });
  test('keeps the scene UUID across a rename and separates the same scene ID in different homes', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await f.reconcile();
    const [uuid, accessory] = [...f.platform.accessories.entries()][0]!;
    f.client.getScenes.mockResolvedValue([{ name: 'Renamed', sceneId: 's8-main' }]);
    await f.reconcile();
    expect(f.platform.accessories.get(uuid)).toBe(accessory);
    const second = await fixture(true);
    second.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await second.reconcile([family, other]);
    expect(second.platform.accessories.size).toBe(2);
  });
});

describe('scenes across several homes', () => {
  const near = { familyId: 100, sceneId: 's8-near', name: 'Near' };
  const far = { familyId: 200, sceneId: 's8-far', name: 'Far' };
  const lists = (byHome: Record<number, HejScene[] | Error>) => async (familyId: number) => {
    const result = byHome[familyId]!;
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  test('a home whose list fails keeps its scenes and what this session confirmed, while the other home is reconciled', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockImplementation(lists({ 100: [near], 200: [far] }));
    await f.reconcile([family, other]);
    f.client.getScenes.mockImplementation(lists({ 100: [{ name: 'Fresh', sceneId: 's8-fresh' }], 200: new Error('offline') }));
    await f.reconcile([family, other]);
    expect(f.names()).toEqual(['Far', 'Fresh']);
    await f.platform.runScene(far);
    await f.platform.runScene({ familyId: 100, sceneId: 's8-fresh', name: 'Fresh' });
    await expect(f.platform.runScene(near)).rejects.toThrow('not confirmed');
    expect(f.client.runScene.mock.calls).toEqual([[200, 's8-far'], [100, 's8-fresh']]);
  });
  test('a cached scene of a home that cannot be listed stays published but is not runnable until it is confirmed', async () => {
    const f = await fixture(true);
    const cached = new f.host.platformAccessory('Far', f.host.hap.uuid.generate(sceneUuidSeed(far)));
    cached.context.scene = far;
    f.platform.configureAccessory(cached);
    f.client.getScenes.mockImplementation(lists({ 100: [near], 200: new Error('offline') }));
    await f.reconcile([family, other]);
    expect(f.names()).toEqual(['Far', 'Near']);
    await expect(f.platform.runScene(far)).rejects.toThrow('not confirmed');
    await f.platform.runScene(near);
    expect(f.client.runScene.mock.calls).toEqual([[100, 's8-near']]);
  });
  test('a scene of a home that is no longer selected is removed even when every list fails', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockImplementation(lists({ 100: [near], 200: [far] }));
    await f.reconcile([family, other]);
    f.client.getScenes.mockRejectedValue(new Error('offline'));
    await f.reconcile([family]);
    expect(f.names()).toEqual(['Near']);
    await expect(f.platform.runScene(far)).rejects.toThrow('not confirmed');
    await f.platform.runScene(near);
  });
});

describe('scene switch runs', () => {
  test('turning the switch on runs the scene once and returns it to off', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const on = await f.publish();
    await on.handleSetRequest(true);
    expect(f.client.runScene).toHaveBeenCalledWith(100, 's8-main');
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
    await on.handleSetRequest(false);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
  });
  test('runs again after a successful run, returning to off each time', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const on = await f.publish();
    for (const attempt of [1, 2]) {
      await on.handleSetRequest(true);
      expect(f.client.runScene).toHaveBeenCalledTimes(attempt);
      expect(on.value).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(on.value).toBe(false);
    }
  });
  test('a failed run is reported as a communication failure and does not block the next request', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const on = await f.publish();
    f.client.runScene.mockRejectedValueOnce(new Error('cloud refused'));
    await expect(on.handleSetRequest(true)).rejects.toBe(f.failure);
    expect(on.value).toBe(false);
    await on.handleSetRequest(true);
    expect(f.client.runScene).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
  });
  test('requests during a run share one execution and its outcome', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const run = deferred();
    f.client.runScene.mockReturnValue(run.promise);
    const on = await f.publish();
    const results = Promise.allSettled([on.handleSetRequest(true), on.handleSetRequest(true)]);
    await vi.advanceTimersByTimeAsync(0);
    run.resolve();
    expect(await results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
  });
  test('every request during a failing run is reported as the same communication failure', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const run = deferred();
    f.client.runScene.mockReturnValue(run.promise);
    const on = await f.publish();
    const results = Promise.allSettled([on.handleSetRequest(true), on.handleSetRequest(true)]);
    await vi.advanceTimersByTimeAsync(0);
    run.reject(new Error('cloud refused'));
    expect(await results).toEqual([{ status: 'rejected', reason: f.failure }, { status: 'rejected', reason: f.failure }]);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    expect(on.value).toBe(false);
  });
  test('re-discovery during a run keeps the handler, so nothing runs twice and the switch still resets', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const run = deferred();
    f.client.runScene.mockReturnValue(run.promise);
    const on = await f.publish();
    const accessory = [...f.platform.accessories.values()][0]!;
    const first = on.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    f.client.getScenes.mockResolvedValue([{ name: 'Renamed', sceneId: 's8-main' }]);
    await f.reconcile();
    const second = on.handleSetRequest(true);
    run.resolve();
    await Promise.all([first, second]);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
    expect(accessory.displayName).toBe('Renamed');
    expect(accessory.context.scene.name).toBe('Renamed');
  });
});

describe('scene switch disposal', () => {
  /** Records every On change after the request has settled, then lets any timer fire. */
  async function laterChanges(on: Characteristic) {
    const changes = vi.fn();
    on.on('change', changes);
    await vi.advanceTimersByTimeAsync(10);
    return changes;
  }

  test('a deleted switch refuses a request without running the scene', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const on = await f.publish();
    f.client.getScenes.mockResolvedValue([]);
    await f.reconcile();
    await expect(on.handleSetRequest(true)).rejects.toBe(f.failure);
    expect(f.client.runScene).not.toHaveBeenCalled();
    expect(on.value).toBe(false);
    expect(await laterChanges(on)).not.toHaveBeenCalled();
  });
  test.each(['deleted', 'shut down'])('a switch %s mid-run reports a failure and stays off once the run completes', async (end) => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const run = deferred();
    f.client.runScene.mockReturnValue(run.promise);
    const on = await f.publish();
    const request = on.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    if (end === 'deleted') {
      f.client.getScenes.mockResolvedValue([]);
      await f.reconcile();
    } else {
      void f.shutdown();
    }
    run.resolve();
    await expect(request).rejects.toBe(f.failure);
    expect(on.value).toBe(false);
    expect(await laterChanges(on)).not.toHaveBeenCalled();
  });
  test.each(['deleted', 'shut down'])('a switch %s after a successful run, before its reset, is left off', async (end) => {
    vi.useFakeTimers();
    const f = await fixture(true);
    const on = await f.publish();
    await on.handleSetRequest(true);
    expect(on.value).toBe(true);
    if (end === 'deleted') {
      f.client.getScenes.mockResolvedValue([]);
      await f.reconcile();
    } else {
      void f.shutdown();
    }
    expect(on.value).toBe(false);
    expect(await laterChanges(on)).not.toHaveBeenCalled();
  });
});
