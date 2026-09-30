import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI } from 'homebridge';
import { Endpoint, ServerNode, Environment } from '@matter/main';
import { StorageService, MockStorageService } from '@matter/general';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { AccessoryManager, type AccessoryManagerDeps } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import { StateManager } from '../node_modules/homebridge/dist/matter/server/StateManager.js';
import { BehaviorRegistry, RegistryManager } from '../node_modules/homebridge/dist/matter/behaviors/index.js';
import { createMatterAccessory } from '../src/matter/accessory.js';
import { MatterAdapter } from '../src/matter/adapter.js';

const api = { deviceTypes, status: MatterStatus, uuid: { generate: () => 'device-test' } } as unknown as MatterAPI;
const coreDeviceTypes = [
  'RelayController', 'Switch3', 'PowerStrip', 'Plug', 'IrTv', 'Airpurifier', 'LightRgbw5', 'LightWw1', 'Curtain',
  'SensorMo', 'SensorDo', 'ZigbeeDoorlock', 'SensorTh', 'SensorWater2', 'SensorSmoke3',
];
const pmLabelCases = [['hangul', '가'.repeat(32)], ['emoji', '😀'.repeat(20)]];

describe('real Matter endpoint conformance', () => {
  test.each(coreDeviceTypes)('%s registers and restores on the installed host', async (deviceType) => {
    const environment = new Environment('hej-conformance', Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `test-${deviceType}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const a = createMatterAccessory(api, () => ({ id: 'test', name: 'Device', deviceType, modelName: 'M1',
        deviceState: { ...(['IrTv', 'Airpurifier'].includes(deviceType) ? { power: true } : {}),
          ...(deviceType === 'ZigbeeDoorlock' ? { doorOpened: false } : {}), power1: true,
          battery: 40, temperature: 20, humidity: 50, alarm: false,
          lightMode: 'COLOUR', brightness: 50, hsvColor: { hue: 120, saturation: 60, brightness: 50 } } }), send,
      [{ model: 'M1', power: { field: 'curPower', multiplier: 1 }, energy: { field: 'total', multiplier: 1 } }])!;
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      const manager = new AccessoryManager();
      await manager.registerAccessory('homebridge-hejhome', 'Hejhome', a, deps);
      const registered = accessories.get(a.UUID)!;
      expect(registered.endpoint?.lifecycle.isReady).toBe(true);
      expect(registered.endpoint?.parts.size).toBe(a.parts?.length ?? 0);
      if (deviceType === 'Switch3') {
        const id = `${a.UUID}-part-power2`;
        await deps.behaviorRegistry.executeHandler(id, 'onOff', 'on', {});
        expect(send).toHaveBeenCalledWith({ power2: true });
      }
      if (deviceType === 'LightRgbw5') {
        await deps.behaviorRegistry.executeHandler(a.UUID, 'levelControl', 'step',
          { stepMode: 0, stepSize: 25, transitionTime: 0 });
        expect(send).toHaveBeenCalledWith({ hsvColor: { hue: 120, saturation: 60, brightness: 60 } });
      }
      // The host attaches registrations to restored endpoints instead of replacing identities.
      registered._restoredFromCache = true;
      deps.behaviorRegistry.clear();
      await manager.registerAccessory('homebridge-hejhome', 'Hejhome', a, deps);
      expect(accessories.get(a.UUID)?.endpoint).toBe(registered.endpoint);
      if (deviceType === 'RelayController') {
        await deps.behaviorRegistry.executeHandler(a.UUID, 'onOff', 'off', {});
        expect(send).toHaveBeenCalledWith({ power1: false });
      }
    } finally {
      await node.close();
    }
  });

  test.each([
    ['LightWw1', { power: true, brightness: 50 }],
    ['LightRgbw5', { power: true, lightMode: 'COLOUR', brightness: 50 }],
    ['LightRgbw5', { power: true, lightMode: 'WHITE', brightness: 50 }],
  ])('%s with unknown colour measurement registers as unreachable', async (deviceType, deviceState) => {
    const environment = new Environment('hej-unknown-colour', Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `unknown-${deviceType}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const a = createMatterAccessory(api, () => ({ id: 'test', name: 'Device', deviceType, deviceState }), vi.fn(), [])!;
      expect(a.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      await new AccessoryManager().registerAccessory('homebridge-hejhome', 'Hejhome', a, deps);
      expect(accessories.get(a.UUID)?.endpoint?.lifecycle.isReady).toBe(true);
    } finally {
      await node.close();
    }
  });

  test.each([
    ['SensorMo', { motionDetected: null }],
    ['SensorDo', { doorOpened: null }],
    ['SensorWater2', { alarm: null }],
    ['SensorSmoke3', { alarm: null }],
    ['RelayController', { power1: null }],
    ['Switch2', { power1: true, power2: null }],
  ])('%s with unknown boolean state registers as unreachable', async (deviceType, deviceState) => {
    const environment = new Environment('hej-unknown-boolean', Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `unknown-${deviceType}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const a = createMatterAccessory(api, () => ({ id: 'test', name: 'Device', deviceType, deviceState }), vi.fn(), [])!;
      expect(a.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      await new AccessoryManager().registerAccessory('homebridge-hejhome', 'Hejhome', a, deps);
      expect(accessories.get(a.UUID)?.endpoint?.lifecycle.isReady).toBe(true);
    } finally {
      await node.close();
    }
  });

  test('actual host preserves smoke alarm state through unknown, then accepts a real clear', async () => {
    const environment = new Environment('hej-smoke-three-phase', Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: 'smoke-three-phase', environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      const manager = new AccessoryManager();
      const states = new StateManager(accessories, new EventEmitter(), () => false);
      const host = { ...api,
        registerPlatformAccessories: vi.fn(async (_plugin: string, _platform: string, items: Array<ReturnType<typeof createMatterAccessory>>) => {
          for (const item of items) {
            await manager.registerAccessory('homebridge-hejhome', 'Hejhome', item!, deps);
          }
        }),
        updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(),
        updateAccessoryState: vi.fn((uuid: string, cluster: string, attributes: Record<string, unknown>, partId?: string) =>
          states.updateAccessoryState(uuid, cluster, attributes, partId)),
      } as unknown as MatterAPI;
      const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
      const sample = (alarm: boolean | null) => ({ id: 'sensor', name: 'Smoke', deviceType: 'SensorSmoke3', deviceState: { alarm } });
      await adapter.reconcile([sample(true)]);
      expect(states.getAccessoryState('device-test', 'smokeCoAlarm')?.smokeState).toBe(2);
      await adapter.update(sample(null));
      expect(states.getAccessoryState('device-test', 'bridgedDeviceBasicInformation')?.reachable).toBe(false);
      expect(states.getAccessoryState('device-test', 'smokeCoAlarm')?.smokeState).toBe(2);
      await adapter.update(sample(false));
      expect(states.getAccessoryState('device-test', 'smokeCoAlarm')?.smokeState).toBe(0);
      adapter.dispose();
    } finally {
      await node.close();
    }
  });

  test.each([
    ['ascii-32', 'A'.repeat(32), 'RelayController'],
    ['ascii-33', 'A'.repeat(33), 'RelayController'],
    ['hangul-32', '가'.repeat(32), 'RelayController'],
    ['hangul-11', '가'.repeat(11), 'RelayController'],
    ['emoji-9', '😀'.repeat(9), 'RelayController'],
    ['emoji-16', '😀'.repeat(16), 'RelayController'],
    ['emoji-17', '😀'.repeat(17), 'RelayController'],
    ['hangul-33', '가'.repeat(33), 'RelayController'],
    ['emoji-33', '😀'.repeat(33), 'RelayController'],
    ['part-suffix', 'A'.repeat(64), 'Switch2'],
  ])('%s long device name registers on the installed host', async (caseName, name, deviceType) => {
    const environment = new Environment(`hej-label-${caseName}`, Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `label-${caseName}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const source = { id: 'test', name, deviceType, deviceState: { power1: true, power2: false } };
      const accessory = createMatterAccessory(api, () => source, vi.fn(), [])!;
      expect(source.name).toBe(name);
      expect(accessory.displayName.length).toBeLessThanOrEqual(32);
      expect(accessory.displayName).not.toMatch(/[\uD800-\uDBFF]$/u);
      if (name.length <= 32) {
        expect(accessory.displayName).toBe(name);
      }
      expect(accessory.UUID).toBe('device-test');
      if (deviceType === 'Switch2') {
        expect(accessory.parts?.map((part) => part.id)).toEqual(['power1', 'power2']);
        expect(accessory.parts?.map((part) => part.displayName)).toEqual([
          `${accessory.displayName} 1`, `${accessory.displayName} 2`,
        ]);
      }
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      await new AccessoryManager().registerAccessory('homebridge-hejhome', 'Hejhome', accessory, deps);
      expect(accessories.get(accessory.UUID)?.endpoint?.lifecycle.isReady).toBe(true);
    } finally {
      await node.close();
    }
  });

  test.each(pmLabelCases)('AirQualitySensor %s child keeps a valid PM2.5 label and nullable measurement', async (caseName, name) => {
    const environment = new Environment(`hej-pm25-part-${caseName}`, Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `pm25-part-${caseName}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const purifier = (pm25: unknown) => ({ id: 'purifier', name, deviceType: 'Airpurifier',
        deviceState: { power: true, pm25 } });
      const accessory = createMatterAccessory(api, () => purifier(25), vi.fn(), [], undefined, 0.5)!;
      expect(accessory).toBeTruthy();
      expect(accessory.deviceType).toBe(deviceTypes.OnOffOutlet);
      const accessories: AccessoryManagerDeps['accessories'] = new Map();
      const deps: AccessoryManagerDeps = {
        accessories, config: { externalAccessory: false } as AccessoryManagerDeps['config'],
        behaviorRegistry: new BehaviorRegistry(accessories), registryManager: new RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false,
        getMonitoringEnabled: () => false, isCommissioned: () => false,
      };
      const manager = new AccessoryManager();
      await manager.registerAccessory('homebridge-hejhome', 'Hejhome', accessory, deps);
      expect(accessories.get(accessory.UUID)?.endpoint?.parts.size).toBe(1);
      expect(accessories.get(accessory.UUID)?._parts?.[0]?.id).toBe('air-quality');
      expect(accessory.parts?.[0]?.displayName?.length).toBeLessThanOrEqual(64);
      expect(accessory.parts?.[0]?.displayName?.endsWith(' PM2.5')).toBe(true);
      const states = new StateManager(accessories, new EventEmitter(), () => false);
      await states.updateAccessoryState(accessory.UUID, 'pm25ConcentrationMeasurement',
        { measuredValue: null, measurementMedium: 0, measurementUnit: 4 }, 'air-quality');
      expect(states.getAccessoryState(accessory.UUID, 'pm25ConcentrationMeasurement', 'air-quality')?.measuredValue).toBeNull();
      const initialEndpoint = accessories.get(accessory.UUID)?.endpoint;
      accessories.get(accessory.UUID)!._restoredFromCache = true;
      const withoutPm = createMatterAccessory(api, () => purifier(null), vi.fn(), [])!;
      await manager.registerAccessory('homebridge-hejhome', 'Hejhome', withoutPm, deps);
      expect(withoutPm.UUID).toBe(accessory.UUID);
      expect(accessories.get(accessory.UUID)?.endpoint?.parts.size).toBe(0);
      expect(accessories.get(accessory.UUID)?.endpoint).not.toBe(initialEndpoint);
      accessories.get(accessory.UUID)!._restoredFromCache = true;
      const restoredPm = createMatterAccessory(api, () => purifier(30), vi.fn(), [], undefined, 0.5)!;
      await manager.registerAccessory('homebridge-hejhome', 'Hejhome', restoredPm, deps);
      expect(restoredPm.UUID).toBe(accessory.UUID);
      expect(accessories.get(accessory.UUID)?._parts?.[0]?.id).toBe('air-quality');
    } finally {
      await node.close();
    }
  });
});
