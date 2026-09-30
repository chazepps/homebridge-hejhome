import { isReservedMeasurementField } from './runtime/measurementFields.js';

export interface MeterSource { field: string; multiplier: number }
export interface MeterProfile {
  model: string;
  power?: MeterSource;
  voltage?: MeterSource;
  current?: MeterSource;
  energy?: MeterSource;
}
export interface DevicePreference {
  visibility?: 'both' | 'homekit' | 'matter' | 'hidden';
  name?: string;
  role?: 'original' | 'light' | 'outlet' | 'switch';
  temperatureSensorId?: string;
  freshnessMinutes?: number;
  remoteButtons?: boolean;
  pm25Multiplier?: number;
}
export interface FeatureOptions {
  matter: boolean;
  adaptiveLighting: boolean;
  meters: MeterProfile[];
  devices?: Record<string, DevicePreference>;
}

export function normalizeFeatures(input: unknown): FeatureOptions {
  const value = object(input ?? {});
  for (const key of Object.keys(value)) {
    if (!['matter', 'adaptiveLighting', 'meters', 'devices'].includes(key)) {
      throw new Error(`Unknown feature option: ${key}`);
    }
  }
  for (const key of ['matter', 'adaptiveLighting']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean.`);
    }
  }
  if (value.meters !== undefined && !Array.isArray(value.meters)) {
    throw new Error('meters must be a list.');
  }
  const models = new Set<string>();
  const meters = ((value.meters ?? []) as unknown[]).map((item) => {
    const profile = object(item);
    if (typeof profile.model !== 'string' || !profile.model.trim() || models.has(profile.model)) {
      throw new Error('Each meter profile needs a unique model name.');
    }
    models.add(profile.model);
    const result: MeterProfile = { model: profile.model };
    for (const key of Object.keys(profile)) {
      if (!['model', 'power', 'voltage', 'current', 'energy'].includes(key)) {
        throw new Error(`Unknown meter option: ${key}`);
      }
    }
    for (const kind of ['power', 'voltage', 'current', 'energy'] as const) {
      if (profile[kind] === undefined) {
        continue;
      }
      const source = object(profile[kind]);
      if (typeof source.field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(source.field)
        || isReservedMeasurementField(source.field)
        || typeof source.multiplier !== 'number' || !Number.isFinite(source.multiplier) || source.multiplier <= 0) {
        throw new Error(`${kind} needs a state field and a positive SI-unit multiplier.`);
      }
      result[kind] = { field: source.field, multiplier: source.multiplier };
    }
    if (Object.keys(result).length === 1) {
      throw new Error('Meter profile needs at least one measurement.');
    }
    return result;
  });
  const result: FeatureOptions = { matter: value.matter === true, adaptiveLighting: value.adaptiveLighting === true, meters };
  if (value.devices !== undefined) {
    const devices = object(value.devices);
    const normalized: Record<string, DevicePreference> = Object.create(null);
    for (const [id, rawPreference] of Object.entries(devices)) {
      if (!id.trim() || id.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(id)) {
        throw new Error('Invalid device ID.');
      }
      const preference = object(rawPreference);
      for (const key of Object.keys(preference)) {
        if (!['visibility', 'name', 'role', 'temperatureSensorId', 'freshnessMinutes', 'remoteButtons', 'pm25Multiplier'].includes(key)) {
          throw new Error(`Unknown device option: ${key}`);
        }
      }
      const entry: DevicePreference = {};
      if (preference.visibility !== undefined) {
        if (!['both', 'homekit', 'matter', 'hidden'].includes(preference.visibility as string)) {
          throw new Error('Invalid device visibility.');
        }
        entry.visibility = preference.visibility as NonNullable<DevicePreference['visibility']>;
      }
      if (preference.name !== undefined) {
        if (typeof preference.name !== 'string' || !preference.name.trim() || preference.name.trim().length > 64) {
          throw new Error('Device name must be 1–64 characters.');
        }
        entry.name = preference.name.trim();
      }
      if (preference.role !== undefined) {
        if (!['original', 'light', 'outlet', 'switch'].includes(preference.role as string)) {
          throw new Error('Invalid device role.');
        }
        entry.role = preference.role as NonNullable<DevicePreference['role']>;
      }
      if (preference.temperatureSensorId !== undefined) {
        if (typeof preference.temperatureSensorId !== 'string' || !preference.temperatureSensorId.trim()
          || preference.temperatureSensorId.length > 128
          || ['__proto__', 'prototype', 'constructor'].includes(preference.temperatureSensorId)) {
          throw new Error('Invalid temperature sensor ID.');
        }
        entry.temperatureSensorId = preference.temperatureSensorId;
      }
      if (preference.freshnessMinutes !== undefined) {
        if (typeof preference.freshnessMinutes !== 'number' || !Number.isInteger(preference.freshnessMinutes)
          || preference.freshnessMinutes < 5 || preference.freshnessMinutes > 1440) {
          throw new Error('Measurement validity must be 5–1440 minutes.');
        }
        entry.freshnessMinutes = preference.freshnessMinutes;
      }
      if (preference.remoteButtons !== undefined) {
        if (typeof preference.remoteButtons !== 'boolean') {
          throw new Error('Remote buttons must be enabled or disabled.');
        }
        entry.remoteButtons = preference.remoteButtons;
      }
      if (preference.pm25Multiplier !== undefined) {
        if (typeof preference.pm25Multiplier !== 'number' || !Number.isFinite(preference.pm25Multiplier)
          || preference.pm25Multiplier <= 0) {
          throw new Error('PM2.5 multiplier must be a positive number.');
        }
        entry.pm25Multiplier = preference.pm25Multiplier;
      }
      normalized[id] = entry;
    }
    result.devices = normalized;
  }
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an options object.');
  }
  return value as Record<string, unknown>;
}
