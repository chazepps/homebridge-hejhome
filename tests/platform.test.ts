import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { API, Logging, PlatformAccessory } from 'homebridge';

import { HejhomePlatform } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import { SessionStore } from '../src/storage/sessionStore.js';
import { HejRealtimeClient } from '../src/hej/realtime.js';
import type { HejSession } from '../src/types.js';

const session: HejSession = {
  identifier: 'user@example.test', autoLogin: true, accessToken: 'private-token',
  jsessionId: 'session-id', usernameCookie: 'user%40example.test', expiresAt: 1792000000000,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) {
    await action();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createApiMock() {
  const listeners = new Map<string, () => void | Promise<void>>();
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-platform-'));

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
      storagePath: () => storageRoot,
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
  cleanup.push(async () => {
    await api.trigger('shutdown');
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  return api;
}

const log = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as Logging;

describe('HejhomePlatform', () => {
  test.each([
    { platform: PLATFORM_NAME },
    { platform: PLATFORM_NAME, name: 'Hejhome' },
    {
      platform: PLATFORM_NAME, name: 'Hejhome', auth: { identifier: 'user@example.test', sessionConfigured: true },
      scope: { mode: 'all' as const }, debug: true,
    },
  ])('starts safely with configured fields but no stored credentials: %j', async (config) => {
    vi.clearAllMocks();
    const api = createApiMock();
    const fetchMock = vi.fn(() => {
      throw new Error('Unexpected network call');
    });
    vi.stubGlobal('fetch', fetchMock);
    new HejhomePlatform(log, config, api);

    await api.trigger('didFinishLaunching');
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'Hejhome initialize.no-session:', expect.any(Object),
    ));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    await api.trigger('shutdown');
    expect(log.info).toHaveBeenCalledWith('Hejhome session-watcher.stopped:', {});
  });

  test('contains discovery network failures and preserves cached accessories', async () => {
    vi.clearAllMocks();
    const api = createApiMock();
    await new SessionStore(api.user.storagePath()).save(session);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline authCode=654321 access_token=private-token');
    }));
    const connect = vi.spyOn(HejRealtimeClient.prototype, 'connect');
    const platform = new HejhomePlatform(log, { platform: PLATFORM_NAME }, api);
    platform.configureAccessory({ UUID: 'uuid:cached', displayName: 'Cached', context: {} } as PlatformAccessory);

    await api.trigger('didFinishLaunching');
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith('Hejhome initialize.failed:', expect.any(Object)));

    expect(platform.accessories.size).toBe(1);
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toMatch(/654321|private-token/);
  });

  test('does not start discovery when shutdown occurs while loading the session', async () => {
    const api = createApiMock();
    let finishLoad!: (value: HejSession) => void;
    vi.spyOn(SessionStore.prototype, 'load').mockReturnValue(new Promise((resolve) => {
      finishLoad = resolve;
    }));
    const fetchMock = vi.fn(async () => new Response('{"result":[]}'));
    vi.stubGlobal('fetch', fetchMock);
    const connect = vi.spyOn(HejRealtimeClient.prototype, 'connect').mockImplementation(() => undefined);
    new HejhomePlatform(log, { platform: PLATFORM_NAME }, api);

    await api.trigger('didFinishLaunching');
    await api.trigger('shutdown');
    finishLoad(session);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  test('aborts an in-flight cloud request when Homebridge shuts down', async () => {
    const api = createApiMock();
    await new SessionStore(api.user.storagePath()).save(session);
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    new HejhomePlatform(log, { platform: PLATFORM_NAME }, api);

    await api.trigger('didFinishLaunching');
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await api.trigger('shutdown');

    expect(requestSignal?.aborted).toBe(true);
  });

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
