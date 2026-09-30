import { describe, expect, test, vi } from 'vitest';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { IrHapButtons } from '../src/media/irHapButtons.js';

function fixture(deviceType = 'IrTv', enabled = true) {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('거실 TV', api.hap.uuid.generate('hej-tv-1'));
  const base = accessory.addService(api.hap.Service.Switch, '거실 TV 전원');
  const send = vi.fn(async () => undefined);
  const buttons = new IrHapButtons({
    accessory,
    Service: api.hap.Service,
    Characteristic: api.hap.Characteristic,
    deviceType,
    enabled,
    send,
  });
  return { api, accessory, base, send, buttons };
}

describe('opt-in IR HAP buttons', () => {
  test('adds six verified TV commands to the existing accessory with stable subtypes', () => {
    const { api, accessory, base, buttons } = fixture();
    expect(accessory.getService(api.hap.Service.Switch)).toBe(base);
    expect(accessory.services.filter((service) => service.UUID === api.hap.Service.Switch.UUID)
      .map((service) => service.subtype).sort()).toEqual([
      undefined,
      'remote-channel-down', 'remote-channel-up', 'remote-mute-off', 'remote-mute-on',
      'remote-volume-down', 'remote-volume-up',
    ].sort());
    expect(accessory.getService(api.hap.Service.Television)).toBeUndefined();
    buttons.dispose();
  });

  test('repeated on writes send repeated commands and reset the actual HAP characteristic', async () => {
    const { api, accessory, send, buttons } = fixture();
    const on = accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')!
      .getCharacteristic(api.hap.Characteristic.On);
    for (let i = 0; i < 2; i++) {
      await on.handleSetRequest(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(on.value).toBe(false);
      expect(await on.handleGetRequest()).toBe(false);
    }
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { type: 'volume', direction: 'up' }, { type: 'volume', direction: 'up' },
    ]);
    await on.handleSetRequest(false);
    expect(send).toHaveBeenCalledTimes(2);
    buttons.dispose();
  });

  test('fan gets only two stateless control buttons', async () => {
    const { api, accessory, send, buttons } = fixture('IrFan');
    const switches = accessory.services.filter((service) => service.UUID === api.hap.Service.Switch.UUID);
    expect(switches.map((service) => service.subtype).sort()).toEqual([
      undefined, 'remote-fan-speed', 'remote-fan-swing',
    ].sort());
    await accessory.getServiceById(api.hap.Service.Switch, 'remote-fan-speed')!
      .getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
    expect(send).toHaveBeenCalledWith({ type: 'cycleSpeed' });
    buttons.dispose();
  });

  test('opt-out removes only the helper-owned cached services', () => {
    const { api, accessory, base, buttons } = fixture();
    buttons.dispose();
    const disabled = new IrHapButtons({ accessory, Service: api.hap.Service,
      Characteristic: api.hap.Characteristic, deviceType: 'IrTv', enabled: false, send: vi.fn() });
    expect(accessory.services.filter((service) => service.UUID === api.hap.Service.Switch.UUID)).toEqual([base]);
    expect(accessory.UUID).toBe(api.hap.uuid.generate('hej-tv-1'));
    disabled.dispose();
  });

  test('changing supported model removes obsolete button services', () => {
    const { api, accessory, buttons } = fixture();
    buttons.dispose();
    const fan = new IrHapButtons({ accessory, Service: api.hap.Service,
      Characteristic: api.hap.Characteristic, deviceType: 'IrFan', enabled: true, send: vi.fn() });
    expect(accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')).toBeUndefined();
    expect(accessory.getServiceById(api.hap.Service.Switch, 'remote-fan-swing')).toBeDefined();
    fan.dispose();
  });

  test('offline guard blocks reads and writes before sending', async () => {
    const api = new HomebridgeAPI();
    const accessory = new api.platformAccessory('TV', api.hap.uuid.generate('offline-tv'));
    const send = vi.fn(async () => undefined);
    const buttons = new IrHapButtons({ accessory, Service: api.hap.Service,
      Characteristic: api.hap.Characteristic, deviceType: 'IrTv', enabled: true, send,
      ensureAvailable: () => {
        throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } });
    const on = accessory.getServiceById(api.hap.Service.Switch, 'remote-mute-on')!
      .getCharacteristic(api.hap.Characteristic.On);
    await expect(on.handleGetRequest()).rejects.toBeDefined();
    await expect(on.handleSetRequest(true)).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
    buttons.dispose();
  });

  test('transport failure never reports a successful momentary command', async () => {
    const { api, accessory, send, buttons } = fixture();
    send.mockRejectedValueOnce(new Error('cloud rejected'));
    const on = accessory.getServiceById(api.hap.Service.Switch, 'remote-channel-down')!
      .getCharacteristic(api.hap.Characteristic.On);
    await expect(on.handleSetRequest(true)).rejects.toBeDefined();
    expect(on.value).toBe(false);
    buttons.dispose();
  });

  test('disposed button characteristics reject reads and writes without sending', async () => {
    const { api, accessory, send, buttons } = fixture();
    const on = accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')!
      .getCharacteristic(api.hap.Characteristic.On);
    buttons.dispose();
    await expect(on.handleGetRequest()).rejects.toBeDefined();
    await expect(on.handleSetRequest(true)).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  test('reusing cached buttons updates their HAP names after an accessory rename', () => {
    const { api, accessory, buttons } = fixture();
    const service = accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')!;
    service.addCharacteristic(api.hap.Characteristic.ConfiguredName);
    service.updateCharacteristic(api.hap.Characteristic.ConfiguredName, '옛 이름');
    buttons.dispose();
    accessory.displayName = '새 거실 TV';
    const renamed = new IrHapButtons({ accessory, Service: api.hap.Service,
      Characteristic: api.hap.Characteristic, deviceType: 'IrTv', enabled: true, send: vi.fn() });
    expect(service.displayName).toBe('새 거실 TV 소리 크게');
    expect(service.getCharacteristic(api.hap.Characteristic.Name).value).toBe('새 거실 TV 소리 크게');
    expect(service.getCharacteristic(api.hap.Characteristic.ConfiguredName).value).toBe('새 거실 TV 소리 크게');
    renamed.dispose();
  });
});
