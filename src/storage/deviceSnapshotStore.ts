import fs from 'node:fs/promises';
import path from 'node:path';

import type { HejDevice, HejFamily, HejhomePlatformConfig } from '../types.js';
import { resolveDiscoveryScope } from '../discovery/scope.js';

export interface HejDeviceSnapshot {
  ownerFingerprint?: string;
  discoveryScope?: NonNullable<HejhomePlatformConfig['scope']>;
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

  async save(families: Array<{ family: HejFamily; devices: HejDevice[] }>, ownerFingerprint?: string,
    discoveryScope?: NonNullable<HejhomePlatformConfig['scope']>): Promise<HejDeviceSnapshot> {
    const snapshot: HejDeviceSnapshot = {
      ...(ownerFingerprint ? { ownerFingerprint } : {}),
      ...(discoveryScope ? { discoveryScope: structuredClone(discoveryScope) } : {}),
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

  async loadDevicesForSession(ownerFingerprint: string, scope: NonNullable<HejhomePlatformConfig['scope']>): Promise<HejDevice[]> {
    const snapshot = await this.load();
    if (!snapshot || snapshot.ownerFingerprint !== ownerFingerprint || !snapshot.discoveryScope
      || scopeKey(snapshot.discoveryScope) !== scopeKey(scope)) {
      return [];
    }
    const selected = resolveDiscoveryScope({ scope }, snapshot.families.map((entry) => entry.family));
    return selected.flatMap(({ familyId, roomIds }) => {
      const devices = snapshot.families.find((entry) => entry.family.familyId === familyId)?.devices ?? [];
      return devices.filter((device) => typeof device.id === 'string' && device.id
        && typeof device.deviceType === 'string' && typeof device.name === 'string'
        && (roomIds === undefined || roomIds.includes(Number(device.roomId))));
    });
  }
}

function scopeKey(scope: NonNullable<HejhomePlatformConfig['scope']>): string {
  const mode = scope.mode ?? 'first-family';
  if (mode !== 'custom') {
    return mode;
  }
  const families = [...new Set(scope.includedFamilyIds ?? [])].sort((a, b) => a - b);
  const rooms = scope.includedRoomsByFamilyId ?? {};
  return JSON.stringify(families.map((id) => [id, Object.hasOwn(rooms, String(id))
    ? [...new Set(rooms[String(id)] ?? [])].sort((a, b) => a - b) : null]));
}
