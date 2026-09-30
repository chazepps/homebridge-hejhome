import type { MeterProfile, MeterSource } from '../features.js';
import type { HejDevice } from '../types.js';

export function meterClusters(device: HejDevice, profiles: MeterProfile[]): Record<string, Record<string, unknown>> {
  const profile = profiles.find((entry) => entry.model === device.modelName);
  if (!profile) {
    return {};
  }
  const clusters: Record<string, Record<string, unknown>> = {};
  const power: Record<string, unknown> = {};
  for (const [kind, attribute] of [['power', 'activePower'], ['voltage', 'voltage'], ['current', 'activeCurrent']] as const) {
    if (profile[kind]) {
      power[attribute] = milliValue(device, profile[kind]);
    }
  }
  if (Object.keys(power).length) {
    clusters.electricalPowerMeasurement = power;
  }
  if (profile.energy) {
    const energy = milliValue(device, profile.energy);
    clusters.electricalEnergyMeasurement = { cumulativeEnergyImported: energy === null ? null : { energy } };
  }
  return clusters;
}

function milliValue(device: HejDevice, source: MeterSource): number | null {
  const raw = device.deviceState?.[source.field];
  if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === '') {
    return null;
  }
  const converted = Math.round(Number(raw) * source.multiplier * 1000);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}
