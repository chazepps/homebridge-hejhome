import fs from 'node:fs/promises';
import path from 'node:path';

import type { HejDevice, HejFamily } from '../types.js';

export interface HejDeviceSnapshot {
  generatedAt: string;
  familyCount: number;
  deviceCount: number;
  families: Array<{
    family: HejFamily;
    devices: HejDevice[];
  }>;
}

export class DeviceSnapshotStore {
  private readonly snapshotPath: string;

  constructor(homebridgeStoragePath: string) {
    this.snapshotPath = path.join(homebridgeStoragePath, 'hejhome', 'devices-snapshot.json');
  }

  get path(): string {
    return this.snapshotPath;
  }

  async save(families: Array<{ family: HejFamily; devices: HejDevice[] }>): Promise<HejDeviceSnapshot> {
    const snapshot: HejDeviceSnapshot = {
      generatedAt: new Date().toISOString(),
      familyCount: families.length,
      deviceCount: families.reduce((total, entry) => total + entry.devices.length, 0),
      families,
    };

    const directory = path.dirname(this.snapshotPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.snapshotPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.snapshotPath);
    return snapshot;
  }

  async load(): Promise<HejDeviceSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotPath, 'utf8');
      return JSON.parse(raw) as HejDeviceSnapshot;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
