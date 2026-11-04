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
import { MatterSceneAdapter } from '../src/matter/scenes.js';
import { HomebridgeOnOffServer } from '../node_modules/homebridge/dist/matter/behaviors/OnOffBehavior.js';
import { MatterAPIImpl } from '../node_modules/homebridge/dist/matter/MatterAPIImpl.js';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import type { EstimatedElectricalState } from '../src/runtime/powerEstimates.js';
import type { HejDevice } from '../src/types.js';

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

test('a recipe executes through the native Matter command, resets after its commit, and keeps its endpoint after cache restore', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-recipe-cache-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const recipe = { familyId: 100, sceneId: 's8-main', name: 'Recipe' };
  const run = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const first = await host(storage, 50);
  // Production uses a UUID generator; this host normally uses readable IDs for device assertions.
  const hap = new HomebridgeAPI().hap;
  first.api.uuid.generate = hap.uuid.generate;
  const scenes = new MatterSceneAdapter(first.api, run, onError);
  cleanups.push(async () => scenes.dispose());
  await scenes.reconcile([recipe], new Set([100]), new Set([100]), () => true);
  expect(onError).not.toHaveBeenCalled();
  expect(first.accessories.size).toBe(1);
  const [uuid, item] = [...first.accessories][0]!;
  await item.endpoint.act((agent) => agent.get(HomebridgeOnOffServer).on());
  expect(run).toHaveBeenCalledOnce();
  expect(first.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(true);
  // Matter batches reports for 50 ms. Keep On observable beyond that batch so an
  // optimistic controller cannot commit On after receiving an already-coalesced Off.
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(first.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(true);
  await vi.waitFor(() => expect(first.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(false), { timeout: 2000 });
  await item.endpoint.act((agent) => agent.get(HomebridgeOnOffServer).off());
  expect(run).toHaveBeenCalledOnce();
  await item.endpoint.act((agent) => agent.get(HomebridgeOnOffServer).toggle());
  expect(run).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(first.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(false), { timeout: 2000 });
  await first.cache.save(first.accessories);

  const second = await host(storage, 51);
  const cached = second.cache.getAllCached()[0]!;
  second.api.uuid.generate = hap.uuid.generate;
  const restored: MatterAccessory = { UUID: cached.uuid, displayName: cached.displayName, context: cached.context,
    serialNumber: cached.serialNumber, manufacturer: cached.manufacturer, model: cached.model,
    deviceType: deviceTypes.OnOffOutlet, clusters: cached.clusters ?? {}, handlers: { onOff: {} } };
  await second.manager.registerAccessory('test-plugin', 'Hejhome', restored, second.deps);
  second.accessories.get(uuid)!._restoredFromCache = true;
  const endpoint = second.accessories.get(uuid)!.endpoint;
  const restoredScenes = new MatterSceneAdapter(second.api, run, onError);
  cleanups.push(async () => restoredScenes.dispose());
  restoredScenes.restore(restored);
  await restoredScenes.prune(true);
  expect(second.states.getAccessoryState(uuid, 'bridgedDeviceBasicInformation')?.reachable).toBe(false);
  await restoredScenes.reconcile([recipe], new Set([100]), new Set([100]), () => true);
  expect(second.accessories.size).toBe(1);
  expect(second.accessories.get(uuid)!.endpoint).toBe(endpoint);
  await endpoint.act((agent) => agent.get(HomebridgeOnOffServer).on());
  await vi.waitFor(() => expect(second.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(false), { timeout: 2000 });
  expect(run).toHaveBeenCalledTimes(3);
  run.mockRejectedValue(new Error('Cloud failed'));
  await expect(endpoint.act((agent) => agent.get(HomebridgeOnOffServer).on())).rejects.toThrow();
  expect(second.states.getAccessoryState(uuid, 'onOff')?.onOff).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});

test('recipe opt-out retries late native removal failure and can republish the same recipe', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-recipe-removal-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const runtime = await host(storage, 60);
  const api = new HomebridgeAPI();
  runtime.api.uuid.generate = api.hap.uuid.generate;
  const recipe = { familyId: 100, sceneId: 'main', name: 'Recipe' };
  const run = vi.fn();
  const onError = vi.fn();
  const publisher = new MatterSceneAdapter(runtime.api, run, onError);
  cleanups.push(async () => publisher.dispose());
  await publisher.reconcile([recipe], new Set([100]), new Set([100]), () => true);
  const [uuid, accessory] = [...runtime.accessories][0]!;
  const internals = api as unknown as { _matterManager: unknown; _matterServer: unknown };
  internals._matterManager = { hasActiveMatter: () => true, getExternalServer: () => undefined, isBridgeServerStarting: () => false };
  internals._matterServer = runtime.states;
  const removals: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  api.on('unregisterMatterPlatformAccessories', (_plugin, _platform, items: MatterAccessory[]) => {
    for (const item of items) {
      removals.push(new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => runtime.manager.unregisterAccessory(item.UUID, runtime.deps)).catch((error: unknown) => failures.push(error)));
    }
  });
  api.on('registerMatterPlatformAccessories', (plugin, platform, items: MatterAccessory[]) => {
    for (const item of items) {
      void runtime.manager.registerAccessory(plugin, platform, item, runtime.deps).catch(onError);
    }
  });
  const adapter = new MatterSceneAdapter(new MatterAPIImpl(api), run, onError);
  cleanups.push(async () => adapter.dispose());
  adapter.restore(accessory);
  accessory._restoredFromCache = true;
  await adapter.reconcile([recipe], new Set([100]), new Set([100]), () => true);
  vi.spyOn(accessory.endpoint, 'close').mockRejectedValueOnce(new Error('Transient native close failure'));
  await adapter.prune(false);
  await Promise.all(removals.splice(0));
  expect(failures).toHaveLength(1);
  expect(runtime.accessories.has(uuid)).toBe(true);
  await adapter.prune(false);
  await Promise.all(removals.splice(0));
  expect(runtime.accessories.has(uuid)).toBe(false);
  await adapter.reconcile([recipe], new Set([100]), new Set([100]), () => true);
  expect(runtime.accessories.has(uuid)).toBe(true);
  expect(runtime.accessories.size).toBe(1);
  expect(run).not.toHaveBeenCalled();
});

test('seven cached devices recover before cloud discovery and retain their native endpoints over two restarts', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-startup-cache-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const devices: HejDevice[] = [
    { id: 'relay', name: 'Relay', deviceType: 'RelayController', deviceState: { power1: false } },
    { id: 'rgb', name: 'RGB', deviceType: 'LightRgbw5', deviceState: { power: true, lightMode: 'COLOUR',
      brightness: 50, hsvColor: { hue: 120, saturation: 60, brightness: 50 } } },
    { id: 'motion', name: 'Motion', deviceType: 'SensorMo', deviceState: { motionDetected: false, battery: 61 } },
    ...['bathroom', 'living', 'bedroom', 'kitchen'].map((id, index) => ({ id, name: id,
      deviceType: index < 2 ? 'ZigbeeSwitch2' : 'ZigbeeSwitch1', deviceState: { power1: true, ...(index < 2 ? { power2: false } : {}) } })),
  ];
  const first = await host(storage, 10);
  // No native Matter cache: recover the HAP device inventory without cloud I/O.
  expect(await first.adapter.restoreMissingDevices(devices)).toBe(7);
  expect(first.accessories.size).toBe(7);
  expect(first.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  for (const accessory of first.accessories.values()) {
    expect(first.states.getAccessoryState(accessory.UUID, 'bridgedDeviceBasicInformation')?.reachable).toBe(false);
  }
  await first.adapter.reconcile(devices);
  expect(first.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  await first.cache.save(first.accessories);

  const types = new Map(Object.entries(deviceTypes));
  for (const type of Object.values(deviceTypes)) {
    types.set(type.name, type);
  }
  for (let cycle = 11; cycle <= 12; cycle++) {
    const runtime = await host(storage, cycle);
    for (const cached of runtime.cache.getAllCached()) {
      // Match Homebridge's pre-online deserialization and handler stubs.
      const handlers = (clusters: Record<string, unknown> | undefined) =>
        Object.fromEntries(Object.keys(clusters ?? {}).map((name) => [name, {}]));
      const restored: MatterAccessory = { UUID: cached.uuid, displayName: cached.displayName, context: cached.context,
        serialNumber: cached.serialNumber, manufacturer: cached.manufacturer, model: cached.model,
        deviceType: types.get(cached.deviceType.name!)!, clusters: cached.clusters ?? {}, handlers: handlers(cached.clusters),
        ...(cached.parts ? { parts: cached.parts.map((part) => ({ id: part.id, displayName: part.displayName,
          deviceType: types.get(part.deviceType.name!)!, clusters: part.clusters, handlers: handlers(part.clusters) })) } : {}),
      };
      await runtime.manager.registerAccessory('test-plugin', 'Hejhome', restored, runtime.deps);
      runtime.accessories.get(cached.uuid)!._restoredFromCache = true;
      runtime.adapter.restore(restored);
    }
    const endpoints = new Map([...runtime.accessories].map(([uuid, accessory]) => [uuid,
      { parent: accessory.endpoint, parts: accessory._parts?.map((part) => part.endpoint) }]));
    expect(await runtime.adapter.restoreMissingDevices(devices.slice(0, 1))).toBe(0);
    expect(runtime.accessories.size).toBe(7);
    await runtime.adapter.reconcile(devices);
    expect(runtime.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    for (const [uuid, accessory] of runtime.accessories) {
      expect(accessory.endpoint).toBe(endpoints.get(uuid)!.parent);
      expect(accessory._parts?.map((part) => part.endpoint)).toEqual(endpoints.get(uuid)!.parts);
    }
    await runtime.cache.save(runtime.accessories);
    expect(runtime.cache.getAllCached()).toHaveLength(7);
  }
});

test.each([
  ['SensorMo', { motionDetected: false }],
  ['SensorDo', { state: 'CLOSED' }],
  ['SensorTh', { temperature: 21, humidity: 45 }],
  ['SensorWater2', { alarm: false }],
  ['SensorSmoke3', { alarm: false }],
] as const)('%s restores unknown battery then accepts the first battery report without replacing endpoints', async (deviceType, state) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-matter-unknown-battery-'));
  cleanups.push(() => fs.rm(storage, { recursive: true, force: true }));
  const runtime = await host(storage, 20);
  const cached: HejDevice = { id: 'battery-device', name: deviceType, deviceType, deviceState: state };
  await runtime.adapter.restoreMissingDevices([cached]);
  const uuid = 'hejhome:matter:battery-device';
  const endpoint = runtime.accessories.get(uuid)!.endpoint;
  const parts = runtime.accessories.get(uuid)!._parts?.map((part) => part.endpoint);
  expect(runtime.states.getAccessoryState(uuid, 'powerSource')?.batPercentRemaining).toBeNull();
  await runtime.adapter.reconcile([{ ...cached, online: true, deviceState: { ...state, battery: 80 } }]);
  expect(runtime.states.getAccessoryState(uuid, 'powerSource')?.batPercentRemaining).toBe(160);
  expect(runtime.accessories.get(uuid)!.endpoint).toBe(endpoint);
  expect(runtime.accessories.get(uuid)!._parts?.map((part) => part.endpoint)).toEqual(parts);
  expect(runtime.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(runtime.api.registerPlatformAccessories).toHaveBeenCalledOnce();
});

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
