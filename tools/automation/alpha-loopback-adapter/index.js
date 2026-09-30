// Copy this adapter into <temp>/plugins so its relative imports resolve to the
// installed, unmodified Homebridge UI alpha package in <temp>/node_modules.
import { HapClient } from '@homebridge/hap-client';
import { SmartAutomationPlatform } from '../../node_modules/homebridge-config-ui-x/dist/smart-automation/smart-automation.platform.js';
import {
  HapSmartAutomationAccessoryController,
} from '../../node_modules/homebridge-config-ui-x/dist/smart-automation/smart-automation-accessory.controller.js';

const PLUGIN = 'homebridge-automation-alpha-adapter';
const PLATFORM = 'smart-automation';

class LoopbackSmartAutomationPlatform extends SmartAutomationPlatform {
  constructor(log, config, api) {
    super(log, config, api, PLUGIN);
    const ids = new Set((config.smartAutomations ?? [])
      .filter(rule => rule.enabled !== false)
      .flatMap(rule => rule.type === 'humidity-control'
        ? [...rule.uniqueIds, rule.targetUniqueId]
        : rule.uniqueIds)
      .filter(Boolean));
    this.accessoryController.stop();
    this.accessoryController = new HapSmartAutomationAccessoryController(undefined, log, ids, () => {
      const client = new HapClient({
        pin: config.fixturePin,
        config: { autoStartDiscovery: false, instanceAllowList: [config.fixtureUsername] },
        logger: log,
      });
      client.instances.push({
        name: config.fixtureBridgeName,
        ipAddress: '127.0.0.1',
        port: config.fixtureHapPort,
        username: config.fixtureUsername,
        connectionFailedCount: 0,
        services: [],
        configurationNumber: 1,
      });
      return client;
    });
  }
}

export default api => api.registerPlatform(PLUGIN, PLATFORM, LoopbackSmartAutomationPlatform);
