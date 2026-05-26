import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { DeviceSnapshotStore } from '../src/storage/deviceSnapshotStore.js';

describe('DeviceSnapshotStore', () => {
  test('persists a device discovery snapshot under the Homebridge storage path', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-snapshot-'));
    const store = new DeviceSnapshotStore(storageRoot);

    const snapshot = await store.save([
      {
        family: { familyId: 1, name: 'Home' },
        devices: [
          {
            id: 'device-1',
            name: 'Desk Lamp',
            deviceType: 'LightRgbw5',
            familyId: 1,
            deviceState: { power: true },
          },
        ],
      },
    ]);

    const snapshotFile = path.join(storageRoot, 'hejhome', 'devices-snapshot.json');
    const raw = fs.readFileSync(snapshotFile, 'utf8');
    const stat = fs.statSync(snapshotFile);

    expect(store.path).toBe(snapshotFile);
    expect(snapshot.deviceCount).toBe(1);
    expect(snapshot.familyCount).toBe(1);
    expect(raw).toContain('Desk Lamp');
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('loads the latest device discovery snapshot for the settings UI', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-snapshot-load-'));
    const store = new DeviceSnapshotStore(storageRoot);

    await store.save([
      {
        family: { familyId: 1, name: 'Home' },
        devices: [
          {
            id: 'device-1',
            name: 'Desk Lamp',
            deviceType: 'LightRgbw5',
            familyId: 1,
            deviceState: { power: true },
          },
        ],
      },
    ]);

    const snapshot = await store.load();

    expect(snapshot?.deviceCount).toBe(1);
    expect(snapshot?.families[0]?.devices[0]?.deviceType).toBe('LightRgbw5');
  });
});
