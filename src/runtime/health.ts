import type { FeatureOptions } from '../features.js';
import { isReservedMeasurementField } from './measurementFields.js';
import type { HejDevice } from '../types.js';

export interface HealthResult { reachable: boolean; reason: string }

// Vendor guidance describes a 30-minute app measurement cycle, not an MQTT SLA.
// Three cycles is a local allowance; instantaneous metering uses a shorter local limit.
// https://m.hej.life/skin-skin5/article/기능-및-기본정보/16/125/
const ENVIRONMENT_TYPES = new Set(['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2']);
const METER_FIELDS = new Set(['curPower', 'curCurrent', 'curVoltage']);
const SENSOR_FRESHNESS_MS = 90 * 60 * 1000;
const METER_FRESHNESS_MS = 5 * 60 * 1000;
type FreshnessFeatures = Pick<FeatureOptions, 'meters' | 'devices'>;

function isMeterField(device: HejDevice, key: string, features: FreshnessFeatures): boolean {
  if (isReservedMeasurementField(key)) {
    return false;
  }
  if (METER_FIELDS.has(key)) {
    return true;
  }
  const profile = features.meters.find((entry) => entry.model === device.modelName);
  return !!profile && (['power', 'current', 'voltage', 'energy'] as const).some((kind) => profile[kind]?.field === key);
}

/** null means no age-based expiry: events, battery and actuator settings are not periodic samples. */
export function measurementFreshnessMs(device: HejDevice, key: string, features: FreshnessFeatures = { meters: [] }): number | null {
  const meter = isMeterField(device, key, features);
  const environment = ENVIRONMENT_TYPES.has(device.deviceType) && (key === 'temperature' || key === 'humidity');
  if (!meter && !environment && key !== 'pm25') {
    return null;
  }
  const override = features.devices?.[device.id]?.freshnessMinutes;
  if (typeof override === 'number' && Number.isInteger(override) && override >= 5 && override <= 1440) {
    return override * 60000;
  }
  return meter ? METER_FRESHNESS_MS : SENSOR_FRESHNESS_MS;
}

function validMeasurement(device: HejDevice, key: string, value: unknown, features: FreshnessFeatures): boolean {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return false;
  }
  if (measurementFreshnessMs(device, key, features) === null) {
    return true;
  }
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    return false;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return false;
  }
  if (key === 'humidity') {
    return number >= 0 && number <= 100;
  }
  return key === 'pm25' || isMeterField(device, key, features) ? number >= 0 : true;
}

export class RuntimeHealth {
  private readonly devices = new Map<string, HejDevice>();
  private readonly received = new Map<string, Map<string, number>>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly features: FreshnessFeatures = { meters: [] }) {}

  observe(device: HejDevice, source: 'snapshot' | 'realtime'): void {
    const previous = this.devices.get(device.id);
    const merged = { ...previous, ...device, deviceState: { ...previous?.deviceState, ...device.deviceState } };
    this.devices.set(device.id, merged);
    if (source !== 'realtime') {
      return;
    }
    this.seen.set(device.id, this.now());
    const timestamps = this.received.get(device.id) ?? new Map<string, number>();
    for (const [key, value] of Object.entries(device.deviceState ?? {})) {
      if (validMeasurement(merged, key, value, this.features)) {
        timestamps.set(key, this.now());
      } else {
        timestamps.delete(key);
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
    if (!device || !validMeasurement(device, key, value, this.features)) {
      return { reachable: false, reason: 'measurement-unknown' };
    }
    const ttl = measurementFreshnessMs(device, key, this.features);
    if (ttl === null) {
      return { reachable: true, reason: 'available' };
    }
    const at = this.received.get(id)?.get(key);
    if (at === undefined) {
      return { reachable: false, reason: 'measurement-unknown' };
    }
    const age = this.now() - at;
    if (age < 0) {
      this.received.get(id)?.delete(key);
      return { reachable: false, reason: 'measurement-unknown' };
    }
    return age >= ttl
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
