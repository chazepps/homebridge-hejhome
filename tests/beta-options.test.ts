import { describe, expect, test } from 'vitest';
import { normalizeFeatures } from '../src/features.js';
import { meterClusters } from '../src/matter/metering.js';

describe('beta opt-ins and calibrated meters', () => {
  test('old config leaves optional features disabled', () => {
    expect(normalizeFeatures(undefined)).toEqual({ matter: false, adaptiveLighting: false, meters: [] });
  });
  test('device preferences are optional, validated, and preserve stable IDs', () => {
    expect(normalizeFeatures({ devices: { 'fixture-plug': { visibility: 'matter', name: 'Desk plug', role: 'light' } } }).devices)
      .toEqual({ 'fixture-plug': { visibility: 'matter', name: 'Desk plug', role: 'light' } });
    expect(() => normalizeFeatures({ devices: { '__proto__': { name: 'Unsafe' } } })).not.toThrow();
    expect(() => normalizeFeatures(JSON.parse('{"devices":{"__proto__":{"name":"Unsafe"}}}'))).toThrow();
    expect(() => normalizeFeatures({ devices: { 'plug-1': { visibility: 'unknown' } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'plug-1': { name: '  ' } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'plug-1': { name: 'x'.repeat(65) } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'plug-1': { role: 'heater' } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'plug-1': { vendorField: true } } })).toThrow();
    expect(normalizeFeatures({ devices: { 'hvac-1': { temperatureSensorId: 'sensor-1' } } }).devices?.['hvac-1'])
      .toEqual({ temperatureSensorId: 'sensor-1' });
    expect(() => normalizeFeatures({ devices: { 'hvac-1': { temperatureSensorId: ' ' } } })).toThrow();
    expect(normalizeFeatures({ devices: { 'sensor-1': { freshnessMinutes: 30 }, 'tv-1': { remoteButtons: true } } }).devices)
      .toMatchObject({ 'sensor-1': { freshnessMinutes: 30 }, 'tv-1': { remoteButtons: true } });
    expect(() => normalizeFeatures({ devices: { 'sensor-1': { freshnessMinutes: 4 } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'sensor-1': { freshnessMinutes: 1441 } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'sensor-1': { freshnessMinutes: 12.5 } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'tv-1': { remoteButtons: 'true' } } })).toThrow();
    expect(normalizeFeatures({ devices: { 'purifier-1': { pm25Multiplier: 0.5 } } }).devices?.['purifier-1'])
      .toEqual({ pm25Multiplier: 0.5 });
    expect(() => normalizeFeatures({ devices: { 'purifier-1': { pm25Multiplier: 0 } } })).toThrow();
    expect(() => normalizeFeatures({ devices: { 'purifier-1': { pm25Multiplier: Number.POSITIVE_INFINITY } } })).toThrow();
  });
  test('refuses ambiguous boolean flags and uncalibrated meter sources', () => {
    expect(() => normalizeFeatures({ matter: 'true' })).toThrow();
    expect(() => normalizeFeatures({ meters: [{ model: 'Plug', power: { field: 'curPower' } }] })).toThrow();
    expect(() => normalizeFeatures({ meters: [{ model: 'Plug', power: { field: 'x', multiplier: -1 } }] })).toThrow();
    for (const field of ['power', 'power2', 'battery', 'temperature', 'pm25', 'mode']) {
      expect(() => normalizeFeatures({ meters: [{ model: 'Plug', power: { field, multiplier: 1 } }] })).toThrow();
    }
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
