import type { HejDevice } from '../types.js';

export interface HealthResult { reachable: boolean; reason: string }

// Local freshness policy, not a claim about the vendor's reporting cadence.
// Event-driven contact/motion/leak values never expire merely through silence.
const CONTINUOUS_FIELDS = new Set(['temperature', 'humidity', 'pm25', 'curPower', 'curCurrent', 'curVoltage']);
const SENSOR_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const METER_FRESHNESS_MS = 5 * 60 * 1000;

export function isContinuousMeasurement(deviceType: string, key: string): boolean {
  return CONTINUOUS_FIELDS.has(key) && (deviceType.startsWith('Sensor') || key.startsWith('cur') || key === 'pm25');
}

export class RuntimeHealth {
  private readonly devices = new Map<string, HejDevice>();
  private readonly received = new Map<string, Map<string, number>>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(device: HejDevice, source: 'snapshot' | 'realtime'): void {
    const previous = this.devices.get(device.id);
    this.devices.set(device.id, { ...previous, ...device,
      deviceState: { ...previous?.deviceState, ...device.deviceState } });
    if (source !== 'realtime') {
      return;
    }
    this.seen.set(device.id, this.now());
    const timestamps = this.received.get(device.id) ?? new Map<string, number>();
    for (const [key, value] of Object.entries(device.deviceState ?? {})) {
      if (value !== null && value !== undefined) {
        timestamps.set(key, this.now());
      }
    }
    this.received.set(device.id, timestamps);
  }

  device(id: string): HealthResult {
    const device = this.devices.get(id);
    if (!device) {
      return { reachable: false, reason: 'device-unknown' };
    }
    return device.online === false
      ? { reachable: false, reason: 'device-offline' }
      : { reachable: true, reason: 'available' };
  }

  measurement(id: string, key: string): HealthResult {
    const device = this.devices.get(id);
    const value = device?.deviceState?.[key];
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
      return { reachable: false, reason: 'measurement-unknown' };
    }
    if (!isContinuousMeasurement(device?.deviceType ?? '', key)) {
      return { reachable: true, reason: 'available' };
    }
    const at = this.received.get(id)?.get(key);
    if (at === undefined) {
      return { reachable: false, reason: 'measurement-unknown' };
    }
    const ttl = key.startsWith('cur') ? METER_FRESHNESS_MS : SENSOR_FRESHNESS_MS;
    return this.now() - at >= ttl
      ? { reachable: false, reason: 'measurement-stale' }
      : { reachable: true, reason: 'available' };
  }

  invalidateMeasurements(): void {
    this.received.clear();
  }

  lastSeen(id: string): string | null {
    const seen = this.seen.get(id);
    return seen === undefined ? null : new Date(seen).toISOString();
  }

  retain(ids: Set<string>): void {
    for (const id of this.devices.keys()) {
      if (!ids.has(id)) {
        this.devices.delete(id);
        this.received.delete(id);
        this.seen.delete(id);
      }
    }
  }
}
