import { expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI } from 'homebridge';
import { createMatterAccessory } from '../src/matter/accessory.js';
import { MatterAdapter } from '../src/matter/adapter.js';
import type { HejDevice } from '../src/types.js';

const api = { deviceTypes, uuid: { generate: (s: string) => s }, status: MatterStatus } as unknown as MatterAPI;
const lamp: HejDevice = { id: 'lamp', name: 'Stand', deviceType: 'LightRgbw5', modelName: 'M1',
  deviceState: { power: true, lightMode: 'WHITE', brightness: 50 } };

test('specification estimates add power and energy to the original light with explicit non-measured metadata', () => {
  const a = createMatterAccessory(api, () => lamp, vi.fn(), [], undefined, undefined,
    { activePower: 10000, cumulativeEnergyImported: 2500 })!;
  expect(a.UUID).toBe('hejhome:matter:lamp');
  expect(a.deviceType).toBe(deviceTypes.ExtendedColorLight);
  expect(a.clusters?.electricalPowerMeasurement).toMatchObject({ activePower: 10000,
    accuracy: [{ measurementType: 5, measured: false, minMeasuredValue: 0, maxMeasuredValue: 1000000000,
      accuracyRanges: [{ rangeMin: 0, rangeMax: 1000000000, fixedMax: 1000000000 }] }] });
  expect(a.clusters?.electricalEnergyMeasurement).toMatchObject({ cumulativeEnergyImported: { energy: 2500 },
    accuracy: { measurementType: 14, measured: false, minMeasuredValue: 0, maxMeasuredValue: 1000000000000000 } });
});

test('unknown estimates stay nullable and calibrated meter profiles win even with absent readings', () => {
  const unknown = createMatterAccessory(api, () => lamp, vi.fn(), [], undefined, undefined,
    { activePower: null, cumulativeEnergyImported: null })!;
  expect(unknown.clusters?.electricalPowerMeasurement?.activePower).toBeNull();
  expect(unknown.clusters?.electricalEnergyMeasurement?.cumulativeEnergyImported).toBeNull();
  const measured = createMatterAccessory(api, () => ({ ...lamp, deviceType: 'Plug' }), vi.fn(),
    [{ model: 'M1', power: { field: 'meterPower', multiplier: 1 } }], undefined, undefined,
    { activePower: 10000, cumulativeEnergyImported: 2500 })!;
  expect(measured.clusters?.electricalPowerMeasurement).toEqual({ activePower: null });
  expect(measured.clusters?.electricalEnergyMeasurement).toBeUndefined();
});

test('electrical energy updates remain at least a minute apart while power reports can change immediately', async () => {
  vi.useFakeTimers();
  try {
    const update = vi.fn().mockResolvedValue(undefined);
    const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: update } as unknown as MatterAPI;
    let estimate = { activePower: 10000, cumulativeEnergyImported: 0 };
    const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn(), {}, () => estimate);
    await adapter.reconcile([lamp]);
    update.mockClear();
    estimate = { activePower: 100, cumulativeEnergyImported: 10 };
    await adapter.update(lamp);
    await adapter.reconcile([lamp]);
    expect(update.mock.calls.find((call) => call[1] === 'electricalPowerMeasurement')?.[2].activePower).toBe(100);
    expect(update.mock.calls.some((call) => call[1] === 'electricalEnergyMeasurement')).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(update.mock.calls.find((call) => call[1] === 'electricalEnergyMeasurement')?.[2].cumulativeEnergyImported).toEqual({ energy: 10 });
    adapter.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test.each([null, 200])('changing stable accounts publishes the new owner total %s immediately on the same device', async (newTotal) => {
  vi.useFakeTimers();
  try {
    const visible = new Map<string, Record<string, unknown>>();
    const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn(async (_uuid, cluster, attributes) => {
        visible.set(cluster, attributes);
      }) } as unknown as MatterAPI;
    let estimate: { activePower: number | null; cumulativeEnergyImported: number | null } = { activePower: 10000, cumulativeEnergyImported: 4321 };
    const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn(), {}, () => estimate);
    adapter.setElectricalAccount('owner-a');
    await adapter.reconcile([lamp]);
    await vi.advanceTimersByTimeAsync(1000);
    estimate = { activePower: null, cumulativeEnergyImported: null };
    await adapter.update({ ...lamp, online: false });
    adapter.setElectricalAccount('owner-b');
    estimate = { activePower: null, cumulativeEnergyImported: newTotal };
    await adapter.update({ ...lamp, online: false });
    expect(visible.get('electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual(newTotal === null ? null : { energy: 200 });
    estimate = { activePower: 10000, cumulativeEnergyImported: newTotal ?? 0 };
    await adapter.reconcile([lamp]);
    expect(visible.get('electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: newTotal ?? 0 });
    const calls = (host.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === 'electricalEnergyMeasurement').length;
    adapter.setElectricalAccount('owner-b');
    estimate = { activePower: 10000, cumulativeEnergyImported: (newTotal ?? 0) + 1 };
    await adapter.reconcile([lamp]);
    expect((host.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === 'electricalEnergyMeasurement')).toHaveLength(calls);
    adapter.dispose();
  } finally {
    vi.useRealTimers();
  }
});
