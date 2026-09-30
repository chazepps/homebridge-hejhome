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
  test('missing actuator report does not advertise a known off state', () => {
    expect(make(device('RelayController'))!.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    expect(make(device('Switch2', { power1: true }))!.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    expect(make(device('LightWw1', { brightness: 50 }))!.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
  });
  test('momentary IR power is not exposed as absolute Matter OnOff', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(make(device('IrTv'), send)).toBeNull();
    let current = device('IrTv', { power: true });
    const accessory = createMatterAccessory(api, () => current, send, [])!;
    expect(accessory.clusters?.onOff?.onOff).toBe(true);
    current = device('IrTv');
    await expect(accessory.handlers!.onOff!.off!({})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const ac = make(device('IrAirconditioner', { power: '켜짐' }))!;
    expect(ac.clusters?.onOff?.onOff).toBe(true);
  });
  test('unknown relay power cannot be toggled by guessing false', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const accessory = make(device('RelayController'), send)!;
    await expect(accessory.handlers!.onOff!.toggle!({})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  test('missing colour measurements do not advertise fabricated current values', () => {
    const white = make(device('LightWw1', { power: true, brightness: 50 }))!;
    expect(white.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    expect(white.clusters?.colorControl?.colorTemperatureMireds).toBeUndefined();
    const rgb = make(device('LightRgbw5', { power: true, lightMode: 'COLOUR', brightness: 50 }))!;
    expect(rgb.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    expect(rgb.clusters?.colorControl?.currentHue).toBeUndefined();
    expect(rgb.clusters?.colorControl?.currentSaturation).toBeUndefined();
    const rgbWhite = make(device('LightRgbw5', { power: true, lightMode: 'WHITE', brightness: 50 }))!;
    expect(rgbWhite.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
  });
  test.each([
    ['SensorMo', { motionDetected: null }, 'occupancySensing', 'occupancy'],
    ['SensorDo', { doorOpened: null, state: 'INVALID' }, 'booleanState', 'stateValue'],
    ['SensorWater2', { alarm: null }, 'booleanState', 'stateValue'],
    ['SensorSmoke3', { alarm: null }, 'smokeCoAlarm', 'smokeState'],
  ])('%s unknown state omits its non-nullable Matter attribute', (type, state, cluster, attribute) => {
    const accessory = make(device(type as string, state))!;
    expect(accessory.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    expect(accessory.clusters?.[cluster as string]?.[attribute as string]).toBeUndefined();
  });
  test('contact accepts only boolean or explicit OPEN/CLOSED reports', () => {
    expect(make(device('SensorDo', { doorOpened: false }))!.clusters?.booleanState?.stateValue).toBe(true);
    expect(make(device('SensorDo', { state: 'OPEN' }))!.clusters?.booleanState?.stateValue).toBe(false);
    expect(make(device('SensorDo', { state: 'CLOSED' }))!.clusters?.booleanState?.stateValue).toBe(true);
    expect(make(device('SensorDo', { state: 'open' }))!.clusters?.booleanState?.stateValue).toBeUndefined();
    expect(make(device('SensorDo', { doorOpened: 0 }))!.clusters?.booleanState?.stateValue).toBeUndefined();
  });
  test.each([
    ['RelayController', { power1: null }, undefined],
    ['Plug', { power: null }, undefined],
    ['Switch2', { power1: true, power2: null }, 'power2'],
    ['LightWw1', { power: null, brightness: 50, temperature: 50 }, undefined],
  ])('%s unknown power omits the OnOff attribute', (type, state, partId) => {
    const accessory = make(device(type as string, state))!;
    expect(accessory.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    const onOff = partId ? accessory.parts?.find((part) => part.id === partId)?.clusters.onOff : accessory.clusters?.onOff;
    expect(onOff?.onOff).toBeUndefined();
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
    expect(adapter.hasDevice(d.id)).toBe(false);
    adapter.restore({ ...cached, UUID: 'stale' } as MatterAccessory);
    expect(host.unregisterPlatformAccessories).not.toHaveBeenCalled();
    await adapter.reconcile([d]);
    expect(adapter.hasDevice(d.id)).toBe(true);
    expect(host.registerPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String),
      [expect.objectContaining({ UUID: cached.UUID, handlers: expect.objectContaining({ onOff: expect.anything() }) })]);
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [expect.objectContaining({ UUID: 'stale' })]);
    await adapter.update({ ...d, deviceState: { power1: true } });
    expect(host.updateAccessoryState).toHaveBeenCalledWith(cached.UUID, 'onOff', { onOff: true }, undefined);
    adapter.dispose();
    expect(adapter.hasDevice(d.id)).toBe(false);
  });

  test('explicit opt-out prunes restored cache without cloud discovery or rebuilding allowed devices', async () => {
    const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
    const keep = make({ ...device('RelayController', { power1: true }), id: 'keep' })!;
    const hidden = make({ ...device('RelayController', { power1: true }), id: 'hidden' })!;
    const serialFallback = { ...make({ ...device('RelayController', { power1: true }), id: 'serial-hidden' })!, context: {} };
    adapter.restore(keep);
    adapter.restore(hidden);
    adapter.restore(serialFallback);
    await adapter.pruneHidden((id) => id === 'keep');
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledTimes(2);
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [hidden]);
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [serialFallback]);
    expect(host.updateAccessoryState).toHaveBeenCalledWith(keep.UUID, 'bridgedDeviceBasicInformation', { reachable: false });
    expect(host.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(host.updatePlatformAccessories).not.toHaveBeenCalled();
    adapter.dispose();
  });

  test('global Matter opt-out prunes even an unidentified restored cache item', async () => {
    const host = { ...api, unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
    const orphan = { ...make(device('RelayController', { power1: true }))!, context: {}, serialNumber: '' };
    adapter.restore(orphan);
    const ids: Array<string | undefined> = [];
    await adapter.pruneHidden((id) => {
      ids.push(id);
      return false;
    });
    expect(ids).toEqual([undefined]);
    expect(host.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [orphan]);
    adapter.dispose();
  });

  test('pruning an active light cancels its dimmer and clears its reports', async () => {
    vi.useFakeTimers();
    try {
      const register = vi.fn();
      const send = vi.fn().mockResolvedValue(undefined);
      const host = { ...api, registerPlatformAccessories: register, updatePlatformAccessories: vi.fn(),
        unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
      const adapter = new MatterAdapter(host, async (_id, requirements) => {
        await send(requirements);
      }, [], vi.fn());
      const light = { ...device('LightWw1', { power: true, brightness: 50, temperature: 50 }), id: 'light' };
      await adapter.reconcile([light]);
      const accessory = register.mock.calls[0]![2][0];
      await accessory.handlers.levelControl.move({ moveMode: 0, rate: 25 });
      const internals = adapter as unknown as { reported: Map<string, unknown>; devices: Map<string, unknown>;
        dimmers: Map<string, unknown> };
      expect([...internals.reported.keys()].some((key) => key.startsWith(`${accessory.UUID}/`))).toBe(true);
      await adapter.pruneHidden(() => false);
      expect(adapter.hasDevice('light')).toBe(false);
      expect(internals.devices.has('light')).toBe(false);
      expect(internals.dimmers.has('light')).toBe(false);
      expect([...internals.reported.keys()].some((key) => key.startsWith(`${accessory.UUID}/`))).toBe(false);
      await vi.advanceTimersByTimeAsync(3000);
      expect(send).toHaveBeenCalledTimes(1);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a restored allowed endpoint stays cached when its no-response update fails', async () => {
    const onError = vi.fn();
    const host = { ...api, updateAccessoryState: vi.fn().mockRejectedValue(new Error('not registered')),
      unregisterPlatformAccessories: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, vi.fn(), [], onError);
    const cached = make(device('RelayController', { power1: true }))!;
    adapter.restore(cached);
    await adapter.pruneHidden(() => true);
    expect(onError).toHaveBeenCalledOnce();
    expect(host.unregisterPlatformAccessories).not.toHaveBeenCalled();
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

test.each([
  ['SensorMo', 'motionDetected', 'occupancySensing', { occupancy: { occupied: true } }, { occupancy: { occupied: false } }],
  ['SensorDo', 'doorOpened', 'booleanState', { stateValue: false }, { stateValue: true }],
  ['SensorWater2', 'alarm', 'booleanState', { stateValue: true }, { stateValue: false }],
  ['SensorSmoke3', 'alarm', 'smokeCoAlarm', { smokeState: 2, expressedState: 1 }, { smokeState: 0, expressedState: 0 }],
])('%s true→unknown→false reports reachability without inventing an alarm clear', async (type, field, cluster, positive, negative) => {
  const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
  const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
  const active = device(type as string, { [field as string]: true });
  await adapter.reconcile([active]);
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), cluster, positive, undefined);
  vi.mocked(host.updateAccessoryState).mockClear();
  await adapter.update(device(type as string, { [field as string]: null }));
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'bridgedDeviceBasicInformation', { reachable: false }, undefined);
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), cluster, {}, undefined);
  expect(host.updateAccessoryState).not.toHaveBeenCalledWith(expect.any(String), cluster, negative, undefined);
  vi.mocked(host.updateAccessoryState).mockClear();
  await adapter.update(device(type as string, { [field as string]: false }));
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), cluster, negative, undefined);
  adapter.dispose();
});

test.each([
  ['RelayController', 'power1', undefined],
  ['Switch2', 'power2', 'power2'],
  ['LightWw1', 'power', undefined],
])('%s true→unknown→false never publishes a false power report during outage', async (type, field, partId) => {
  const host = { ...api, registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
  const adapter = new MatterAdapter(host, vi.fn(), [], vi.fn());
  const extra = type === 'LightWw1' ? { brightness: 50, temperature: 50 } : type === 'Switch2' ? { power1: true } : {};
  await adapter.reconcile([device(type as string, { ...extra, [field as string]: true })]);
  vi.mocked(host.updateAccessoryState).mockClear();
  await adapter.update(device(type as string, { ...extra, [field as string]: null }));
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'bridgedDeviceBasicInformation', { reachable: false }, undefined);
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'onOff', {}, partId);
  expect(host.updateAccessoryState).not.toHaveBeenCalledWith(expect.any(String), 'onOff', { onOff: false }, partId);
  vi.mocked(host.updateAccessoryState).mockClear();
  await adapter.update(device(type as string, { ...extra, [field as string]: false }));
  expect(host.updateAccessoryState).toHaveBeenCalledWith(expect.any(String), 'onOff', { onOff: false }, partId);
  adapter.dispose();
});
