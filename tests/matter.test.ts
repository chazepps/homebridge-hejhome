import { describe, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI, MatterAccessory } from 'homebridge';
import { createMatterAccessory } from '../src/matter/accessory.js';
import { MatterAdapter } from '../src/matter/adapter.js';
import type { HejDevice } from '../src/types.js';

const api = { deviceTypes, uuid: { generate: (s: string) => `uuid:${s}` }, status: MatterStatus } as unknown as MatterAPI;
const device = (type: string, state = {}): HejDevice => ({ id: 'd1', name: 'Device', deviceType: type, deviceState: state });
const make = (d: HejDevice, send = vi.fn().mockResolvedValue(undefined)) => createMatterAccessory(api, () => d, send, []);

describe('Matter device contract', () => {
  test('relay uses its actual power1 datapoint and awaits failures', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const a = make(device('RelayController', { power1: false }), send)!;
    expect(a.clusters?.onOff).toEqual({ onOff: false });
    await expect(a.handlers!.onOff!.on!({})).rejects.toThrow('offline');
    expect(send).toHaveBeenCalledWith({ power1: true });
  });
  test('composed switches keep stable datapoint part ids', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const a = make(device('Switch3', { power1: true, power2: false, power3: true }), send)!;
    expect(a.parts?.map((p) => p.id)).toEqual(['power1', 'power2', 'power3']);
    await a.parts![1]!.handlers!.onOff!.on!({});
    expect(send).toHaveBeenCalledWith({ power2: true });
  });
  test('colour lights expose only hue/saturation and white lights temperature', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const a = make(device('LightRgbw5', { lightMode: 'WHITE', brightness: 50 }), send)!;
    expect(a.handlers?.colorControl?.moveToColorTemperatureLogic).toBeUndefined();
    await a.handlers!.colorControl!.moveToHueAndSaturationLogic!({ hue: 127, saturation: 254, transitionTime: 0 });
    expect(send).toHaveBeenNthCalledWith(1, { lightMode: 'colour' });
    expect(send).toHaveBeenLastCalledWith({ hsvColor: { hue: 180, saturation: 100, brightness: 50 } });
    const white = make(device('LightWw1', { temperature: 0 }))!;
    expect(white.clusters?.colorControl?.colorTemperatureMireds).toBe(333);
  });
  test('coverings invert HomeKit open percentage into Matter closed percentage', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const a = make(device('Curtain', { percentState: 80, percentControl: 20 }), send)!;
    expect(a.clusters?.windowCovering?.currentPositionLiftPercent100ths).toBe(2000);
    await a.handlers!.windowCovering!.goToLiftPercentage!({ liftPercent100thsValue: 2500 });
    expect(send).toHaveBeenCalledWith({ percentControl: 75 });
  });
  test('temperature and humidity form separate parts with hundredth units', () => {
    const a = make(device('SensorTh', { temperature: 21.5, humidity: 45, battery: 40 }))!;
    expect(a.parts![0]!.clusters.temperatureMeasurement).toEqual({ measuredValue: 2150 });
    expect(a.parts![1]!.clusters.relativeHumidityMeasurement).toEqual({ measuredValue: 4500 });
    expect(a.clusters?.powerSource?.batPercentRemaining).toBe(80);
  });
  test('unknown sensors remain unknown and unsupported devices are skipped', () => {
    expect(make(device('SensorTh'))!.parts![0]!.clusters.temperatureMeasurement?.measuredValue).toBeNull();
    expect(make(device('UnknownThing'))).toBeNull();
    expect(make(device('HomeCamera'))).toBeNull();
  });
});

describe('Matter lifecycle', () => {
  test('restores handlers, removes stale cache only during reconciliation and propagates state', async () => {
    const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, vi.fn().mockResolvedValue(undefined), [], vi.fn());
    const d = device('RelayController', { power1: false });
    const cached = make(d)!;
    adapter.restore(cached);
    adapter.restore({ ...cached, UUID: 'stale' } as MatterAccessory);
    expect(host.unregisterPlatformAccessories).not.toHaveBeenCalled();
    await adapter.reconcile([d]);
    expect(host.registerPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String),
      [expect.objectContaining({ UUID: cached.UUID, handlers: expect.objectContaining({ onOff: expect.anything() }) })]);
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [expect.objectContaining({ UUID: 'stale' })]);
    await adapter.update({ ...d, deviceState: { power1: true } });
    expect(host.updateAccessoryState).toHaveBeenCalledWith(cached.UUID, 'onOff', { onOff: true }, undefined);
    adapter.dispose();
  });
});

test('energy reports coalesce but eventually deliver the last sample, and stop on shutdown', async () => {
  vi.useFakeTimers();
  try {
    const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, vi.fn(), [{ model: 'P', energy: { field: 'total', multiplier: 1 } }], vi.fn());
    const d = { ...device('Plug'), modelName: 'P', deviceState: { total: 10 } };
    await adapter.reconcile([d]);
    await adapter.update(d);
    await adapter.update({ ...d, deviceState: { total: 20 } });
    expect(host.updateAccessoryState).not.toHaveBeenCalledWith(expect.anything(), 'electricalEnergyMeasurement',
      { cumulativeEnergyImported: { energy: 20000 } }, undefined);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.anything(), 'electricalEnergyMeasurement',
      { cumulativeEnergyImported: { energy: 20000 } }, undefined);
    await adapter.update({ ...d, deviceState: { total: 30 } });
    adapter.dispose();
    const calls = vi.mocked(host.updateAccessoryState).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(vi.mocked(host.updateAccessoryState).mock.calls).toHaveLength(calls);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['RelayController', { power1: false }, { power1: true }, undefined, 'onOff', { onOff: false }],
  ['Switch2', { power1: false, power2: false }, { power1: false, power2: true }, 'power2', 'onOff', { onOff: false }],
  ['LightWw1', { power: true, brightness: 50, temperature: 0 }, { power: true, brightness: 80, temperature: 50 },
    undefined, 'colorControl', { colorTemperatureMireds: 333 }],
])('Matter command on %s cannot suppress a later external reversal', async (type, initial, commanded, part, cluster, expected) => {
  const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
  const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
  const d = device(type as string, initial);
  await adapter.reconcile([d]);
  adapter.accept({ ...d, deviceState: commanded });
  vi.mocked(host.updateAccessoryState).mockClear();
  // Host already committed the Matter command; the device then reports its old value.
  await adapter.update(d);
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), cluster, expect.objectContaining(expected), part);
  adapter.dispose();
});
