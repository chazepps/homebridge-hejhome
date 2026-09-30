import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI, MatterAccessory } from 'homebridge';
import { Endpoint, Environment, ServerNode } from '@matter/main';
import { MockStorageService, StorageService } from '@matter/general';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { EventEmitter } from 'node:events';
import { MatterAccessoryCache } from '../node_modules/homebridge/dist/matter/accessoryCache.js';
import { AccessoryManager, type AccessoryManagerDeps } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import { StateManager } from '../node_modules/homebridge/dist/matter/server/StateManager.js';
import { BehaviorRegistry, RegistryManager } from '../node_modules/homebridge/dist/matter/behaviors/index.js';
import { MatterAdapter } from '../src/matter/adapter.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function host(storage: string, cycle: number) {
  const environment = new Environment(`hej-pm-cache-${cycle}`, Environment.default);
  environment.set(StorageService, new MockStorageService(environment));
  const node = await ServerNode.create({ id: `pm-cache-${cycle}`, environment });
  const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
  await node.add(aggregator);
  cleanups.push(() => node.close());
  const accessories: AccessoryManagerDeps['accessories'] = new Map();
  const cache = new MatterAccessoryCache(storage, 'bridge');
  await cache.load();
  cleanups.push(async () => {
    cache.cancelPendingSave();
  });
  const deps: AccessoryManagerDeps = {
    accessories, accessoryCache: cache, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
    behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(),
    getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
    getMonitoringEnabled: () => false, isCommissioned: () => false,
  };
  const manager = new AccessoryManager();
  const states = new StateManager(accessories, new EventEmitter(), () => false);
  const api = { deviceTypes, status: MatterStatus, uuid: { generate: (value: string) => value },
    registerPlatformAccessories: vi.fn(async (plugin: string, platform: string, items: MatterAccessory[]) => {
      for (const item of items) {
        await manager.registerAccessory(plugin, platform, item, deps);
      }
    }),
    unregisterPlatformAccessories: vi.fn(async (_plugin: string, _platform: string, items: MatterAccessory[]) => {
      for (const item of items) {
        await manager.unregisterAccessory(item.UUID, deps);
      }
    }),
    updatePlatformAccessories: vi.fn(),
    updateAccessoryState: vi.fn((uuid: string, cluster: string, attributes: Record<string, unknown>, partId?: string) =>
      states.updateAccessoryState(uuid, cluster, attributes, partId)),
    getAccessoryState: vi.fn((uuid: string, cluster: string, partId?: string) =>
      Promise.resolve(states.getAccessoryState(uuid, cluster, partId))),
  } as unknown as MatterAPI;
  const adapter = new MatterAdapter(api, vi.fn(), [], vi.fn(), { purifier: { pm25Multiplier: 0.5 } });
  cleanups.push(async () => {
    adapter.dispose();
  });
  return { accessories, cache, deps, manager, states, adapter, api };
}

test('serialized PM2.5 part keeps its ID and regains NumericMeasurement after discovery', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-pm-cache-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const sample = (pm25: number | null) => ({ id: 'purifier', name: 'Purifier', deviceType: 'Airpurifier',
    deviceState: { power: true, pm25 } });
  const first = await host(storage, 0);
  await first.adapter.reconcile([sample(25)]);
  const uuid = 'hejhome:matter:purifier';
  expect(first.accessories.get(uuid)?.endpoint?.lifecycle.isReady).toBe(true);
  expect(first.accessories.get(uuid)?._parts?.map((part) => part.id)).toEqual(['air-quality']);
  await first.cache.save(first.accessories);

  const restarted = await host(storage, 1);
  const cached = restarted.cache.getAllCached();
  expect(cached).toHaveLength(1);
  const serialized = cached[0]!;
  const basePart = serialized.parts![0]!;
  const restored: MatterAccessory = {
    UUID: serialized.uuid, displayName: serialized.displayName, serialNumber: serialized.serialNumber,
    manufacturer: serialized.manufacturer, model: serialized.model, context: serialized.context,
    deviceType: deviceTypes.OnOffOutlet, clusters: serialized.clusters ?? {}, handlers: { onOff: {} },
    parts: [{ id: basePart.id, displayName: basePart.displayName,
      deviceType: deviceTypes.AirQualitySensor, clusters: basePart.clusters, handlers: {} }],
  };
  await restarted.manager.registerAccessory('homebridge-hejhome', 'Hejhome', restored, restarted.deps);
  restarted.accessories.get(uuid)!._restoredFromCache = true;
  restarted.adapter.restore(restored);
  expect(restarted.accessories.get(uuid)?._parts?.map((part) => part.id)).toEqual(['air-quality']);
  await restarted.adapter.pruneHidden(() => true);
  expect(restarted.states.getAccessoryState(uuid, 'bridgedDeviceBasicInformation')?.reachable).toBe(false);
  // The host's pre-plugin restore uses the base part type; discovery then re-registers
  // the composed NumericMeasurement type through the public registration API.
  await restarted.adapter.reconcile([sample(25)]);
  expect(restarted.accessories.get(uuid)?.endpoint?.lifecycle.isReady).toBe(true);
  expect(restarted.accessories.get(uuid)?._parts?.map((part) => part.id)).toEqual(['air-quality']);
  expect(restarted.api.registerPlatformAccessories).toHaveBeenCalled();
  await restarted.adapter.update(sample(null));
  expect(restarted.states.getAccessoryState(uuid, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue).toBeNull();
  await restarted.adapter.update(sample(30));
  expect(restarted.states.getAccessoryState(uuid, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue).toBe(15);
});
