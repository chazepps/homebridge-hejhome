import { afterEach, describe, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus } from 'homebridge';
import type { MatterAPI } from 'homebridge';
import { createMatterAccessory } from '../src/matter/accessory.js';
import { MatterAdapter } from '../src/matter/adapter.js';
import type { HejDevice } from '../src/types.js';

const api = { deviceTypes, uuid: { generate: (s: string) => `uuid:${s}` }, status: MatterStatus } as unknown as MatterAPI;
const light = (state: Record<string, unknown>): HejDevice =>
  ({ id: 'light', name: 'Light', deviceType: 'LightRgbw5', deviceState: state });

afterEach(() => vi.useRealTimers());

describe('Matter LevelControl relative dimming', () => {
  test('steps from the reported level, clamps at both ends and uses COLOUR HSV control', async () => {
    let device = light({ power: true, lightMode: 'COLOUR', brightness: 50,
      hsvColor: { hue: 120, saturation: 60, brightness: 50 } });
    const send = vi.fn(async (requirements: Record<string, unknown>) => {
      const hsv = requirements.hsvColor as { brightness: number };
      device = light({ ...device.deviceState, brightness: hsv.brightness,
        hsvColor: { ...device.deviceState?.hsvColor, ...hsv } });
    });
    const accessory = createMatterAccessory(api, () => device, send, [])!;
    await accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 25, transitionTime: null } as never);
    await accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 25, transitionTime: null } as never);
    expect(send).toHaveBeenLastCalledWith({ hsvColor: { hue: 120, saturation: 60, brightness: 70 } });
    await accessory.handlers!.levelControl!.step!({ stepMode: 1, stepSize: 254, transitionTime: null } as never);
    expect(send).toHaveBeenLastCalledWith({ hsvColor: { hue: 120, saturation: 60, brightness: 1 } });
  });

  test('rejects unknown level and invalid direction without sending', async () => {
    const send = vi.fn();
    const accessory = createMatterAccessory(api, () => light({ lightMode: 'WHITE' }), send, [])!;
    expect(accessory.clusters?.levelControl?.currentLevel).toBeUndefined();
    expect(accessory.clusters?.bridgedDeviceBasicInformation?.reachable).toBe(false);
    await expect(accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 10 } as never)).rejects.toThrow();
    await expect(accessory.handlers!.levelControl!.step!({ stepMode: 2, stepSize: 10 } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test('failed step does not commit a new level', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('HTTP 401')).mockResolvedValue(undefined);
    const accessory = createMatterAccessory(api, () => light({ brightness: 50, lightMode: 'WHITE' }), send, [])!;
    await expect(accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 25 } as never)).rejects.toThrow('HTTP 401');
    await accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 25 } as never);
    expect(send).toHaveBeenNthCalledWith(1, { brightness: 60 });
    expect(send).toHaveBeenNthCalledWith(2, { brightness: 60 });
  });

  test.each([
    { brightness: 50, hsvColor: { saturation: 60, brightness: 50 } },
    { brightness: 50, hsvColor: { hue: 120, brightness: 50 } },
  ])('incomplete COLOUR state cannot change brightness or invent a colour', async (state) => {
    const send = vi.fn();
    const accessory = createMatterAccessory(api, () => light({ power: true, lightMode: 'COLOUR', ...state }), send, [])!;
    await expect(accessory.handlers!.levelControl!.step!({ stepMode: 0, stepSize: 25 } as never)).rejects.toThrow();
    await expect(accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 25 } as never)).rejects.toThrow();
    await expect(accessory.handlers!.levelControl!.moveToLevel!({ level: 152 } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('bounded Matter continuous dimming', () => {
  test('move sends bounded software steps and stop cancels future requests', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const registerPlatformAccessories = vi.fn();
    const host = { ...api, registerPlatformAccessories,
      updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, async (_id, requirements) => {
      await send(requirements);
    }, [], vi.fn());
    const device: HejDevice = { ...light({ power: true, brightness: 40, lightMode: 'WHITE' }), deviceType: 'LightWw1' };
    await adapter.reconcile([device]);
    const accessory = registerPlatformAccessories.mock.calls[0]![2][0];
    await accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 25 } as never);
    await vi.advanceTimersByTimeAsync(3000);
    await accessory.handlers!.levelControl!.stop!({} as never);
    const count = send.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(count);
    adapter.dispose();
  });

  test('continuous move respects request budget, external override and shutdown', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const registerPlatformAccessories = vi.fn();
    const host = { ...api, registerPlatformAccessories,
      updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, async (_id, requirements) => {
      await send(requirements);
    }, [], vi.fn());
    const device: HejDevice = { ...light({ brightness: 40, lightMode: 'WHITE' }), deviceType: 'LightWw1' };
    await adapter.reconcile([device]);
    const accessory = registerPlatformAccessories.mock.calls[0]![2][0];
    await accessory.handlers.levelControl.move({ moveMode: 0, rate: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send.mock.calls.length).toBeLessThanOrEqual(20);
    const capped = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(capped);
    await accessory.handlers.levelControl.move({ moveMode: 1, rate: 10 });
    await adapter.update({ ...device, deviceState: { brightness: 30, lightMode: 'WHITE' } });
    const overridden = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(overridden);
    await accessory.handlers.levelControl.move({ moveMode: 0, rate: 10 });
    adapter.dispose();
    const disposed = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(disposed);
  });

  test('move rejects unknown level or missing rate and never sends', async () => {
    const send = vi.fn();
    const accessory = createMatterAccessory(api, () => light({}), send, [])!;
    await expect(accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 25 } as never)).rejects.toThrow();
    await expect(accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: null } as never)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test('stop and move restart retain the device request interval', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const accessory = createMatterAccessory(api,
      () => ({ ...light({ power: true, brightness: 50 }), deviceType: 'LightWw1' }), send, [])!;
    await accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 1 } as never);
    await accessory.handlers!.levelControl!.stop!({} as never);
    for (let attempt = 0; attempt < 24; attempt++) {
      await expect(accessory.handlers!.levelControl!.move!({ moveMode: 1, rate: 1 } as never)).rejects.toThrow();
    }
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await accessory.handlers!.levelControl!.move!({ moveMode: 1, rate: 1 } as never);
    expect(send).toHaveBeenCalledTimes(2);
    await accessory.handlers!.levelControl!.stop!({} as never);
  });

  test('Matter power and colour commands cancel an active move', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const accessory = createMatterAccessory(api, () => light({ power: true, lightMode: 'COLOUR', brightness: 50,
      hsvColor: { hue: 120, saturation: 60, brightness: 50 } }), send, [])!;
    await accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 25 } as never);
    await accessory.handlers!.onOff!.off!({});
    const afterOff = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(afterOff);
    await vi.advanceTimersByTimeAsync(1000);
    await accessory.handlers!.levelControl!.move!({ moveMode: 0, rate: 25 } as never);
    send.mockClear();
    await accessory.handlers!.colorControl!.moveToHueAndSaturationLogic!({ hue: 127, saturation: 127, transitionTime: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ hsvColor: { hue: 180, saturation: 50, brightness: 50 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('unchanged health and battery refresh retain move, manual brightness change stops it', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();
    const host = { ...api, registerPlatformAccessories: register, updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, async (_id, requirements) => {
      await send(requirements);
    }, [], vi.fn());
    const device: HejDevice = { ...light({ power: true, brightness: 50, battery: 80 }), deviceType: 'LightWw1' };
    await adapter.reconcile([device]);
    const accessory = register.mock.calls[0]![2][0];
    await accessory.handlers.levelControl.move({ moveMode: 0, rate: 10 });
    await adapter.update({ ...device });
    await adapter.update({ ...device, deviceState: { ...device.deviceState, battery: 79 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    await adapter.update({ ...device, deviceState: { ...device.deviceState, brightness: 31 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  test('matching early MQTT echo does not cancel pending move; conflicting colour does', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }))
      .mockResolvedValue(undefined);
    const register = vi.fn();
    const host = { ...api, registerPlatformAccessories: register, updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, async (_id, requirements) => {
      await send(requirements);
    }, [], vi.fn());
    const device = light({ power: true, lightMode: 'COLOUR', brightness: 50,
      hsvColor: { hue: 120, saturation: 60, brightness: 50 } });
    await adapter.reconcile([device]);
    const accessory = register.mock.calls[0]![2][0];
    const moving = accessory.handlers.levelControl.move({ moveMode: 0, rate: 25 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await adapter.update({ ...device, deviceState: { ...device.deviceState, brightness: 60,
      hsvColor: { hue: 120, saturation: 60, brightness: 60 } } });
    release(); await moving;
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    await adapter.update({ ...device, deviceState: { ...device.deviceState, brightness: 60,
      hsvColor: { hue: 240, saturation: 60, brightness: 60 } } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  test('a delayed echo of the preceding move target cannot cancel the next move tick', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();
    const host = { ...api, registerPlatformAccessories: register, updatePlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(), updateAccessoryState: vi.fn() } as unknown as MatterAPI;
    const adapter = new MatterAdapter(host, async (_id, requirements) => {
      await send(requirements);
    }, [], vi.fn());
    const device = light({ power: true, lightMode: 'COLOUR', brightness: 50,
      hsvColor: { hue: 120, saturation: 60, brightness: 50 } });
    await adapter.reconcile([device]);
    const accessory = register.mock.calls[0]![2][0];
    await accessory.handlers.levelControl.move({ moveMode: 0, rate: 25 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    // The first 60% report arrives after the controller has already requested 70%.
    await adapter.update({ ...device, deviceState: { ...device.deviceState, brightness: 60,
      hsvColor: { hue: 120, saturation: 60, brightness: 60 } } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(3);
    await adapter.update({ ...device, deviceState: { ...device.deviceState, brightness: 35,
      hsvColor: { hue: 120, saturation: 60, brightness: 35 } } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(3);
    adapter.dispose();
  });
});
