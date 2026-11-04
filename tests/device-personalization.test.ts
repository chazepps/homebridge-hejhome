import { expect, test, vi } from 'vitest';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { normalizeFeatures } from '../src/features.js';
import { IrHapButtons } from '../src/media/irHapButtons.js';
import { validateDevicePersonalization } from '../src/devices/personalization.js';
import { createMatterAccessory } from '../src/matter/accessory.js';
import { deviceTypes, MatterStatus, type MatterAPI } from 'homebridge';
import { editorValue, serializePreference } from '../homebridge-ui/src/pages/devices/model.js';
import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejhomePlatform } from '../src/platform.js';

test('personalization accepts trimmed names and stable favorite identifiers', () => {
  expect(normalizeFeatures({ devices: { tv: { favoriteChannels: [{ id: 'news', name: ' 뉴스 ', channel: 11 }] },
    strip: { channelNames: { power1: ' 책상 ' } }, purifier: { purifierModeButtons: true } } }).devices)
    .toEqual({ tv: { favoriteChannels: [{ id: 'news', name: '뉴스', channel: 11 }] },
      strip: { channelNames: { power1: '책상' } }, purifier: { purifierModeButtons: true } });
});

test('malformed favorites and port names cannot enter configuration', () => {
  for (const preference of [
    { favoriteChannels: [{ id: 'same', name: 'A', channel: 1 }, { id: 'same', name: 'B', channel: 2 }] },
    { favoriteChannels: [{ id: '../a', name: 'A', channel: 1 }] },
    { favoriteChannels: [{ id: 'a', name: ' ', channel: 1 }] },
    { favoriteChannels: [{ id: 'a', name: 'A', channel: 1000 }] },
    { favoriteChannels: [{ id: 'a', name: 'A', channel: 1.5 }] },
    { favoriteChannels: Array.from({ length: 9 }, (_, n) => ({ id: `c${n}`, name: 'A', channel: n })) },
    { channelNames: { power7: 'A' } }, { channelNames: { power1: ' ' } }, { purifierModeButtons: 'yes' },
  ]) {
    expect(() => normalizeFeatures({ devices: { d: preference } })).toThrow();
  }
});

test('device contract rejects wrong types and aggregate strip commands', () => {
  for (const [deviceType, preference] of [
    ['IrFan', { favoriteChannels: [{ id: 'a', name: 'A', channel: 1 }] }],
    ['Plug', { purifierModeButtons: true }],
    ['PowerStrip', { channelNames: { power5: 'All' } }], ['Switch2', { channelNames: { power3: 'Extra' } }],
  ] as const) {
    expect(() => validateDevicePersonalization({ deviceType }, preference)).toThrow();
  }
});

test('UI roundtrips personalization without regenerating favorite IDs or blank port names', () => {
  const preference = { favoriteChannels: [{ id: 'news', name: '뉴스', channel: 11 }] };
  expect(serializePreference(editorValue(preference), { id: 'tv', name: 'TV', deviceType: 'IrTv' }, []))
    .toEqual(preference);
  expect(serializePreference({ ...editorValue({}), channelNames: { power1: '책상', power2: '' } },
    { id: 'switch', name: 'Switch', deviceType: 'Switch2' }, []))
    .toEqual({ channelNames: { power1: '책상' } });
});

test('Matter port labels change without changing UUID, part IDs, types or command keys', async () => {
  const api = { deviceTypes, status: MatterStatus, uuid: { generate: (id: string) => id } } as unknown as MatterAPI;
  const device = { id: 'switch', name: 'Switch', deviceType: 'Switch2', deviceState: { power1: true, power2: false } };
  const send = vi.fn(async () => undefined);
  const before = createMatterAccessory(api, () => device, send, [])!;
  const after = createMatterAccessory(api, () => device, send, [], undefined, undefined, undefined, { power1: '책상' })!;
  expect(after.UUID).toBe(before.UUID);
  expect(after.parts?.map((part) => [part.id, part.deviceType.code])).toEqual(before.parts?.map((part) => [part.id, part.deviceType.code]));
  expect(after.parts?.[0]?.displayName).toBe('책상');
  await after.parts![0]!.handlers!.onOff!.off!();
  expect(send).toHaveBeenCalledExactlyOnceWith({ power1: false });
});

