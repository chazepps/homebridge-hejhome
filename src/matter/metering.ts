import type { MeterProfile, MeterSource } from '../features.js';
import type { HejDevice } from '../types.js';
import { MAX_POWER_ESTIMATE_WATTS, powerEstimateSupport, type EstimatedElectricalState } from '../runtime/powerEstimates.js';
import { MAX_ESTIMATED_ENERGY_MWH } from '../storage/estimatedEnergyStore.js';

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

/** Bounded full-range uncertainty avoids the host's default measured=true / +/-1 W claim. */
export function estimateClusters(device: HejDevice, profiles: MeterProfile[], estimate?: EstimatedElectricalState): Record<string, Record<string, unknown>> {
  const profile = profiles.find((entry) => entry.model === device.modelName);
  if (!estimate || !powerEstimateSupport(device).supported || profile?.power || profile?.energy) {
    return {};
  }
  const measured = meterClusters(device, profiles).electricalPowerMeasurement ?? {};
  const accuracy = [estimateAccuracy(5, MAX_POWER_ESTIMATE_WATTS * 1000)];
  for (const [attribute, type] of [['voltage', 1], ['activeCurrent', 2]] as const) {
    if (Object.hasOwn(measured, attribute)) {
      accuracy.push({ ...estimateAccuracy(type, Number.MAX_SAFE_INTEGER), measured: true });
    }
  }
  return {
    electricalPowerMeasurement: { ...measured, activePower: estimate.activePower, accuracy },
    electricalEnergyMeasurement: { cumulativeEnergyImported: estimate.cumulativeEnergyImported === null ? null : { energy: estimate.cumulativeEnergyImported },
      accuracy: estimateAccuracy(14, MAX_ESTIMATED_ENERGY_MWH) },
  };
}

function estimateAccuracy(measurementType: number, max: number) {
  return { measurementType, measured: false, minMeasuredValue: 0, maxMeasuredValue: max,
    accuracyRanges: [{ rangeMin: 0, rangeMax: max, fixedMax: max }] };
}
