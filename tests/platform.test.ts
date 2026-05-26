import { describe, expect, test, vi } from 'vitest';

import type { API, Logging, PlatformAccessory } from 'homebridge';

import { HejhomePlatform } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

function createApiMock() {
  const listeners = new Map<string, () => void | Promise<void>>();
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];

  const api = {
    hap: {
      uuid: {
        generate: (value: string) => `uuid:${value}`,
      },
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        Lightbulb: 'Lightbulb',
        Switch: 'Switch',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        Name: 'Name',
        On: 'On',
        SerialNumber: 'SerialNumber',
      },
    },
    on: (event: string, callback: () => void | Promise<void>) => {
      listeners.set(event, callback);
    },
    platformAccessory: vi.fn(function PlatformAccessoryMock(this: PlatformAccessory, displayName: string, uuid: string) {
      this.displayName = displayName;
      this.UUID = uuid;
      this.context = {};
      this.getService = vi.fn(() => ({
        setCharacteristic: vi.fn().mockReturnThis(),
        getCharacteristic: vi.fn(() => ({
          onGet: vi.fn().mockReturnThis(),
          onSet: vi.fn().mockReturnThis(),
          updateCharacteristic: vi.fn().mockReturnThis(),
        })),
      }));
      this.addService = vi.fn(() => ({
        setCharacteristic: vi.fn().mockReturnThis(),
        getCharacteristic: vi.fn(() => ({
          onGet: vi.fn().mockReturnThis(),
          onSet: vi.fn().mockReturnThis(),
          updateCharacteristic: vi.fn().mockReturnThis(),
        })),
      }));
    }),
    registerPlatformAccessories: vi.fn((plugin: string, platform: string, accessories: PlatformAccessory[]) => {
      expect(plugin).toBe(PLUGIN_NAME);
      expect(platform).toBe(PLATFORM_NAME);
      registered.push(...accessories);
    }),
    unregisterPlatformAccessories: vi.fn((plugin: string, platform: string, accessories: PlatformAccessory[]) => {
      expect(plugin).toBe(PLUGIN_NAME);
      expect(platform).toBe(PLATFORM_NAME);
      unregistered.push(...accessories);
    }),
    updatePlatformAccessories: vi.fn(),
    user: {
      storagePath: () => '/tmp/homebridge-hejhome-test',
    },
  } as unknown as API & {
    trigger: (event: string) => Promise<void>;
    registered: PlatformAccessory[];
    unregistered: PlatformAccessory[];
  };

  api.trigger = async (event: string) => {
    await listeners.get(event)?.();
  };
  api.registered = registered;
  api.unregistered = unregistered;

  return api;
}

const log = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as Logging;

describe('HejhomePlatform', () => {
  test('does not start cloud discovery when the plugin has no stored session', async () => {
    vi.clearAllMocks();
    const api = createApiMock();
    const platform = new HejhomePlatform(log, { name: 'Hejhome', platform: PLATFORM_NAME }, api);

    platform.configureAccessory({
      UUID: 'uuid:stale',
      displayName: 'Stale',
      context: { device: { id: 'stale' } },
    } as PlatformAccessory);

    await api.trigger('didFinishLaunching');

    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith(
        'Hejhome initialize.no-session:',
        expect.objectContaining({ message: expect.stringContaining('complete login') }),
      );
    });
  });
});
