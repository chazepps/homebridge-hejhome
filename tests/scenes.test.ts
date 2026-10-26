import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { API, Logging } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { normalizeFeatures } from '../src/features.js';
import { HejRestClient } from '../src/hej/rest.js';
import { HejhomePlatform } from '../src/platform.js';
import { HejhomeSceneSwitch, sceneUuidSeed } from '../src/scenes.js';
import type { HejFamily, HejSession } from '../src/types.js';

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
  const listeners = new Map<string, () => void>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, on: (e: string, fn: () => void) => listeners.set(e, fn),
    user: { storagePath: () => dir }, updatePlatformAccessories: vi.fn(), registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', features: scenes ? { scenes } : {} }, api);
  const client = { dispose: vi.fn(), getScenes: vi.fn(), runScene: vi.fn().mockResolvedValue(undefined) };
  const internal = platform as unknown as { client: typeof client;
    reconcileScenes(c: typeof client, families: HejFamily[], generation: number): Promise<void> };
  internal.client = client;
  cleanup.push(async () => {
    listeners.get('shutdown')?.(); await new Promise((r) => setTimeout(r, 30)); await fs.rm(dir, { recursive: true, force: true });
  });
  return { platform, api, host, client, internal, shutdown: () => listeners.get('shutdown')?.() };
}

const family: HejFamily = { familyId: 100, name: 'Home' };

