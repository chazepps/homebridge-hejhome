import { describe, expect, test } from 'vitest';
import { normalizeFeatures } from '../src/features.js';
import { meterClusters } from '../src/matter/metering.js';

describe('beta opt-ins and calibrated meters', () => {
  test('old config leaves optional features disabled', () => {
    expect(normalizeFeatures(undefined)).toEqual({ matter: false, adaptiveLighting: false, meters: [] });
  });
  test('refuses ambiguous boolean flags and uncalibrated meter sources', () => {
    expect(() => normalizeFeatures({ matter: 'true' })).toThrow();
    expect(() => normalizeFeatures({ meters: [{ model: 'Plug', power: { field: 'curPower' } }] })).toThrow();
    expect(() => normalizeFeatures({ meters: [{ model: 'Plug', power: { field: 'x', multiplier: -1 } }] })).toThrow();
  });
  test('converts explicit SI units to milli-units without estimating energy', () => {
    const options = normalizeFeatures({ meters: [{ model: 'P1', power: { field: 'curPower', multiplier: 0.1 },
      voltage: { field: 'curVoltage', multiplier: 0.1 }, current: { field: 'curCurrent', multiplier: 0.001 } }] });
    expect(meterClusters({ id: 'p', name: 'p', deviceType: 'Plug', modelName: 'P1',
      deviceState: { curPower: 123, curVoltage: 2200, curCurrent: 56 } }, options.meters)).toEqual({
      electricalPowerMeasurement: { activePower: 12300, voltage: 220000, activeCurrent: 56 },
    });
  });
  test('unknown models are not assigned a unit and missing samples stay null', () => {
    const profiles = [{ model: 'P1', power: { field: 'curPower', multiplier: 1 }, energy: { field: 'totalWh', multiplier: 1 } }];
    expect(meterClusters({ id: 'p', name: 'p', deviceType: 'Plug' }, profiles)).toEqual({});
    expect(meterClusters({ id: 'p', name: 'p', deviceType: 'Plug', modelName: 'P1', deviceState: { curPower: NaN } }, profiles))
      .toEqual({ electricalPowerMeasurement: { activePower: null }, electricalEnergyMeasurement: { cumulativeEnergyImported: null } });
  });
  test('energy uses measured totals, including zero', () => {
    expect(meterClusters({ id: 'p', name: 'p', deviceType: 'Plug', modelName: 'P1', deviceState: { totalWh: 0 } },
      [{ model: 'P1', energy: { field: 'totalWh', multiplier: 1 } }]))
      .toEqual({ electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 0 } } });
  });
});
