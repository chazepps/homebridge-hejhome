import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus, type MatterAPI, type MatterAccessory } from 'homebridge';
import { Endpoint, Environment, ServerNode } from '@matter/main';
import { MockStorageService, StorageService } from '@matter/general';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { MatterAccessoryCache } from '../node_modules/homebridge/dist/matter/accessoryCache.js';
import type { MatterServer as HostServer } from '../node_modules/homebridge/dist/matter/server.js';
import { MatterAdapter } from '../src/matter/adapter.js';
import type { HejDevice } from '../src/types.js';
import { patchAdditiveMatterParts } from '../tools/homebridge/patch-additive-matter-parts.mjs';

let copy: string;
let Host: typeof HostServer;
const cleanups: Array<() => Promise<void>> = [];
const hostPackage = JSON.parse(await fs.readFile(path.resolve('node_modules/homebridge/package.json'), 'utf8'));

describe.skipIf(hostPackage.version !== '2.4.0')('Homebridge 2.4.0 additive-parts compatibility', () => {
  beforeAll(async () => {
    copy = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-additive-host-'));
    await fs.cp(path.resolve('node_modules/homebridge/dist'), path.join(copy, 'dist'), { recursive: true });
    await fs.copyFile(path.resolve('node_modules/homebridge/package.json'), path.join(copy, 'package.json'));
    await fs.symlink(path.resolve('node_modules'), path.join(copy, 'node_modules'));
    await Promise.all((await fs.readdir(path.join(copy, 'dist'), { recursive: true })).filter((file) => file.endsWith('.js')).map(async (file) => {
      const target = path.join(copy, 'dist', file);
      await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
    }));
    await patchAdditiveMatterParts(copy, 'apply');
    Host = (await import(pathToFileURL(path.join(copy, 'dist/matter/server.js')).href)).MatterServer;
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });
  afterAll(async () => {
    await fs.rm(copy, { recursive: true, force: true });
  });

  async function fixture(cycle: number, fireAndForget = false, serialized?: ReturnType<MatterAccessoryCache['getAllCached']>[number]) {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-additive-cache-'));
    cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
    const environment = new Environment(`hej-additive-${cycle}`, Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `hej-additive-${cycle}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    cleanups.push(async () => {
      if (node.lifecycle.isReady) {
        await node.close();
      }
    });
    const server = new Host({ uniqueId: `hej-additive-${cycle}`, storagePath: storage, port: 5540 });
    const cache = new MatterAccessoryCache(storage, 'bridge');
    if (serialized) {
      await fs.mkdir(path.join(storage, 'bridge'));
      await fs.writeFile(path.join(storage, 'bridge/accessories.json'), JSON.stringify([serialized]));
    }
    await cache.load();
    const internal = server as unknown as { accessories: Map<string, { endpoint: Endpoint; _parts: Array<{ id: string; endpoint: Endpoint }> }>;
    serverNode: typeof node; aggregator: typeof aggregator; accessoryCache: MatterAccessoryCache };
    Object.assign(internal, { serverNode: node, aggregator, accessoryCache: cache });
    const updates: Promise<void>[] = [];
    cleanups.push(async () => {
      await Promise.allSettled(updates);
      internal.accessoryCache.cancelPendingSave();
    });
    const api = { deviceTypes, status: MatterStatus, uuid: { generate: (id: string) => id },
      registerPlatformAccessories: vi.fn((plugin, platform, items: MatterAccessory[]) => {
        for (const item of items) {
          Object.assign(item, { _associatedPlugin: plugin, _associatedPlatform: platform });
        }
        return server.registerPlatformAccessories(plugin, platform, items);
      }),
      unregisterPlatformAccessories: vi.fn((plugin, platform, items) => server.unregisterPlatformAccessories(plugin, platform, items)),
      updatePlatformAccessories: vi.fn((items: MatterAccessory[]) => {
        const update = (async () => {
          if (fireAndForget) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await server.updatePlatformAccessories(items);
        })();
        updates.push(update);
        void update.catch(() => undefined);
        return fireAndForget ? Promise.resolve() : update;
      }),
      updateAccessoryState: (...args: Parameters<MatterAPI['updateAccessoryState']>) => server.updateAccessoryState(...args),
      getAccessoryState: async (...args: Parameters<MatterAPI['getAccessoryState']>) => server.getAccessoryState(...args),
    } as unknown as MatterAPI;
    const send = vi.fn(async () => undefined);
    const adapter = new MatterAdapter(api, send, [], vi.fn());
    cleanups.push(async () => {
      adapter.dispose();
    });
    const cached: HejDevice = { id: 'strip', name: 'Strip', deviceType: 'PowerStrip', online: true,
      deviceState: { power1: true, power2: false, power3: false, power4: true } };
    if (serialized) {
      const types = new Map(Object.values(deviceTypes).map((type) => [type.name, type]));
      const stubs = (clusters: Record<string, unknown>) => Object.fromEntries(Object.keys(clusters).map((name) => [name, {}]));
      const restored: MatterAccessory = { UUID: serialized.uuid, displayName: serialized.displayName, context: serialized.context,
        manufacturer: serialized.manufacturer, model: serialized.model, serialNumber: serialized.serialNumber,
        deviceType: types.get(serialized.deviceType.name!)!, clusters: serialized.clusters ?? {}, handlers: stubs(serialized.clusters ?? {}),
        parts: serialized.parts?.map((part) => ({ ...part, deviceType: types.get(part.deviceType.name!)!, handlers: stubs(part.clusters) })) ?? [] };
      await server.registerPlatformAccessories(serialized.plugin, serialized.platform, [restored]);
      Object.assign(internal.accessories.get(serialized.uuid)!, { _restoredFromCache: true });
      adapter.restore(restored);
    } else {
      await adapter.restoreMissingDevices([cached]);
    }
    if (!serialized) {
      await cache.save(internal.accessories as never);
      const loaded = new MatterAccessoryCache(storage, 'bridge');
      await loaded.load();
      internal.accessoryCache.cancelPendingSave();
      internal.accessoryCache = loaded;
    }
    return { server, internal, adapter, api, cached, send, storage };
  }

  function pauseNotification(server: HostServer) {
    const manager = (server as unknown as { accessoryManager: { notifyPartsListChanged(deps: unknown): Promise<void> } }).accessoryManager;
    const notify = manager.notifyPartsListChanged.bind(manager);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve; 
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve; 
    });
    vi.spyOn(manager, 'notifyPartsListChanged').mockImplementationOnce(async (deps) => {
      entered();
      await gate;
      await notify(deps);
    });
    return { ready, release };
  }

  function extraPort(api: MatterAPI): MatterAccessory {
    const original = vi.mocked(api.registerPlatformAccessories).mock.calls[0]![2][0]!;
    return { ...original, parts: [...original.parts!, {
      ...original.parts![0]!, id: 'power6', displayName: 'Strip 6', clusters: { onOff: { onOff: true } },
    }] };
  }

  test.each(['unregister', 'stop'])('a pending port update cannot resurrect an accessory after %s', async (action) => {
    const { server, internal, api, storage } = await fixture(10);
    const cache = internal.accessoryCache;
    const pause = pauseNotification(server);
    const update = server.updatePlatformAccessories([extraPort(api)]);
    try {
      await pause.ready;
      if (action === 'stop') {
        Object.assign(server, { isRunning: true });
        await server.stop();
      } else {
        await server.unregisterPlatformAccessories('test', 'test', [extraPort(api)]);
      }
      expect(internal.accessories.has('hejhome:matter:strip')).toBe(false);
    } finally {
      pause.release();
      await update;
    }
    expect(internal.accessories.size).toBe(0);
    if (action === 'stop') {
      expect(cache.cancelPendingSave()).toBe(false);
    } else {
      await cache.save(internal.accessories as never);
    }
    const disk = new MatterAccessoryCache(storage, 'bridge');
    await disk.load();
    expect(disk.getAllCached()).toHaveLength(action === 'stop' ? 1 : 0);
  });

  test('a delayed metadata update preserves a newer parent state in memory and on disk', async () => {
    const { server, internal, api, storage } = await fixture(11);
    const sensor: MatterAccessory = { UUID: 'contact', displayName: 'Contact', manufacturer: 'Hejhome', model: 'SensorDo',
      serialNumber: 'contact', context: {}, deviceType: deviceTypes.ContactSensor,
      clusters: { bridgedDeviceBasicInformation: { reachable: true }, booleanState: { stateValue: false } } };
    await api.registerPlatformAccessories('test', 'test', [sensor]);
    const pause = pauseNotification(server);
    const update = server.updatePlatformAccessories([extraPort(api)]);
    await pause.ready;
    const metadata = server.updatePlatformAccessories([{ ...sensor, clusters: structuredClone(sensor.clusters) }]);
    try {
      await server.updateAccessoryState('contact', 'booleanState', { stateValue: true });
    } finally {
      pause.release();
      await Promise.all([update, metadata]);
    }
    expect(server.getAccessoryState('contact', 'booleanState')?.stateValue).toBe(true);
    await internal.accessoryCache.save(internal.accessories as never);
    const disk = new MatterAccessoryCache(storage, 'bridge');
    await disk.load();
    expect(disk.getCached('contact')?.clusters?.booleanState?.stateValue).toBe(true);
  });

  test('metadata changes retain the cache container held by an in-flight state transaction', async () => {
    const { server, internal, api, storage } = await fixture(13);
    const sensor: MatterAccessory = { UUID: 'contact', displayName: 'Contact', manufacturer: 'Hejhome', model: 'SensorDo',
      serialNumber: 'contact', context: {}, deviceType: deviceTypes.ContactSensor, clusters: { booleanState: { stateValue: false } } };
    await api.registerPlatformAccessories('test', 'test', [sensor]);
    const endpoint = internal.accessories.get('contact')!.endpoint;
    const set = endpoint.set.bind(endpoint);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(endpoint, 'set').mockImplementationOnce(async (state) => {
      entered();
      await gate;
      await set(state);
    });
    const report = server.updateAccessoryState('contact', 'booleanState', { stateValue: true });
    await ready;
    try {
      await server.updatePlatformAccessories([{ ...sensor, displayName: 'Renamed contact', clusters: structuredClone(sensor.clusters) }]);
    } finally {
      release();
      await report;
    }
    await internal.accessoryCache.save(internal.accessories as never);
    const disk = new MatterAccessoryCache(storage, 'bridge');
    await disk.load();
    expect(disk.getCached('contact')?.clusters?.booleanState?.stateValue).toBe(true);
    expect(disk.getCached('contact')?.displayName).toBe('Renamed contact');
  });

  test('an update queued for an old endpoint cannot overwrite a replacement with the same UUID', async () => {
    const { server, internal, api } = await fixture(12);
    const sensor: MatterAccessory = { UUID: 'contact', displayName: 'Old contact', manufacturer: 'Hejhome', model: 'SensorDo',
      serialNumber: 'contact', context: {}, deviceType: deviceTypes.ContactSensor, clusters: { booleanState: { stateValue: false } } };
    await api.registerPlatformAccessories('test', 'test', [sensor]);
    const pause = pauseNotification(server);
    const update = server.updatePlatformAccessories([extraPort(api)]);
    await pause.ready;
    const metadata = server.updatePlatformAccessories([sensor]);
    try {
      await server.unregisterPlatformAccessories('test', 'test', [sensor]);
      await api.registerPlatformAccessories('test', 'test', [{ ...sensor, displayName: 'New contact' }]);
    } finally {
      pause.release();
      await Promise.all([update, metadata]);
    }
    expect((internal.accessories.get('contact') as unknown as MatterAccessory).displayName).toBe('New contact');
  });

  test('a part creation interrupted by replacement cannot overwrite the new command handler', async () => {
    const { server, internal, api } = await fixture(14);
    const uuid = 'hejhome:matter:strip';
    const parent = internal.accessories.get(uuid)!;
    const add = parent.endpoint.add.bind(parent.endpoint);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(parent.endpoint, 'add').mockImplementationOnce(async (part) => {
      const result = await add(part);
      entered();
      await gate;
      return result;
    });
    const stale = vi.fn(async () => undefined);
    const correct = vi.fn(async () => undefined);
    const original = extraPort(api);
    const requested = { ...original, parts: original.parts!.map((part) => part.id === 'power6'
      ? { ...part, handlers: { onOff: { on: stale } } } : part) };
    const update = server.updatePlatformAccessories([requested]);
    await ready;
    try {
      await server.unregisterPlatformAccessories('test', 'test', [requested]);
      await api.registerPlatformAccessories('test', 'test', [{ ...original, parts: original.parts!.map((part) => part.id === 'power6'
        ? { ...part, handlers: { onOff: { on: correct } } } : part) }]);
    } finally {
      release();
      await update;
    }
    await server.triggerCommand(uuid, 'onOff', 'on', {}, 'power6');
    expect(stale).not.toHaveBeenCalled();
    expect(correct).toHaveBeenCalledOnce();
  });

  test.each([false, true])('late power6 preserves parent and original ports (asynchronous host: %s)', async (fireAndForget) => {
    const { server, internal, adapter, api, cached } = await fixture(1, fireAndForget);
    const uuid = 'hejhome:matter:strip';
    const parent = internal.accessories.get(uuid)!;
    const endpoint = parent.endpoint;
    const original = parent._parts.map((part) => ({ id: part.id, endpoint: part.endpoint, number: part.endpoint.number }));
    await adapter.reconcile([{ ...cached, deviceState: { ...cached.deviceState, power6: true } }]);
    expect(server.getAccessoryState(uuid, 'onOff', 'power6')?.onOff).toBe(true);
    expect(internal.accessories.get(uuid)!.endpoint).toBe(endpoint);
    for (const before of original) {
      const after = internal.accessories.get(uuid)!._parts.find((part) => part.id === before.id)!;
      expect(after.endpoint).toBe(before.endpoint);
      expect(after.endpoint.number).toBe(before.number);
    }
    const parts = internal.accessories.get(uuid)!._parts;
    expect(parts.map((part) => part.id)).toEqual(['power1', 'power2', 'power3', 'power4', 'power6']);
    expect(parts.map((part) => server.getAccessoryState(uuid, 'descriptor', part.id)?.tagList)).toEqual(
      [0, 1, 2, 3, 4].map((tag) => [expect.objectContaining({ tag })]));
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(api.registerPlatformAccessories).toHaveBeenCalledOnce();
    await adapter.update({ ...cached, deviceState: { ...cached.deviceState, power6: false } });
    expect(server.getAccessoryState(uuid, 'onOff', 'power6')?.onOff).toBe(false);
  });

  test('a native cached strip can add a port and rebind old commands without recreating its parent', async () => {
    const { server, internal, adapter: old, api, cached } = await fixture(2);
    const uuid = 'hejhome:matter:strip';
    const before = internal.accessories.get(uuid)!;
    old.dispose();
    Object.assign(before, { _restoredFromCache: true });
    const send = vi.fn(async () => undefined);
    const adapter = new MatterAdapter(api, send, [], vi.fn());
    cleanups.push(async () => {
      adapter.dispose(); 
    });
    adapter.restore(vi.mocked(api.registerPlatformAccessories).mock.calls[0]![2][0]!);
    await adapter.reconcile([{ ...cached, deviceState: { ...cached.deviceState, power6: true } }]);
    expect(internal.accessories.get(uuid)!.endpoint).toBe(before.endpoint);
    await server.triggerCommand(uuid, 'onOff', 'off', {}, 'power1');
    expect(send).toHaveBeenCalledWith('strip', { power1: false });
    expect(server.getAccessoryState(uuid, 'onOff', 'power6')?.onOff).toBe(true);
    expect(api.registerPlatformAccessories).toHaveBeenCalledOnce();
  });

  test('repeated and concurrent updates add only one endpoint and keep omitted known ports', async () => {
    const { server, internal, api, storage } = await fixture(3);
    const uuid = 'hejhome:matter:strip';
    const original = vi.mocked(api.registerPlatformAccessories).mock.calls[0]![2][0]!;
    const withPort = { ...original, parts: [...original.parts!, {
      ...original.parts![0]!, id: 'power6', displayName: 'Strip 6', clusters: { onOff: { onOff: true } },
    }] };
    await Promise.all([server.updatePlatformAccessories([withPort]), server.updatePlatformAccessories([withPort])]);
    const parent = internal.accessories.get(uuid)!;
    const added = parent._parts.find((part) => part.id === 'power6')!.endpoint;
    expect(parent._parts.filter((part) => part.id === 'power6')).toHaveLength(1);
    await server.updatePlatformAccessories([original]);
    expect(internal.accessories.get(uuid)!._parts.find((part) => part.id === 'power6')!.endpoint).toBe(added);
    expect(server.getAccessoryState(uuid, 'onOff', 'power6')?.onOff).toBe(true);
    await internal.accessoryCache.save(internal.accessories as never);
    const disk = new MatterAccessoryCache(storage, 'bridge');
    await disk.load();
    const serialized = disk.getAllCached().find((entry) => entry.uuid === uuid)!;
    expect(serialized.parts?.map((part) => part.id)).toEqual(['power1', 'power2', 'power3', 'power4', 'power6']);
  });

  test('a failed new part is cleaned up and can be retried without removing existing ports', async () => {
    const { server, internal, api } = await fixture(4);
    const uuid = 'hejhome:matter:strip';
    const original = vi.mocked(api.registerPlatformAccessories).mock.calls[0]![2][0]!;
    const parent = internal.accessories.get(uuid)!;
    const before = parent._parts.map((part) => part.endpoint);
    const added = { ...original.parts![0]!, id: 'power6', displayName: 'Strip 6', clusters: { onOff: { onOff: true } } };
    const invalid = { ...original, parts: [...original.parts!, { ...added, handlers: { onOff: null as never } }] };
    await expect(server.updatePlatformAccessories([invalid])).rejects.toThrow();
    expect(internal.accessories.get(uuid)!.endpoint).toBe(parent.endpoint);
    expect(internal.accessories.get(uuid)!._parts.map((part) => part.endpoint)).toEqual(before);
    expect([...parent.endpoint.parts]).toHaveLength(4);
    await server.updatePlatformAccessories([{ ...original, parts: [...original.parts!, added] }]);
    expect(server.getAccessoryState(uuid, 'onOff', 'power6')?.onOff).toBe(true);
    expect([...parent.endpoint.parts]).toHaveLength(5);
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  test('real serialized cache restore adds a port and retains ownership, live state and part tags on the next restart', async () => {
    const first = await fixture(5);
    const uuid = 'hejhome:matter:strip';
    const original = first.internal.accessoryCache.getCached(uuid)!;
    const restored = await fixture(6, false, original);
    const parent = restored.internal.accessories.get(uuid)!;
    const endpoints = parent._parts.map((part) => part.endpoint);
    await restored.adapter.reconcile([{ ...restored.cached, deviceState: { ...restored.cached.deviceState, power6: true } }]);
    expect(restored.internal.accessories.get(uuid)!.endpoint).toBe(parent.endpoint);
    expect(restored.internal.accessories.get(uuid)!._parts.slice(0, 4).map((part) => part.endpoint)).toEqual(endpoints);
    await restored.adapter.reconcile([{ ...restored.cached, deviceState: { ...restored.cached.deviceState, power6: false } }]);
    await restored.server.updateAccessoryState(uuid, 'onOff', { onOff: false }, 'power1');
    await restored.internal.accessoryCache.save(restored.internal.accessories as never);
    const disk = new MatterAccessoryCache(restored.storage, 'bridge');
    await disk.load();
    const saved = disk.getCached(uuid)!;
    expect(saved.plugin).toBe('@chazepps/homebridge-hejhome');
    expect(saved.platform).toBe('Hejhome');
    expect(saved.parts?.find((part) => part.id === 'power1')?.clusters.onOff?.onOff).toBe(false);
    expect(saved.parts?.find((part) => part.id === 'power6')?.clusters.onOff?.onOff).toBe(false);
    const next = await fixture(7, false, saved);
    const before = next.internal.accessories.get(uuid)!.endpoint;
    await next.adapter.reconcile([{ ...next.cached, deviceState: { ...next.cached.deviceState, power6: true } }]);
    expect(next.internal.accessories.get(uuid)!.endpoint).toBe(before);
    expect(next.internal.accessories.get(uuid)!._parts.map((part) => next.server.getAccessoryState(uuid, 'descriptor', part.id)?.tagList))
      .toEqual([0, 1, 2, 3, 4].map((tag) => [expect.objectContaining({ tag })]));
    expect(next.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });
});

test.skipIf(hostPackage.version !== '2.4.0')('host patch checks, applies idempotently and restores original sources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-host-patch-tool-'));
  try {
    await fs.mkdir(path.join(root, 'dist/matter/server'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'homebridge', version: '2.4.0' }));
    const files = ['dist/matter/server.js', 'dist/matter/server/AccessoryManager.js'];
    const originals = await Promise.all(files.map((file) => fs.readFile(path.resolve('node_modules/homebridge', file), 'utf8')));
    for (const [index, file] of files.entries()) {
      await fs.writeFile(path.join(root, file), originals[index]!);
    }
    expect((await patchAdditiveMatterParts(root, 'check')).status).toBe('ready');
    const alias = path.join(root, 'tool-link');
    await fs.symlink(path.resolve('tools/homebridge'), alias, 'dir');
    const linked = spawnSync(process.execPath, [path.join(alias, 'patch-additive-matter-parts.mjs'),
      '--homebridge-root', root, '--check'], { encoding: 'utf8' });
    expect(linked.status).toBe(0);
    expect(linked.stdout.trim()).not.toBe('');
    expect(JSON.parse(linked.stdout).status).toBe('ready');
    const ambiguous = spawnSync(process.execPath, [path.resolve('tools/homebridge/patch-additive-matter-parts.mjs'),
      '--homebridge-root', root, '--check', '--apply'], { encoding: 'utf8' });
    expect(ambiguous.status).toBe(1);
    expect(await fs.readFile(path.join(root, files[0]!), 'utf8')).toBe(originals[0]);
    expect((await patchAdditiveMatterParts(root, 'apply')).status).toBe('applied');
    expect((await patchAdditiveMatterParts(root, 'apply')).status).toBe('already-applied');
    const serverFile = path.join(root, files[0]!);
    const patched = await fs.readFile(serverFile, 'utf8');
    await fs.writeFile(serverFile, `${patched}\n// changed outside the patch\n`);
    await expect(patchAdditiveMatterParts(root, 'check')).rejects.toThrow('changed');
    await expect(patchAdditiveMatterParts(root, 'restore')).rejects.toThrow('Refusing to overwrite');
    await fs.writeFile(serverFile, patched);
    expect((await patchAdditiveMatterParts(root, 'restore')).status).toBe('restored');
    for (const [index, file] of files.entries()) {
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(originals[index]);
    }
    await expect(fs.stat(path.join(root, 'dist/matter/hejhome-additive-parts.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'homebridge', version: '99.0.0' }));
    await expect(patchAdditiveMatterParts(root, 'apply')).rejects.toThrow('only for Homebridge 2.4.0');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.skipIf(hostPackage.version !== '2.4.0').each(['corrupt', 'missing', 'manifest'])('invalid %s recovery data is rejected', async (damage) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-host-restore-integrity-'));
  try {
    await fs.mkdir(path.join(root, 'dist/matter/server'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'homebridge', version: '2.4.0' }));
    const files = ['dist/matter/server.js', 'dist/matter/server/AccessoryManager.js', 'dist/matter/hejhome-additive-parts.js'];
    for (const file of files.slice(0, 2)) {
      await fs.copyFile(path.resolve('node_modules/homebridge', file), path.join(root, file));
    }
    const applied = await patchAdditiveMatterParts(root, 'apply');
    const working = await Promise.all(files.map((file) => fs.readFile(path.join(root, file))));
    const original = path.join(applied.backup, files[1]!);
    if (damage === 'corrupt') {
      await fs.appendFile(original, '\n!!! damaged original !!!\n');
    } else if (damage === 'missing') {
      await fs.rm(original);
    } else {
      const file = path.join(applied.backup, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.files = [];
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    await expect(patchAdditiveMatterParts(root, 'restore')).rejects.toThrow();
    for (const [index, file] of files.entries()) {
      expect((await fs.readFile(path.join(root, file))).equals(working[index]!)).toBe(true);
    }
    expect((await fs.stat(applied.backup)).isDirectory()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
