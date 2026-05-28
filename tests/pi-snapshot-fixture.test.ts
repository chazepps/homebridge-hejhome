import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { getDeviceCapability } from '../src/devices/capabilities.js';
import type { HejDeviceSnapshot } from '../src/storage/deviceSnapshotStore.js';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(root, 'tests/fixtures/pi-devices-snapshot.json');

describe('Pi snapshot fixture coverage', () => {
  test('keeps the observed production device mix covered by capability registry entries', () => {
    const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as HejDeviceSnapshot;
    const devices = snapshot.families.flatMap((entry) => entry.devices);
    const deviceTypes = new Set(devices.map((device) => device.deviceType));

    expect(snapshot.familyCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.deviceCount).toBe(devices.length);
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect([...deviceTypes]).toEqual(expect.arrayContaining([
      'LightRgbw5',
      'SensorMo',
      'LightWw3',
      'RelayController',
    ]));
    expect([...deviceTypes].some((type) => type === 'ZigbeeSwitch1' || type === 'ZigbeeSwitch2')).toBe(true);

    for (const device of devices) {
      const capability = getDeviceCapability(device.deviceType);
      expect(capability, `${device.deviceType} must be classified`).toBeDefined();
      expect(['supported', 'partial', 'deferred']).toContain(capability?.supportStatus);
    }
  });
});
