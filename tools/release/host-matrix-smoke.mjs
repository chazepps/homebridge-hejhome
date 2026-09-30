import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceTypes, MatterStatus } from 'homebridge';
import { Endpoint, Environment, ServerNode } from '@matter/main';
import { MockStorageService, StorageService } from '@matter/general';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { MatterAccessoryCache } from './node_modules/homebridge/dist/matter/accessoryCache.js';
import { AccessoryManager } from './node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import { StateManager } from './node_modules/homebridge/dist/matter/server/StateManager.js';
import { BehaviorRegistry, RegistryManager } from './node_modules/homebridge/dist/matter/behaviors/index.js';
import { MatterAdapter } from './node_modules/@chazepps/homebridge-hejhome/dist/matter/adapter.js';

const phase = Number(process.argv[2]);
const dataDirectory = process.argv[3];
assert([0, 1, 2].includes(phase) && dataDirectory, 'Usage: smoke.mjs <0|1|2> <data-directory>');
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginPackage = JSON.parse(await fs.readFile(path.join(currentDir, 'node_modules/@chazepps/homebridge-hejhome/package.json'), 'utf8'));
const hostPackage = JSON.parse(await fs.readFile(path.join(currentDir, 'node_modules/homebridge/package.json'), 'utf8'));
const stateFile = path.join(dataDirectory, 'identity.json');
const uuid = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const samples = [
  ['relay', 'RelayController', { power1: true }],
  ['switch', 'Switch3', { power1: true, power2: false, power3: true }],
  ['strip', 'PowerStrip', { power1: true, power2: false, power3: false, power4: true }],
  ['plug', 'Plug', { power: true }],
  ['colour', 'LightRgbw5', { power: true, lightMode: 'COLOUR', brightness: 50, hsvColor: { hue: 120, saturation: 60, brightness: 50 } }],
  ['white', 'LightWw1', { power: true, brightness: 50, temperature: 50 }],
  ['curtain', 'Curtain', { percentState: 80, percentControl: 80 }],
  ['motion', 'SensorMo', { motionDetected: true }],
  ['contact', 'SensorDo', { doorOpened: false }],
  ['climate', 'SensorTh', { temperature: 21.5, humidity: 45 }],
  ['water', 'SensorWater2', { alarm: false }],
  ['smoke', 'SensorSmoke3', { alarm: false }],
  ['purifier', 'Airpurifier', { power: true, pm25: 25 }],
  ['doorlock', 'ZigbeeDoorlock', { doorOpened: false }],
];
const devices = samples.map(([id, deviceType, deviceState]) => ({
  id, deviceType, deviceState, name: id === 'switch' ? 'A'.repeat(64) : `Matrix ${id}`, modelName: `Matrix-${deviceType}`,
}));
const hiddenId = 'switch';
const environment = new Environment(`hej-matrix-${phase}`, Environment.default);
environment.set(StorageService, new MockStorageService(environment));
const node = await ServerNode.create({ id: `matrix-${phase}`, environment });
const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
await node.add(aggregator);
const accessories = new Map();
const behaviorRegistry = new BehaviorRegistry(accessories);
const registryManager = new RegistryManager();
const cache = new MatterAccessoryCache(dataDirectory, 'bridge');
await cache.load();
const deps = {
  accessories, behaviorRegistry, registryManager, accessoryCache: cache,
  config: { externalAccessory: false },
  getServerNode: () => node, getAggregator: () => aggregator,
  getIsRunning: () => false, getMonitoringEnabled: () => false, isCommissioned: () => false,
};
const manager = new AccessoryManager();
const stateManager = new StateManager(accessories, new EventEmitter(), () => false);
const errors = [];
const sends = [];
const api = {
  deviceTypes, status: MatterStatus, uuid: { generate: uuid },
  registerPlatformAccessories: async (plugin, platform, items) => {
    for (const item of items) {
      await manager.registerAccessory(plugin, platform, item, deps);
    }
  },
  updatePlatformAccessories: async () => {},
  unregisterPlatformAccessories: async (_plugin, _platform, items) => {
    for (const item of items) {
      await manager.unregisterAccessory(item.UUID, deps);
    }
  },
  updateAccessoryState: (...args) => stateManager.updateAccessoryState(...args),
  getAccessoryState: (...args) => Promise.resolve(stateManager.getAccessoryState(...args)),
};
const adapter = new MatterAdapter(api, async (id, requirements) => {
  sends.push({ id, requirements });
}, [],
(error) => errors.push(String(error)), { purifier: { pm25Multiplier: 0.5 } });
const typeByName = new Map();
for (const [key, value] of Object.entries(deviceTypes)) {
  typeByName.set(key, value);
  if (value.name) {
    typeByName.set(value.name, value);
  }
}
const stubHandlers = (clusters) => Object.fromEntries(Object.keys(clusters ?? {}).map((cluster) => [cluster, {}]));

async function restoreCached() {
  for (const serialized of cache.getAllCached()) {
    const deviceType = typeByName.get(serialized.deviceType?.name);
    assert(deviceType, `Unknown cached device type: ${serialized.deviceType?.name}`);
    const parts = (serialized.parts ?? []).map((part) => ({
      id: part.id, displayName: part.displayName, deviceType: typeByName.get(part.deviceType?.name),
      clusters: part.clusters ?? {}, handlers: stubHandlers(part.clusters),
    }));
    assert(parts.every((part) => part.deviceType), 'Unknown cached part device type');
    const restored = {
      UUID: serialized.uuid, displayName: serialized.displayName, deviceType,
      serialNumber: serialized.serialNumber, manufacturer: serialized.manufacturer, model: serialized.model,
      context: serialized.context ?? {}, clusters: serialized.clusters ?? {}, handlers: stubHandlers(serialized.clusters),
      parts: parts.length ? parts : undefined,
    };
    await manager.registerAccessory(serialized.plugin, serialized.platform, restored, deps);
    accessories.get(restored.UUID)._restoredFromCache = true;
    adapter.restore(restored);
  }
}

