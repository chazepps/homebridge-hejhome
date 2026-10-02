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
import type { EstimatedElectricalState } from '../src/runtime/powerEstimates.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function host(storage: string, cycle: number, estimate?: () => EstimatedElectricalState) {
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
  const adapter = new MatterAdapter(api, vi.fn(), [], vi.fn(), { purifier: { pm25Multiplier: 0.5 } }, estimate);
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


test('an existing RGB light gains estimated electrical clusters after cache restore and retains its UUID and light type', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-power-cache-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const sample = { id: 'lamp', name: 'Stand', deviceType: 'LightRgbw5', online: true,
    deviceState: { power: true, lightMode: 'COLOUR' as const, brightness: 50, hsvColor: { hue: 120, saturation: 60, brightness: 50 } } };
  const first = await host(storage, 2);
  await first.adapter.reconcile([sample]);
  await first.cache.save(first.accessories);
  const restarted = await host(storage, 3, () => ({ activePower: 10000, cumulativeEnergyImported: 1234 }));
  const serialized = restarted.cache.getAllCached()[0]!;
  const uuid = 'hejhome:matter:lamp';
  const restored: MatterAccessory = { UUID: serialized.uuid, displayName: serialized.displayName, serialNumber: serialized.serialNumber,
    manufacturer: serialized.manufacturer, model: serialized.model, context: serialized.context,
    deviceType: deviceTypes.ExtendedColorLight, clusters: serialized.clusters ?? {},
    handlers: Object.fromEntries(Object.keys(serialized.clusters ?? {}).map((key) => [key, {}])) };
  await restarted.manager.registerAccessory('homebridge-hejhome', 'Hejhome', restored, restarted.deps);
  const oldEndpoint = restarted.accessories.get(uuid)!.endpoint;
  restarted.accessories.get(uuid)!._restoredFromCache = true;
  restarted.adapter.restore(restored);
  await restarted.adapter.reconcile([sample]);
  const registered = restarted.accessories.get(uuid)!;
  expect(registered.UUID).toBe(uuid);
  expect(registered.deviceType.name).toBe(deviceTypes.ExtendedColorLight.name);
  expect(registered.endpoint).not.toBe(oldEndpoint);
  expect(registered.endpoint?.lifecycle.isReady).toBe(true);
  expect(restarted.states.getAccessoryState(uuid, 'electricalPowerMeasurement')).toMatchObject({ activePower: 10000,
    accuracy: [{ measurementType: 5, measured: false }] });
  expect(restarted.states.getAccessoryState(uuid, 'electricalEnergyMeasurement')).toMatchObject({
    cumulativeEnergyImported: { energy: 1234 }, accuracy: { measurementType: 14, measured: false } });
  const descriptor = restarted.states.getAccessoryState(uuid, 'descriptor');
  expect((descriptor?.deviceTypeList as Array<{ deviceType: number }>).map((entry) => entry.deviceType)).toEqual(
    expect.arrayContaining([0x010d, 0x0510]));
  await restarted.cache.save(restarted.accessories);
  const diskCache = new MatterAccessoryCache(storage, 'bridge');
  await diskCache.load();
  const cachedWithEnergy = diskCache.getAllCached().find((item) => item.uuid === uuid)!;
  expect(cachedWithEnergy.clusters?.electricalPowerMeasurement).toMatchObject({ activePower: 10000 });
});

test('actual electrical endpoint replaces the previous account total immediately but retains same-account cadence', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-owner-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  let estimate: EstimatedElectricalState = { activePower: 10000, cumulativeEnergyImported: 4321 };
  const runtime = await host(storage, 4, () => estimate);
  const lamp = { id: 'lamp', name: 'Lamp', deviceType: 'LightRgbw5', online: true,
    deviceState: { power: true, lightMode: 'COLOUR' as const, brightness: 50, hsvColor: { hue: 120, saturation: 60, brightness: 50 } } };
  const uuid = 'hejhome:matter:lamp';
  runtime.adapter.setElectricalAccount('account-a');
  await runtime.adapter.reconcile([lamp]);
  expect(runtime.states.getAccessoryState(uuid, 'electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: 4321 });
  estimate = { activePower: null, cumulativeEnergyImported: null };
  await runtime.adapter.update({ ...lamp, online: false });
  runtime.adapter.setElectricalAccount('account-b');
  await runtime.adapter.update({ ...lamp, online: false });
  expect(runtime.states.getAccessoryState(uuid, 'electricalEnergyMeasurement')?.cumulativeEnergyImported).toBeNull();
  estimate = { activePower: 10000, cumulativeEnergyImported: 200 };
  await runtime.adapter.reconcile([lamp]);
  expect(runtime.states.getAccessoryState(uuid, 'bridgedDeviceBasicInformation')?.reachable).toBe(true);
  expect(runtime.states.getAccessoryState(uuid, 'electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: 200 });
  runtime.adapter.setElectricalAccount('account-b');
  estimate = { activePower: 10000, cumulativeEnergyImported: 201 };
  await runtime.adapter.reconcile([lamp]);
  expect(runtime.states.getAccessoryState(uuid, 'electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: 200 });
});
