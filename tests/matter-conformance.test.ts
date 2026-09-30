import { describe, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI } from 'homebridge';
import { Endpoint, ServerNode, Environment } from '@matter/main';
import { StorageService, MockStorageService } from '@matter/general';
import { AggregatorEndpoint } from '@matter/main/endpoints';
import { AccessoryManager, type AccessoryManagerDeps } from '../node_modules/homebridge/dist/matter/server/AccessoryManager.js';
import { BehaviorRegistry, RegistryManager } from '../node_modules/homebridge/dist/matter/behaviors/index.js';
import { createMatterAccessory } from '../src/matter/accessory.js';

const api = { deviceTypes, status: MatterStatus, uuid: { generate: () => 'device-test' } } as unknown as MatterAPI;

describe('real Matter endpoint conformance', () => {
  test.each(['RelayController', 'Switch3', 'PowerStrip', 'Plug', 'LightRgbw5', 'LightWw1', 'Curtain',
    'SensorMo', 'SensorDo', 'SensorTh', 'SensorWater2', 'SensorSmoke3'])('%s registers and restores on the installed host', async (deviceType) => {
    const environment = new Environment('hej-conformance', Environment.default);
    environment.set(StorageService, new MockStorageService(environment));
    const node = await ServerNode.create({ id: `test-${deviceType}`, environment });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await node.add(aggregator);
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const a = createMatterAccessory(api, () => ({ id: 'test', name: 'Device', deviceType, modelName: 'M1',
        deviceState: { power1: true, battery: 40, temperature: 20, humidity: 50, alarm: false } }), send,
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
});
