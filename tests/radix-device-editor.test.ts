import { describe, expect, it } from 'vitest';
import { editorValue, serializePreference, deviceNeedsAttention, deviceKind, deviceSearchText } from '../homebridge-ui/src/pages/devices/model.js';
import type { Device } from '../homebridge-ui/src/core/types.js';
import { getSupportedDeviceModels } from '../src/devices/capabilities.js';

const device = (deviceType: string, extra: Partial<Device> = {}): Device => ({
  id: 'fixture-device', name: 'Fixture', deviceType, inScope: true, ...extra,
});

describe('Radix device preferences', () => {
  it('keeps empty optional numeric fields absent instead of coercing them to zero', () => {
    expect(serializePreference(editorValue({}), device('SensorTh'), [])).toEqual({});
    expect(serializePreference(editorValue({}), device('Airpurifier'), [])).toEqual({});
  });

  it('accepts only positive PM2.5 factors and integral freshness within the API bounds', () => {
    const purifier = device('Airpurifier');
    expect(serializePreference({ ...editorValue({}), pm25Multiplier: '0.5', freshnessMinutes: '30' }, purifier, []))
      .toEqual({ pm25Multiplier: 0.5, freshnessMinutes: 30 });
    for (const pm25Multiplier of ['0', '-1', 'Infinity', 'invalid']) {
      expect(() => serializePreference({ ...editorValue({}), pm25Multiplier }, purifier, [])).toThrow();
    }
    for (const freshnessMinutes of ['4', '1441', '12.5']) {
      expect(() => serializePreference({ ...editorValue({}), freshnessMinutes }, device('SensorTh'), [])).toThrow();
    }
  });

  it('rejects incompatible role, linked sensor, remote buttons and unsupported measurement settings', () => {
    expect(() => serializePreference({ ...editorValue({}), role: 'light' }, device('SensorTh'), [])).toThrow();
    expect(() => serializePreference({ ...editorValue({}), temperatureSensorId: 'removed' }, device('IrAirconditioner'), [])).toThrow();
    expect(() => serializePreference({ ...editorValue({}), visibility: 'matter', remoteButtons: true }, device('IrTv'), []))
      .toThrow();
    expect(() => serializePreference({ ...editorValue({}), freshnessMinutes: '30' }, device('Airpurifier'), [])).toThrow();
    expect(() => serializePreference({ ...editorValue({}), pm25Multiplier: '1' }, device('Plug'), [])).toThrow();
  });

  it('allows explicit clearing of an inactive saved freshness value without losing unrelated preferences', () => {
    for (const deviceType of ['Plug', 'Airpurifier']) {
      const current = device(deviceType, { meterProfileApplied: false, preference: { name: 'Saved name', freshnessMinutes: 30 } });
      const draft = { ...editorValue(current.preference), name: 'New name' };
      expect(() => serializePreference(draft, current, [])).toThrow();
      expect(serializePreference({ ...draft, freshnessMinutes: '' }, current, [])).toEqual({ name: 'New name' });
    }
  });

  it('keeps power measurement freshness valid when PM2.5 correction is disabled', () => {
    const current = device('Airpurifier', { meterProfileApplied: true, preference: { pm25Multiplier: 0.5, freshnessMinutes: 30 } });
    expect(serializePreference({ ...editorValue(current.preference), pm25Multiplier: '' }, current, []))
      .toEqual({ freshnessMinutes: 30 });
  });

  it('trims names, accepts known linked sensors and never submits power settings through this endpoint', () => {
    const sensor = device('SensorTh2', { id: 'sensor' });
    expect(serializePreference({ ...editorValue({ powerSpec: { activeWatts: 12 } }), name: ' Desk ', temperatureSensorId: 'sensor' },
      device('IrAirconditioner'), [sensor])).toEqual({ name: 'Desk', temperatureSensorId: 'sensor' });
  });

  it('does not mark missing or stale observations healthy', () => {
    const connected = device('Plug', { online: true, homekit: true, lastSeenAt: '2026-10-02T00:00:00Z' });
    expect(deviceNeedsAttention(connected, true, 'valid', false)).toBe(false);
    expect(deviceNeedsAttention(connected, false, 'valid', false)).toBe(true);
    expect(deviceNeedsAttention({ ...connected, online: null }, true, 'valid', false)).toBe(true);
    expect(deviceNeedsAttention({ ...connected, lastSeenAt: null }, true, 'valid', false)).toBe(true);
  });

  it('names and indexes every model in the shared catalog in Korean and English', () => {
    const ko = (korean: string) => korean;
    const en = (_korean: string, english?: string) => english ?? '';
    for (const model of getSupportedDeviceModels()) {
      const current = device(model.deviceType);
      expect(deviceKind(current, ko), model.deviceType).not.toBe('장치');
      expect(deviceKind(current, en), model.deviceType).not.toBe('Device');
      expect(deviceKind(current, en), model.deviceType).not.toMatch(/[가-힣]/);
      if (!['Plug', 'Relay'].includes(model.deviceType)) {
        expect(deviceKind(current, en), model.deviceType).not.toBe(model.deviceType);
      }
      expect(deviceSearchText(current, ko), model.deviceType).toContain(model.label);
      expect(deviceSearchText(current, en), model.deviceType).toContain(deviceKind(current, en));
    }
    expect(deviceKind(device('FutureUnknownType'), ko)).toBe('장치');
    expect(deviceKind(device('FutureUnknownType'), en)).toBe('Device');
  });
});