describe('scene accessories', () => {
  test('publishes one switch per scene with stable UUIDs', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }, { name: 'Balcony', sceneId: 's8-balcony' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    const uuid = f.host.hap.uuid.generate(sceneUuidSeed({ familyId: 100, sceneId: 's8-main' }));
    const accessory = f.platform.accessories.get(uuid)!;
    expect(accessory.displayName).toBe('Main');
    expect(accessory.context.scene).toEqual({ familyId: 100, sceneId: 's8-main', name: 'Main' });
    expect(accessory.getService(f.host.hap.Service.Switch)).toBeDefined();
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.api.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    expect(f.platform.accessories.get(uuid)).toBe(accessory);
  });
  test('turning the switch on runs the scene once and returns it to off', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    const accessory = [...f.platform.accessories.values()][0]!;
    const on = accessory.getService(f.host.hap.Service.Switch)!.getCharacteristic(f.host.hap.Characteristic.On);
    await on.handleSetRequest(true);
    expect(f.client.runScene).toHaveBeenCalledWith(100, 's8-main');
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
    await on.handleSetRequest(false);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
  });
  test('a failed run is surfaced to HomeKit as a communication failure', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    f.client.runScene.mockRejectedValue(new Error('cloud refused'));
    await f.internal.reconcileScenes(f.client, [family], 0);
    const accessory = [...f.platform.accessories.values()][0]!;
    const on = accessory.getService(f.host.hap.Service.Switch)!.getCharacteristic(f.host.hap.Characteristic.On);
    await expect(on.handleSetRequest(true)).rejects.toBe(f.host.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });
  test('removed scenes are unpublished, but a failed list keeps the existing ones', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }, { name: 'Balcony', sceneId: 's8-balcony' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    f.client.getScenes.mockRejectedValue(new Error('offline'));
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.platform.accessories.size).toBe(2);
    expect(f.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.platform.accessories.size).toBe(1);
    expect(f.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
  test('does nothing while the option is off and never runs a scene', async () => {
    const f = await fixture(false);
    await f.internal.reconcileScenes(f.client, [family], 0);
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
  test('the switch ignores requests after it is disposed', async () => {
    const f = await fixture(true);
    const accessory = new f.host.platformAccessory('Main', f.host.hap.uuid.generate('x'));
    const run = vi.fn().mockResolvedValue(undefined);
    const handler = new HejhomeSceneSwitch({ accessory, hap: f.host.hap, scene: { familyId: 1, sceneId: 's', name: 'Main' }, run });
    handler.dispose();
    await accessory.getService(f.host.hap.Service.Switch)!.getCharacteristic(f.host.hap.Characteristic.On).handleSetRequest(true);
    expect(run).not.toHaveBeenCalled();
  });
  test('refuses a scene that the current account has not confirmed', async () => {
    const f = await fixture(true);
    const seed = { familyId: 100, sceneId: 's8-main', name: 'Main' };
    const cached = new f.host.platformAccessory('Main', f.host.hap.uuid.generate(sceneUuidSeed(seed)));
    cached.context.scene = seed;
    f.platform.configureAccessory(cached);
    await expect(f.platform.runScene(seed)).rejects.toThrow('not confirmed');
    f.client.getScenes.mockResolvedValue([seed]);
    await f.internal.reconcileScenes(f.client, [family], 0);
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
    await f.internal.reconcileScenes(f.client, [family], 0);
    await expect(f.platform.runScene(seed)).rejects.toThrow('not confirmed');
    expect(f.platform.accessories.size).toBe(1);
    f.client.getScenes.mockResolvedValue([]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.platform.accessories.size).toBe(0);
    expect(f.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
  test('requests during a run share one execution and its outcome', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    let release!: () => void;
    f.client.runScene.mockReturnValue(new Promise<void>((resolve) => {
      release = resolve;
    }));
    await f.internal.reconcileScenes(f.client, [family], 0);
    const on = [...f.platform.accessories.values()][0]!.getService(f.host.hap.Service.Switch)!
      .getCharacteristic(f.host.hap.Characteristic.On);
    const first = on.handleSetRequest(true);
    const second = on.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
  });
  test('every request during a failing run is reported as a failure', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    let fail!: () => void;
    f.client.runScene.mockReturnValue(new Promise<void>((_, reject) => {
      fail = () => reject(new Error('cloud refused'));
    }));
    await f.internal.reconcileScenes(f.client, [family], 0);
    const on = [...f.platform.accessories.values()][0]!.getService(f.host.hap.Service.Switch)!
      .getCharacteristic(f.host.hap.Characteristic.On);
    const results = Promise.allSettled([on.handleSetRequest(true), on.handleSetRequest(true)]);
    await vi.advanceTimersByTimeAsync(0);
    fail();
    expect((await results).map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
  });
  test('re-discovery during a run keeps the handler, so nothing runs twice and the switch still resets', async () => {
    vi.useFakeTimers();
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    let release!: () => void;
    f.client.runScene.mockReturnValue(new Promise<void>((resolve) => {
      release = resolve;
    }));
    await f.internal.reconcileScenes(f.client, [family], 0);
    const accessory = [...f.platform.accessories.values()][0]!;
    const on = accessory.getService(f.host.hap.Service.Switch)!.getCharacteristic(f.host.hap.Characteristic.On);
    const first = on.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    f.client.getScenes.mockResolvedValue([{ name: 'Renamed', sceneId: 's8-main' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    const second = on.handleSetRequest(true);
    release();
    await Promise.all([first, second]);
    expect(f.client.runScene).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(on.value).toBe(false);
    expect(accessory.displayName).toBe('Renamed');
    expect(accessory.context.scene.name).toBe('Renamed');
  });
  test('a scene that cannot be registered does not abort the others or leave a handler behind', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Bad', sceneId: 's8-bad' }, { name: 'Good', sceneId: 's8-good' }]);
    f.api.registerPlatformAccessories = vi.fn((_plugin: string, _platform: string, accessories: Array<{ displayName: string }>) => {
      if (accessories[0]!.displayName === 'Bad') {
        throw new Error('Cannot Bridge more than 149 Accessories');
      }
    });
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect([...f.platform.accessories.values()].map((entry) => entry.displayName)).toEqual(['Good']);
    expect((f.platform as unknown as { sceneHandlers: Map<string, unknown> }).sceneHandlers.size).toBe(1);
  });
  test('replacing a scene unpublishes the old one before registering the new one', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Old', sceneId: 's8-old' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    f.client.getScenes.mockResolvedValue([{ name: 'New', sceneId: 's8-new' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    const unregister = f.api.unregisterPlatformAccessories as ReturnType<typeof vi.fn>;
    const register = f.api.registerPlatformAccessories as ReturnType<typeof vi.fn>;
    expect(unregister.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[1]!);
    expect([...f.platform.accessories.values()].map((entry) => entry.displayName)).toEqual(['New']);
  });
  test('keeps the scene UUID across a rename and separates the same scene ID in different homes', async () => {
    const f = await fixture(true);
    f.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    const [uuid, accessory] = [...f.platform.accessories.entries()][0]!;
    f.client.getScenes.mockResolvedValue([{ name: 'Renamed', sceneId: 's8-main' }]);
    await f.internal.reconcileScenes(f.client, [family], 0);
    expect(f.platform.accessories.get(uuid)).toBe(accessory);
    const other = await fixture(true);
    other.client.getScenes.mockResolvedValue([{ name: 'Main', sceneId: 's8-main' }]);
    await other.internal.reconcileScenes(other.client, [family, { familyId: 200, name: 'Other' }], 0);
    expect(other.platform.accessories.size).toBe(2);
  });
});