try {
  await fs.mkdir(dataDirectory, { recursive: true });
  if (phase === 0) {
    assert.equal(cache.getAllCached().length, 0, 'Initial phase must start without a cache');
    await adapter.reconcile(devices);
    assert.equal(accessories.size, devices.length);
    const identity = Object.fromEntries(devices.map((device) => {
      const id = uuid(`hejhome:matter:${device.id}`);
      const accessory = accessories.get(id);
      assert(accessory?.endpoint?.lifecycle.isReady, `Not ready: ${device.id}`);
      assert.equal(accessory.endpoint.parts.size, accessory.parts?.length ?? 0);
      return [device.id, { uuid: id, name: accessory.displayName, parts: (accessory.parts ?? []).map((part) => part.id) }];
    }));
    assert.equal(identity.switch.name.length, 32);
    assert.deepEqual(identity.switch.parts, ['power1', 'power2', 'power3']);
    assert.deepEqual(identity.purifier.parts, ['air-quality']);
    assert.equal(stateManager.getAccessoryState(identity.purifier.uuid, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue,
      12.5);
    const switchAccessory = accessories.get(identity.switch.uuid);
    assert.deepEqual(switchAccessory.parts.map((part) => part.displayName),
      [1, 2, 3].map((index) => `${identity.switch.name} ${index}`));
    await behaviorRegistry.executeHandler(`${identity.switch.uuid}-part-power2`, 'onOff', 'on', {});
    assert.deepEqual(sends, [{ id: 'switch', requirements: { power2: true } }]);
    await fs.writeFile(stateFile, JSON.stringify(identity, null, 2));
  } else if (phase === 1) {
    const identity = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    await restoreCached();
    assert.equal(accessories.size, devices.length);
    const retained = accessories.get(identity.relay.uuid).endpoint;
    await adapter.pruneHidden((id) => id !== hiddenId);
    assert.equal(accessories.has(identity.switch.uuid), false, 'Explicit hidden setting did not remove cached switch');
    assert.equal(accessories.size, devices.length - 1, 'Allowed cache was removed');
    assert.equal(accessories.get(identity.relay.uuid).endpoint, retained, 'Allowed cache endpoint was rebuilt');
    assert.equal(stateManager.getAccessoryState(identity.relay.uuid, 'bridgedDeviceBasicInformation')?.reachable, false);
    assert.deepEqual(accessories.get(identity.purifier.uuid)?._parts?.map((part) => part.id), ['air-quality']);
    assert.equal(sends.length, 0, 'Outage-only config change sent a vendor command');
  } else {
    const identity = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    await restoreCached();
    assert.equal(accessories.size, devices.length - 1);
    const restoredEndpoints = new Map([...accessories].map(([id, accessory]) => [id, accessory.endpoint]));
    await adapter.reconcile(devices);
    assert.equal(accessories.size, devices.length);
    for (const device of devices) {
      const expected = identity[device.id];
      const accessory = accessories.get(expected.uuid);
      assert(accessory?.endpoint?.lifecycle.isReady, `Not ready after restore: ${device.id}`);
      assert.equal(accessory.displayName, expected.name);
      assert.deepEqual((accessory.parts ?? []).map((part) => part.id), expected.parts);
      if (device.id !== hiddenId && device.id !== 'purifier') {
        assert.equal(accessory.endpoint, restoredEndpoints.get(expected.uuid), `Endpoint identity changed: ${device.id}`);
      }
    }
    // The installed Homebridge cache stores only child type name/code, so it
    // restores the PM part without NumericMeasurement. Fresh discovery repairs it
    // through unregister/register with the same logical UUID and stable part ID.
    assert.notEqual(accessories.get(identity.purifier.uuid).endpoint, restoredEndpoints.get(identity.purifier.uuid));
    const purifier = devices.find((device) => device.id === 'purifier');
    await adapter.update({ ...purifier, deviceState: { ...purifier.deviceState, pm25: null } });
    assert.equal(stateManager.getAccessoryState(identity.purifier.uuid, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue,
      null, 'PM2.5 part did not accept stale null after fresh discovery');
    await adapter.update({ ...purifier, deviceState: { ...purifier.deviceState, pm25: 30 } });
    assert.equal(stateManager.getAccessoryState(identity.purifier.uuid, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue,
      15, 'PM2.5 part did not recover after fresh discovery');
    await adapter.pruneHidden(() => false);
    assert.equal(accessories.size, 0, 'Global Matter opt-out did not remove cached endpoints');
  }
  assert.deepEqual(errors, [], 'Matter adapter reported errors');
  await cache.save(accessories);
  const result = { phase, node: process.version, host: hostPackage.version, plugin: pluginPackage.version,
    nativeRegistered: accessories.size, originalFamilies: devices.length, vendorCommands: sends.length };
  await fs.writeFile(path.join(dataDirectory, `phase-${phase}.json`), JSON.stringify(result, null, 2));
  console.log(`MATRIX_RESULT ${JSON.stringify(result)}`);
} finally {
  adapter.dispose();
  cache.cancelPendingSave();
  await node.close();
}