test('cached HAP port names change and clear without replacing services', () => {
  const api = new HomebridgeAPI();
  const features = { matter: false, adaptiveLighting: false, meters: [], devices: { sw: { channelNames: { power1: '책상' } } } };
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as HejhomePlatform;
  const device = { id: 'sw', name: 'Switch', deviceType: 'Switch2', deviceState: { power1: true, power2: false } };
  const accessory = new api.platformAccessory('Switch', api.hap.uuid.generate('sw'));
  const first = new HejhomePlatformAccessory(platform, accessory, device, null);
  const port = accessory.getServiceById(api.hap.Service.Switch, 'power1')!;
  expect(port.displayName).toBe('책상');
  first.dispose();
  features.devices.sw.channelNames = {} as { power1: string };
  const restored = new HejhomePlatformAccessory(platform, accessory, device, null);
  expect(accessory.getServiceById(api.hap.Service.Switch, 'power1')).toBe(port);
  expect(port.displayName).toBe('Switch 스위치 1');
  expect(port.getCharacteristic(api.hap.Characteristic.Name).value).toBe('Switch 스위치 1');
  restored.dispose();
});

test('a cached secondary USB port restores its default name even when its latest report omits the port', () => {
  const api = new HomebridgeAPI();
  const features = { matter: false, adaptiveLighting: false, meters: [], devices: { strip: { channelNames: { power6: 'USB custom' } } } };
  const platform = { api, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    features, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as HejhomePlatform;
  const device = { id: 'strip', name: 'Strip', deviceType: 'PowerStrip',
    deviceState: { power1: true, power2: false, power3: false, power4: false, power5: false, power6: false } };
  const accessory = new api.platformAccessory('Strip', api.hap.uuid.generate('strip'));
  const first = new HejhomePlatformAccessory(platform, accessory, device, null);
  const port = accessory.getServiceById(api.hap.Service.Outlet, 'power6')!;
  expect(port.displayName).toBe('USB custom');
  first.dispose();
  features.devices.strip.channelNames = {} as { power6: string };
  const state: Partial<typeof device.deviceState> = { ...device.deviceState };
  delete state.power6;
  const restored = new HejhomePlatformAccessory(platform, accessory, { ...device, deviceState: state }, null);
  expect(accessory.getServiceById(api.hap.Service.Outlet, 'power6')).toBe(port);
  expect(port.displayName).toBe('Strip 콘센트 5');
  restored.dispose();
});

test('favorite channel edits reuse a real HAP service and deletion removes only owned buttons', async () => {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('TV', api.hap.uuid.generate('favorite-tv'));
  const base = accessory.addService(api.hap.Service.Switch, 'Power');
  const send = vi.fn(async () => undefined);
  const options = { accessory, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    deviceType: 'IrTv', enabled: false, send };
  const first = new IrHapButtons({ ...options, favoriteChannels: [{ id: 'news', name: '뉴스', channel: 11 }] });
  const service = accessory.getServiceById(api.hap.Service.Switch, 'favorite-channel-news')!;
  expect(service).toBeDefined();
  await service.getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'setChannel', channel: 11 });
  first.dispose();
  const changed = new IrHapButtons({ ...options, favoriteChannels: [{ id: 'news', name: '영화', channel: 22 }] });
  expect(accessory.getServiceById(api.hap.Service.Switch, 'favorite-channel-news')).toBe(service);
  expect(service.displayName).toBe('TV 영화');
  await service.getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
  expect(send).toHaveBeenLastCalledWith({ type: 'setChannel', channel: 22 });
  changed.dispose();
  new IrHapButtons(options).dispose();
  expect(accessory.services.filter((item) => item.UUID === api.hap.Service.Switch.UUID)).toEqual([base]);
});

test('purifier mode buttons send single settings and reset without asserting purifier state', async () => {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('청정기', api.hap.uuid.generate('purifier-buttons'));
  const sendPurifierMode = vi.fn(async () => undefined);
  const buttons = new IrHapButtons({ accessory, Service: api.hap.Service, Characteristic: api.hap.Characteristic,
    deviceType: 'Airpurifier', enabled: false, send: vi.fn(), purifierModeButtons: true, sendPurifierMode });
  for (const mode of ['auto', 'manual', 'sleep'] as const) {
    const service = accessory.getServiceById(api.hap.Service.Switch, `purifier-mode-${mode}`);
    expect(service).toBeDefined();
    const on = service!.getCharacteristic(api.hap.Characteristic.On);
    await on.handleSetRequest(true);
    await vi.waitFor(() => expect(on.value).toBe(false));
    expect(sendPurifierMode).toHaveBeenLastCalledWith(mode);
  }
  expect(sendPurifierMode).toHaveBeenCalledTimes(3);
  buttons.dispose();
});
