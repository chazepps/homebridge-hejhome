import { expect, test, vi } from 'vitest';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { IrHapButtons } from '../src/media/irHapButtons.js';

function setup(send: () => Promise<void>) {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('TV', api.hap.uuid.generate('review-ir'));
  const helper = new IrHapButtons({ accessory, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    deviceType: 'IrTv', enabled: true, send });
  const on = accessory.getServiceById(api.hap.Service.Switch, 'remote-volume-up')!.getCharacteristic(api.hap.Characteristic.On);
  return { api, accessory, helper, on };
}

test('a disposed helper cannot commit a pending button write into the cached characteristic', async () => {
  let complete!: () => void;
  const { helper, on } = setup(() => new Promise<void>((resolve) => {
    complete = resolve;
  }));
  const pending = on.handleSetRequest(true);
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  helper.dispose();
  complete();
  await expect(pending).rejects.toBeDefined();
  expect(on.value).toBe(false);
});

test('disposing after a completed button write leaves no cached on state', async () => {
  vi.useFakeTimers();
  try {
    const { helper, on } = setup(async () => undefined);
    await on.handleSetRequest(true);
    helper.dispose();
    await vi.runAllTimersAsync();
    expect(on.value).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('unsupported IR types remove old owned buttons without adding new controls', () => {
  const { api, accessory, helper } = setup(async () => undefined);
  helper.dispose();
  const unsupported = new IrHapButtons({ accessory, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    deviceType: 'IrUnknown', enabled: true, send: vi.fn() });
  expect(accessory.services.filter((service) => service.subtype?.startsWith('remote-'))).toHaveLength(0);
  unsupported.dispose();
});
