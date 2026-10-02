import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deviceTypes, MatterStatus, type API, type Logging, type MatterAPI } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import type { HejDevice, HejSession, HejhomePlatformConfig } from '../src/types.js';
import { DeviceSnapshotStore } from '../src/storage/deviceSnapshotStore.js';
import type { HejRestLogEvent } from '../src/hej/rest.js';
import { supportsDeviceRole } from '../src/devices/capabilities.js';
import { sendRuntimeCommand } from '../src/runtime/commands.js';
import { loadRuntimeStatus } from '../src/runtime/status.js';
import type { PowerEstimates } from '../src/runtime/powerEstimates.js';
import type { HejRealtimeEvents } from '../src/hej/realtime.js';

const mocks = vi.hoisted(() => ({ clients: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  realtime: [] as Array<{ events: HejRealtimeEvents; disconnect: ReturnType<typeof vi.fn> }>,
  loggers: [] as Array<(event: HejRestLogEvent) => void>,
  families: [{ familyId: 1, name: 'Home' }], devices: [] as HejDevice[], fail: false, connectDuringDiscovery: false }));
vi.mock('../src/hej/rest.js', () => ({ HejRestClient: class {
  getFamilies = vi.fn(async () => {
    if (mocks.connectDuringDiscovery) {
      // Production order: REST start is logged while MQTT is still connecting.
      mocks.loggers.at(-1)?.({ path: 'dashboard/family', method: 'GET', status: 'start' });
      mocks.realtime.at(-1)?.events.onStatus?.('connect.success');
      mocks.loggers.at(-1)?.({ path: 'dashboard/family', method: 'GET', status: 'success', httpStatus: 200 });
    }
    return mocks.families;
  });
  getDevices = vi.fn(async (family: number) => {
    if (mocks.fail && family === 2) {
      throw new Error('family unavailable');
    }
    return mocks.devices;
  });
  controlDevice = vi.fn(async () => undefined);
  dispose = vi.fn();
  constructor(_session: HejSession, options: { logger: (event: HejRestLogEvent) => void }) {
    mocks.clients.push(this); mocks.loggers.push(options.logger);
  }
} }));
// Lifecycle checks keep real session, snapshot and status I/O; log-file behavior has its own storage tests.
vi.mock('../src/storage/logStore.js', () => ({ LogStore: class {
  append = vi.fn(async () => undefined);
} }));
vi.mock('../src/hej/realtime.js', () => ({ HejRealtimeClient: class {
  disconnect = vi.fn(); connect = vi.fn(() => this.events.onStatus?.(mocks.connectDuringDiscovery ? 'connect.start' : 'connect.success'));
  constructor(public session: HejSession, public events: HejRealtimeEvents) {
    mocks.realtime.push(this);
  }
} }));
import { HejhomePlatform } from '../src/platform.js';
import { SessionStore } from '../src/storage/sessionStore.js';

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  mocks.clients.length = 0; mocks.loggers.length = 0; mocks.realtime.length = 0; mocks.fail = false; mocks.connectDuringDiscovery = false;
  mocks.families = [{ familyId: 1, name: 'Home' }]; mocks.devices = [device('one')];
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  } vi.useRealTimers();
});
function device(id: string): HejDevice {
  return { id, name: id, deviceType: 'ZigbeeSwitch1', online: true, deviceState: { power: true } };
}
async function fixture(preferences?: Record<string, unknown>, scope: NonNullable<HejhomePlatformConfig['scope']> = { mode: 'all' }, matter?: MatterAPI) {
  const dir = await fs.mkdtemp(path.join('/tmp', 'hej-runtime-'));
  const store = new SessionStore(dir);
  const session: HejSession = { identifier: 'private', accessToken: 'secret-one', jsessionId: 'cookie',
    usernameCookie: 'user', autoLogin: true, expiresAt: Date.now() + 3600000 };
  await store.save(session);
  const host = new HomebridgeAPI(); const listeners = new Map<string, () => void | Promise<unknown>>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, user: { storagePath: () => dir }, ...(matter ? { matter } : {}),
    on: (e: string, fn: () => void | Promise<unknown>) => listeners.set(e, fn), registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', scope,
    features: { ...(preferences ? { devices: preferences } : {}), ...(matter ? { matter: true } : {}) } } as never, api);
  const internal = platform as unknown as { initialize(): Promise<void>; discoverDevices(): Promise<void>;
    discoveryRunning: Promise<void> | null; refreshDiscovery(): Promise<void>; checkSessionAndInitialize(): Promise<void>;
    initializing: boolean; sessionChecking: boolean; powerEstimates: PowerEstimates; refreshHealth(): void; statusStore: { flush(): Promise<void> } };
  cleanup.push(async () => {
    const shutdown = listeners.get('shutdown')?.();
    vi.useRealTimers();
    await shutdown;
    // A watcher/discovery already awaiting file I/O may finish after shutdown's initial status flush.
    await vi.waitFor(() => {
      expect(internal.initializing).toBe(false);
      expect(internal.sessionChecking).toBe(false);
      expect(internal.discoveryRunning).toBeNull();
    });
    await internal.statusStore.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await internal.initialize();
  return { platform, internal, store, session, api, dir, shutdown: () => listeners.get('shutdown')?.() };
}
test('session replacement disconnects old MQTT and rejects stale in-flight control result', async () => {
  const { platform, internal, store, session } = await fixture();
  let finish!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((r) => {
    finish = r;
  }));
  const command = platform.controlDevice('one', { power: false }, 'hap');
  const rejected = expect(command).rejects.toThrow(/session/i);
  const queued = expect(platform.controlDevice('one', { power: true }, 'matter')).rejects.toThrow(/session/i);
  await vi.waitFor(() => expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledTimes(1));
  await store.save({ ...session, accessToken: 'secret-two' });
  await internal.checkSessionAndInitialize();
  finish(); await rejected; await queued;
  expect(mocks.realtime[0]!.disconnect).toHaveBeenCalledOnce();
  expect(mocks.clients).toHaveLength(2);
  expect(mocks.clients[0]!.dispose).toHaveBeenCalledOnce();
  expect(mocks.clients[1]!.controlDevice).not.toHaveBeenCalled();
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBe(true);
});
test('failed partial discovery does not publish additions or delete cached devices', async () => {
  const { platform, internal, api } = await fixture();
  mocks.families.push({ familyId: 2, name: 'Other' }); mocks.devices = [device('new')]; mocks.fail = true;
  await expect(internal.discoverDevices()).rejects.toThrow('family unavailable');
  expect([...platform.accessories.values()].map((a) => a.context.device.id)).toEqual(['one']);
  expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});
test('runtime snapshots retain the discovery scope used to filter the full provider family list', async () => {
  mocks.families = [{ familyId: 1, name: 'First' }, { familyId: 2, name: 'Second' }];
  const { dir } = await fixture(undefined, { mode: 'custom', includedFamilyIds: [2] });
  const snapshot = await new DeviceSnapshotStore(dir).load();
  expect(snapshot?.families.map((entry) => entry.family.familyId)).toEqual([2]);
  expect(snapshot?.discoveryScope).toEqual({ mode: 'custom', includedFamilyIds: [2] });
});
test('Matter-only devices remain controllable and receive MQTT with no HAP accessory', async () => {
  const { platform } = await fixture({ one: { visibility: 'matter', name: 'Renamed' } });
  expect(platform.accessories.size).toBe(0);
  await platform.controlDevice('one', { power: false }, 'matter');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
});
test('reconnect discovery is bounded and shutdown cancels scheduled rediscovery', async () => {
  const { platform, shutdown } = await fixture();
  vi.useFakeTimers();
  const realtime = mocks.realtime[0]!;
  realtime.events.onStatus?.('connect.success');
  realtime.events.onStatus?.('connect.closed');
  expect(platform.getDeviceHealth('one')).toMatchObject({ reachable: false, reason: 'realtime-disconnected' });
  realtime.events.onStatus?.('connect.success');
  realtime.events.onStatus?.('connect.success');
  shutdown();
  await vi.advanceTimersByTimeAsync(60000);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(1);
});


test('REST unauthorized leaves MQTT measurements readable and reports independent diagnostics', async () => {
  const { platform, dir } = await fixture();
  mocks.realtime[0]!.events.onStatus?.('connect.success');
  mocks.loggers[0]!({ path: 'dashboard/control/one', method: 'POST', status: 'success', httpStatus: 401 });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.connection).toEqual({ session: 'expired', realtime: 'connected' });
    expect(status?.devices[0]?.lastSeenAt).not.toBeNull();
  });
});

test('initial failed discovery retries, restores devices, and later removes absent devices', async () => {
  vi.useFakeTimers();
  mocks.families.push({ familyId: 2, name: 'Other' }); mocks.fail = true;
  const { platform, internal } = await fixture();
  expect(platform.accessories.size).toBe(0);
  expect(mocks.realtime).toHaveLength(1);
  mocks.fail = false;
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => expect(platform.accessories.size).toBe(1));
  await internal.discoveryRunning;
  mocks.devices = [];
  await internal.discoverDevices();
  expect(platform.accessories.size).toBe(0);
});

test('session removal stops MQTT and makes cached devices unavailable without deleting them', async () => {
  const { platform, internal, store } = await fixture();
  await store.clear(); await internal.checkSessionAndInitialize();
  expect(mocks.realtime[0]!.disconnect).toHaveBeenCalledOnce();
  expect(platform.accessories.size).toBe(1);
  expect(platform.getDeviceHealth('one').reachable).toBe(false);
  await expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow('not ready');
});

test('reconnecting does not advertise cached devices as reachable before transport recovery', async () => {
  const { platform } = await fixture();
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  mocks.realtime[0]!.events.onStatus?.('connect.reconnect');
  expect(platform.getDeviceHealth('one').reachable).toBe(false);
  mocks.realtime[0]!.events.onStatus?.('connect.success');
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
});

test('IR power toggle without reported power never fabricates absolute power state', async () => {
  mocks.devices = [{ id: 'one', name: 'TV', deviceType: 'IrTv', deviceState: {} }];
  const { platform } = await fixture();
  await platform.controlDevice('one', { power: true }, 'hap');
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBeUndefined();
});

test('temperature links only expose fresh measurements from temperature sensors', async () => {
  mocks.devices = [device('one'), { id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 22 } }];
  const { platform } = await fixture();
  Object.assign(platform.features, { devices: { one: { temperatureSensorId: 'th' } } });
  expect(platform.getDeviceTemperature('one')).toBeUndefined();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'th', deviceState: { temperature: 22 } });
  expect(platform.getDeviceTemperature('one')).toBe(22);
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  expect(platform.getDeviceTemperature('one')).toBeUndefined();
});


test('a linked sensor update also refreshes the dependent accessory', async () => {
  mocks.devices = [device('one'), { id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: {} }];
  const { platform } = await fixture();
  Object.assign(platform.features, { devices: { one: { temperatureSensorId: 'th' } } });
  const handlers = (platform as unknown as { accessoryHandlers: Map<string, { updateDevice(device: HejDevice): void }> }).accessoryHandlers;
  const dependent = handlers.get(platform.api.hap.uuid.generate('one'))!;
  const update = vi.spyOn(dependent, 'updateDevice');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'th', deviceState: { temperature: 24 } });
  expect(update).toHaveBeenCalled();
});

test('disk-cached devices have unknown health until a successful discovery or live report', async () => {
  const { platform, api } = await fixture();
  const cached = new api.platformAccessory('Cached', api.hap.uuid.generate('cached'));
  cached.context.device = device('cached');
  platform.configureAccessory(cached);
  expect(platform.getDeviceHealth('cached')).toMatchObject({ reachable: false, reason: 'device-unknown' });
});

test('an unknown MQTT device triggers bounded rediscovery without a process restart', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  mocks.devices = [device('one'), device('new')];
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000);
  await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id)).toContain('new');
});

test('periodic inventory reconciliation discovers removal without MQTT disconnect', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 300001);
  mocks.devices = [];
  await internal.checkSessionAndInitialize();
  await vi.advanceTimersByTimeAsync(1);
  await internal.discoveryRunning;
  expect(platform.accessories.size).toBe(0);
});

test('a slow REST discovery cannot overwrite a newer MQTT report', async () => {
  const { platform, internal } = await fixture();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const discovery = internal.discoverDevices();
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  release([{ ...device('one'), online: false }]); await discovery;
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBe(false);
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
});


test('UI remote commands share the HAP queue and never synthesize IR state', async () => {
  mocks.devices = [{ id: 'one', name: 'TV', deviceType: 'IrTv', deviceState: {} }];
  const { platform, dir } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const first = platform.controlDevice('one', { power: true }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  const ui = sendRuntimeCommand(dir, { deviceId: 'one', kind: 'remote', command: { type: 'volume', direction: 'up' } });
  void ui.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledTimes(1);
  release(); await Promise.all([first, ui]);
  expect(mocks.clients[0]!.controlDevice!.mock.calls.map((call) => call[1])).toEqual([{ power: true }, { volume: 'up' }]);
  expect(platform.accessories.values().next().value?.context.device.deviceState).toEqual({});
});

test('UI cannot forge a canonical device type or bypass command validation', async () => {
  const { dir } = await fixture();
  await expect(sendRuntimeCommand(dir, { deviceId: 'one', kind: 'remote', command: { type: 'volume', direction: 'up' } })).rejects.toThrow();
  await expect(sendRuntimeCommand(dir, { deviceId: 'one', kind: 'air-conditioner', command: { power: true } })).rejects.toThrow();
  expect(mocks.clients[0]!.controlDevice).not.toHaveBeenCalled();
});

test('session replacement quarantines cached ownership until the new session verifies the device', async () => {
  const { platform, internal, store, session } = await fixture();
  mocks.families.push({ familyId: 2, name: 'Failing home' }); mocks.fail = true;
  await store.save({ ...session, accessToken: 'new-account' });
  await internal.checkSessionAndInitialize();
  expect(platform.accessories.size).toBe(1);
  expect(platform.getDeviceHealth('one').reachable).toBe(false);
  await expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow();
  expect(mocks.clients[1]!.controlDevice).not.toHaveBeenCalled();
  mocks.realtime[1]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
  expect(platform.getDeviceHealth('one').reachable).toBe(false);
  await expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow('no longer available');
});

test('an earlier MQTT report remains authoritative over an untimestamped REST snapshot', async () => {
  const { platform, internal } = await fixture();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  await internal.discoverDevices();
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBe(false);
});

test('a genuine MQTT state report restores an explicitly offline device', async () => {
  mocks.devices = [{ ...device('one'), online: false }];
  const { platform } = await fixture();
  expect(platform.getDeviceHealth('one').reachable).toBe(false);
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
});

test('rediscovery requested during a slow discovery runs after the active pass', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const running = (internal as unknown as { refreshDiscovery(): Promise<void> }).refreshDiscovery();
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000);
  mocks.devices = [device('one'), device('new')];
  release([device('one')]); await running;
  await vi.advanceTimersByTimeAsync(5000);
  await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id)).toContain('new');
});

test('inventory refresh reuses an unchanged handler instead of discarding controller schedules', async () => {
  const { platform, internal } = await fixture();
  const handlers = (platform as unknown as { accessoryHandlers: Map<string, unknown> }).accessoryHandlers;
  const before = handlers.get(platform.api.hap.uuid.generate('one'));
  await internal.discoverDevices();
  expect(handlers.get(platform.api.hap.uuid.generate('one'))).toBe(before);
});

test('a shutdown while a command is in flight never reports success', async () => {
  const { platform, shutdown } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const pending = expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeDefined());
  shutdown(); release(); await pending;
});

test('session replacement rejects a queued UI command without sending it on the new account', async () => {
  mocks.devices = [{ id: 'one', name: 'TV', deviceType: 'IrTv', deviceState: {} }];
  const { platform, internal, dir, store, session } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const first = platform.controlDevice('one', { power: true }, 'hap');
  const firstRejected = expect(first).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeDefined());
  const pending = expect(sendRuntimeCommand(dir, { deviceId: 'one', kind: 'remote', command: { type: 'volume', direction: 'up' } })).rejects.toThrow();
  const queue = (platform as unknown as { commands: Map<string, Promise<void>> }).commands;
  await vi.waitFor(() => expect(queue.get('one')).not.toBe(first));
  await store.save({ ...session, accessToken: 'replaced' }); await internal.checkSessionAndInitialize();
  release(); await Promise.all([firstRejected, pending]);
  expect(mocks.clients[1]!.controlDevice).not.toHaveBeenCalled();
});

test('an expired UI request waiting behind a HAP command is never dispatched later', async () => {
  mocks.devices = [{ id: 'one', name: 'TV', deviceType: 'IrTv', deviceState: {} }];
  const { platform, dir } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const first = platform.controlDevice('one', { power: true }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  vi.useFakeTimers();
  const ui = expect(sendRuntimeCommand(dir, { deviceId: 'one', kind: 'remote', command: { type: 'volume', direction: 'up' } })).rejects.toThrow();
  const queue = (platform as unknown as { commands: Map<string, Promise<void>> }).commands;
  await vi.waitFor(() => expect(queue.get('one')).not.toBe(first));
  await vi.advanceTimersByTimeAsync(15001); await ui;
  vi.useRealTimers(); await new Promise((resolve) => setImmediate(resolve));
  release(); await first;
  await queue.get('one')?.catch(() => undefined);
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledTimes(1);
});

test('reconnect REST state repairs a missed MQTT actuator update without claiming measurement freshness', async () => {
  mocks.devices.push({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20 } });
  const { platform, internal } = await fixture();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'th', deviceState: { temperature: 21 } });
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  mocks.realtime[0]!.events.onStatus?.('connect.success');
  await internal.discoverDevices();
  expect(platform.accessories.get(platform.api.hap.uuid.generate('one'))?.context.device.deviceState.power).toBe(true);
  expect(platform.getMeasurementHealth('th', 'temperature').reason).toBe('measurement-unknown');
});

test('an actuator MQTT guard expires so a later REST snapshot can reconcile state', async () => {
  const { platform, internal } = await fixture();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5001);
  await internal.discoverDevices();
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBe(true);
});

test('diagnostics expose only fresh measured sensor temperature, never the HVAC target', async () => {
  mocks.devices = [{ id: 'ac', name: 'AC', deviceType: 'IrAirconditioner', deviceState: { temperature: 27 } },
    { id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20 } }];
  const { platform, internal, dir } = await fixture();
  Object.assign(platform.features, { devices: { ac: { temperatureSensorId: 'th' } } });
  await internal.checkSessionAndInitialize();
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.devices.find((device) => device.id === 'ac')?.temperatureCelsius).toBeNull();
    expect(status?.devices.find((device) => device.id === 'th')?.temperatureCelsius).toBeNull();
  });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'th', deviceState: { temperature: 22 } });
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.devices.find((device) => device.id === 'ac')?.temperatureCelsius).toBe(22);
    expect(status?.devices.find((device) => device.id === 'th')?.temperatureCelsius).toBe(22);
  });
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  await vi.waitFor(async () => {
    expect((await loadRuntimeStatus(dir))?.devices.find((device) => device.id === 'ac')?.temperatureCelsius).toBeNull();
  });
});

test('an IR fan without power feedback remains momentary after a successful command', async () => {
  mocks.devices = [{ id: 'one', name: 'IR Fan', deviceType: 'IrFan', deviceState: {} }];
  const { platform } = await fixture();
  await platform.controlDevice('one', { power: true }, 'hap');
  expect(platform.accessories.values().next().value?.context.device.deviceState.power).toBeUndefined();
});

test('a slow control ACK preserves a newer MQTT value for the commanded field', async () => {
  mocks.devices = [{ id: 'one', name: 'Light', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50, temperature: 30 } }];
  const { platform } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const command = platform.controlDevice('one', { brightness: 20 }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { brightness: 70 } });
  release(); await command;
  const accessory = platform.accessories.values().next().value!;
  expect(accessory.context.device.deviceState.brightness).toBe(70);
  expect(accessory.getService(platform.Service.Lightbulb)!.getCharacteristic(platform.Characteristic.Brightness).value).toBe(70);
});

test('an unrelated battery report does not suppress the brightness command commit', async () => {
  mocks.devices = [{ id: 'one', name: 'Light', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50, temperature: 30 } }];
  const { platform } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const command = platform.controlDevice('one', { brightness: 20 }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { battery: 30 } });
  release(); await command;
  expect(platform.accessories.values().next().value?.context.device.deviceState).toMatchObject({ brightness: 20, battery: 30 });
});

test('queued controls capture field revisions only when actually dispatched', async () => {
  mocks.devices = [{ id: 'one', name: 'Light', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50, temperature: 30 } }];
  const { platform } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const first = platform.controlDevice('one', { brightness: 20 }, 'hap');
  const second = platform.controlDevice('one', { brightness: 40 }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { brightness: 70 } });
  release(); await Promise.all([first, second]);
  expect(platform.accessories.values().next().value?.context.device.deviceState.brightness).toBe(40);
});

test('Matter host post-handler auto-commit is corrected to the latest observed canonical state', async () => {
  mocks.devices = [{ id: 'one', name: 'Light', deviceType: 'LightWw1', deviceState: { power: true, brightness: 50, temperature: 30 } }];
  const { platform } = await fixture();
  let hostBrightness = 50;
  const adapter = { accept: vi.fn(), update: vi.fn(async (device: HejDevice) => {
    hostBrightness = Number(device.deviceState?.brightness);
  }),
  dispose: vi.fn(), hasDevice: () => true };
  Object.defineProperty(platform, 'matter', { value: adapter }); Object.assign(platform.features, { matter: true });
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const command = platform.controlDevice('one', { brightness: 20 }, 'matter').then(() => {
    hostBrightness = 20;
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { brightness: 70 } });
  release(); await command;
  await new Promise((resolve) => setImmediate(resolve));
  expect(platform.accessories.values().next().value?.context.device.deviceState.brightness).toBe(70);
  expect(hostBrightness).toBe(70);
});

test('a newer color report protects both HSV brightness and its normalized brightness field', async () => {
  mocks.devices = [{ id: 'one', name: 'Color light', deviceType: 'LightRgbw5',
    deviceState: { power: true, lightMode: 'COLOR', brightness: 50, hsvColor: { hue: 10, saturation: 20, brightness: 50 } } }];
  const { platform } = await fixture();
  let release!: () => void;
  mocks.clients[0]!.controlDevice!.mockImplementationOnce(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const command = platform.controlDevice('one', { hsvColor: { hue: 50, saturation: 60, brightness: 20 } }, 'hap');
  await vi.waitFor(() => expect(release).toBeDefined());
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { hsvColor: { hue: 80, saturation: 40, brightness: 70 } } });
  release(); await command;
  expect(platform.accessories.values().next().value?.context.device.deviceState).toMatchObject({
    hsvColor: { hue: 80, saturation: 40, brightness: 70 }, brightness: 70,
  });
});

test('unknown and deferred device types remain diagnostic-only even when raw power exists', async () => {
  mocks.devices = [
    { id: 'robot', name: 'Unknown robot', deviceType: 'UnknownRobot', deviceState: { power: true } },
    { id: 'camera', name: 'Camera', deviceType: 'HomeCamera', deviceState: { power: true } },
    { id: 'button', name: 'Button', deviceType: 'SmartButton', deviceState: { power: true, battery: 90 } },
    { id: 'air', name: 'IR purifier', deviceType: 'IrAirpurifier', deviceState: { power: true } },
    { id: 'gas', name: 'Gas sensor', deviceType: 'SensorGas2', deviceState: { power: true } },
    { id: 'radar', name: 'Radar', deviceType: 'SensorRadar', deviceState: { motionDetected: true } },
    { id: 'tv', name: 'TV', deviceType: 'IrTv', deviceState: {} },
  ];
  const { platform, dir } = await fixture();
  expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id).sort()).toEqual(['radar', 'tv']);
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.devices).toHaveLength(7);
    for (const id of ['robot', 'camera', 'button', 'air', 'gas']) {
      expect(status?.devices.find((device) => device.id === id)?.homekit).toBe(false);
    }
  });
});


test('successful discovery does not infer removal from a corrupt cache with no device identity', async () => {
  const { platform, internal, api } = await fixture();
  const unidentified = new api.platformAccessory('Unidentified', api.hap.uuid.generate('unidentified'));
  platform.configureAccessory(unidentified);
  await internal.discoverDevices();
  expect(platform.accessories.has(unidentified.UUID)).toBe(true);
  expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
});

test('session files replaced atomically are recovered by the actual watcher without a private poll', async () => {
  vi.useFakeTimers();
  const { store, session, shutdown } = await fixture();
  await store.save({ ...session, accessToken: 'watcher-replacement' });
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
  expect(mocks.realtime[0]!.disconnect).toHaveBeenCalledOnce();
  expect(mocks.clients[0]!.dispose).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.clients).toHaveLength(2);
  shutdown(); await store.save({ ...session, accessToken: 'after-stop' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.clients).toHaveLength(2);
});

test('a changed on-disk session rejects control before the next two-second watcher tick', async () => {
  const { platform, store, session } = await fixture();
  await store.save({ ...session, accessToken: 'different-account' });
  await expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow(/session/i);
  expect(mocks.clients[0]!.controlDevice).not.toHaveBeenCalled();
});

test('failed discovery on a replacement account cannot label old cached devices as new-account diagnostics', async () => {
  const { internal, store, session, dir } = await fixture();
  const oldStatus = await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir); expect(status?.devices).toHaveLength(1); return status!;
  });
  mocks.families.push({ familyId: 2, name: 'Failure' }); mocks.fail = true;
  await store.save({ ...session, accessToken: 'different-account' });
  await internal.checkSessionAndInitialize();
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.ownerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(status?.ownerFingerprint).not.toBe(oldStatus.ownerFingerprint);
    expect(status?.devices).toEqual([]);
  });
});

test('a discovery started before an on-disk account change cannot publish its late inventory', async () => {
  const { platform, internal, store, session } = await fixture();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const pending = internal.discoverDevices();
  await vi.waitFor(() => expect(release).toBeDefined());
  await store.save({ ...session, accessToken: 'different-account' });
  release([device('old-account-only')]); await pending;
  expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id)).toEqual(['one']);
});

test('the public remote button path validates device type and shares a non-optimistic command queue', async () => {
  mocks.devices = [{ id: 'one', name: 'TV', deviceType: 'IrTv', deviceState: {} }];
  const { platform } = await fixture();
  await platform.controlRemoteButton('one', { type: 'volume', direction: 'up' });
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledWith('one', { volume: 'up' });
  expect(platform.accessories.values().next().value?.context.device.deviceState).toEqual({});
  await expect(platform.controlRemoteButton('one', { power: true })).rejects.toThrow();
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledTimes(1);
});

test('diagnostics keep HVAC target settings separate from measured room temperature', async () => {
  mocks.devices = [{ id: 'ac', name: 'AC', deviceType: 'IrAirconditioner',
    deviceState: { power: '켜짐', temperature: 26, mode: '0', fanSpeed: '2' } }];
  const { dir } = await fixture();
  await vi.waitFor(async () => {
    const device = (await loadRuntimeStatus(dir))?.devices[0];
    expect(device?.hvacSettings).toEqual({ power: true, targetTemperature: 26, mode: 'cool', fanSpeed: 'medium' });
    expect(device?.temperatureCelsius).toBeUndefined();
  });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'ac', deviceState: { mode: '1', temperature: 24 } });
  await vi.waitFor(async () => {
    expect((await loadRuntimeStatus(dir))?.devices[0]?.hvacSettings).toMatchObject({ targetTemperature: 24, mode: 'heat' });
  });
});

test('purifier IPC validates exact type and settings without fabricating applied mode after an ACK', async () => {
  mocks.devices = [{ id: 'air', name: 'Air purifier', deviceType: 'Airpurifier', deviceState: { power: true, mode: 'auto' } },
    { id: 'ir', name: 'IR purifier', deviceType: 'IrAirpurifier', deviceState: { power: true } }];
  const { platform, dir } = await fixture();
  await sendRuntimeCommand(dir, { deviceId: 'air', kind: 'purifier', command: { mode: 'manual' } });
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledWith('air', { mode: 'manual' });
  expect(platform.accessories.get(platform.api.hap.uuid.generate('air'))?.context.device.deviceState.mode).toBe('auto');
  await expect(sendRuntimeCommand(dir, { deviceId: 'ir', kind: 'purifier', command: { power: true } })).rejects.toThrow();
  await expect(sendRuntimeCommand(dir, { deviceId: 'air', kind: 'purifier', command: { mode: 'turbo' } })).rejects.toThrow();
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledTimes(1);
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'air', deviceState: { mode: 'sleep' } });
  await vi.waitFor(async () => {
    const status = await loadRuntimeStatus(dir);
    expect(status?.devices.find((device) => device.id === 'air')?.purifierSettings).toEqual({ power: true, mode: 'sleep' });
    expect(status?.devices.find((device) => device.id === 'ir')?.purifierSettings).toBeUndefined();
  });
});

test('configured custom meter source fields become nullable in the actual runtime projection at the selected expiry', async () => {
  mocks.devices = [{ id: 'one', name: 'Meter', deviceType: 'Plug', modelName: 'meter-model', deviceState: { power: true, watts: 10 } }];
  const { platform } = await fixture({ one: { freshnessMinutes: 15 } });
  platform.features.meters.push({ model: 'meter-model', power: { field: 'watts', multiplier: 1 } });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { watts: 10 } });
  const project = () => (platform as unknown as { matterDevice(device: HejDevice): HejDevice })
    .matterDevice(platform.accessories.values().next().value!.context.device);
  vi.useFakeTimers(); const start = Date.now();
  vi.setSystemTime(start + 5 * 60000);
  expect(project().deviceState?.watts).toBe(10);
  vi.setSystemTime(start + 15 * 60000);
  expect(platform.getMeasurementHealth('one', 'watts').reason).toBe('measurement-stale');
  expect(project().deviceState?.watts).toBeNull();
  expect(project().online).toBe(true);
});


test('a new runtime instance restores stored login but never treats cached sensor readings as freshly received', async () => {
  mocks.devices = [{ id: 'one', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20, humidity: 50 } }];
  const { platform, api, shutdown } = await fixture();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { temperature: 22 } });
  expect(platform.getMeasurementHealth('one', 'temperature').reachable).toBe(true);
  const cache = structuredClone(platform.accessories.values().next().value!.context.device);
  await shutdown();
  const restarted = new HejhomePlatform(platform.log, platform.config, api);
  const restored = new api.platformAccessory(cache.name, api.hap.uuid.generate(cache.id));
  restored.context.device = cache; restarted.configureAccessory(restored);
  await (restarted as unknown as { initialize(): Promise<void> }).initialize();
  expect(mocks.clients).toHaveLength(2);
  expect(restarted.getMeasurementHealth('one', 'temperature').reason).toBe('measurement-unknown');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { temperature: 99 } });
  expect(restarted.getMeasurementHealth('one', 'temperature').reason).toBe('measurement-unknown');
  mocks.realtime[1]!.events.onDeviceUpdate({ id: 'one', deviceState: { temperature: 23 } });
  expect(restarted.getMeasurementHealth('one', 'temperature').reachable).toBe(true);
  expect(restored.context.device.deviceState.temperature).toBe(23);
});

test.each(['light', 'outlet'] as const)('legacy Airpurifier role %s cannot replace its native type or calibrated measurement contract', async (role) => {
  expect(supportsDeviceRole('Airpurifier')).toBe(false);
  mocks.devices = [{ id: 'air', name: 'Air purifier', deviceType: 'Airpurifier', deviceState: { power: true, pm25: 5 } }];
  const { platform, dir } = await fixture({ air: { role, pm25Multiplier: 2 } });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'air', deviceState: { pm25: 5 } });
  const accessory = platform.accessories.get(platform.api.hap.uuid.generate('air'))!;
  const projected = (platform as unknown as { matterDevice(device: HejDevice): HejDevice }).matterDevice(accessory.context.device);
  expect(projected.deviceType).toBe('Airpurifier');
  expect(projected.deviceState).toMatchObject({ power: true, pm25: 5 });
  expect(accessory.getService(platform.Service.Switch)).toBeDefined();
  expect(accessory.getService(platform.Service.Lightbulb)).toBeUndefined();
  expect(accessory.getService(platform.Service.Outlet)).toBeUndefined();
  const airQuality = accessory.getService(platform.Service.AirQualitySensor)!;
  expect(airQuality).toBeDefined();
  expect(await airQuality.getCharacteristic(platform.Characteristic.PM2_5Density).handleGetRequest()).toBe(10);
  await sendRuntimeCommand(dir, { deviceId: 'air', kind: 'purifier', command: { mode: 'sleep' } });
  expect(mocks.clients[0]!.controlDevice).toHaveBeenCalledWith('air', { mode: 'sleep' });
});


test('power estimate uses discovery and native reports but never optimistic command ACKs', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', online: true,
    deviceState: { power: true, brightness: 50, lightMode: 'WHITE' } }];
  const { platform, internal } = await fixture({ one: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  const projected = () => internal.powerEstimates?.project(mocks.devices[0]!);
  expect(projected()?.activePower).toBe(10000);
  await platform.controlDevice('one', { power: false }, 'hap');
  expect(projected()?.activePower).toBeNull();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { brightness: 80 } });
  expect(projected()?.activePower).toBeNull();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  expect(projected()?.activePower).toBe(100);
});

test('discovery already in flight at command dispatch cannot resume manual energy estimation', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
  const { platform, internal } = await fixture({ one: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  let resolve!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((done) => {
    resolve = done;
  }));
  const discovery = internal.discoverDevices();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await platform.controlDevice('one', { power: false }, 'matter');
  resolve(mocks.devices); await discovery;
  expect(internal.powerEstimates?.project(mocks.devices[0]!)?.activePower).toBeNull();
  await internal.discoverDevices();
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBe(10000);
});

test('estimation pauses across transport recovery and session loss and resumes only on a native power field', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
  const { internal, store } = await fixture({ one: { powerSpec: { activeWatts: 10 } } });
  const projected = () => internal.powerEstimates?.project(mocks.devices[0]!);
  expect(projected()?.activePower).toBe(10000);
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  expect(projected()?.activePower).toBeNull();
  mocks.realtime[0]!.events.onStatus?.('connect.success');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { brightness: 40 } });
  expect(projected()?.activePower).toBeNull();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
  expect(projected()?.activePower).toBe(10000);
  await store.clear(); await internal.checkSessionAndInitialize();
  expect(projected()?.activePower).toBeNull();
});

test('credential rotation restores the same account energy before new discovery without a downtime interval', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
    const { internal, store, session } = await fixture({ one: { powerSpec: { activeWatts: 10 } } });
    clock.mockReturnValue(3600); internal.refreshHealth();
    expect(internal.powerEstimates?.project(mocks.devices[0]!)?.cumulativeEnergyImported).toBe(10);
    await store.save({ ...session, accessToken: 'rotated' });
    clock.mockReturnValue(99999999); await internal.checkSessionAndInitialize();
    expect(internal.powerEstimates.project(mocks.devices[0]!)?.cumulativeEnergyImported).toBe(10);
    await store.save({ ...session, identifier: 'different-account' });
    await internal.checkSessionAndInitialize();
    expect(internal.powerEstimates.project(mocks.devices[0]!)?.cumulativeEnergyImported).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test('a session mismatch detected by a command immediately pauses estimation before the watcher runs', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
  const { platform, internal, store, session } = await fixture({ one: { powerSpec: { activeWatts: 10 } } });
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBe(10000);
  await store.save({ ...session, accessToken: 'rotated-before-command' });
  await expect(platform.controlDevice('one', { power: false }, 'hap')).rejects.toThrow('session changed');
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBeNull();
});

test('a native power patch received for a newly discovered device outranks the initial REST snapshot', async () => {
  mocks.devices = [];
  const { internal } = await fixture({ lamp: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  const lamp: HejDevice = { id: 'lamp', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } };
  let resolve!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((done) => {
    resolve = done;
  }));
  const discovery = internal.discoverDevices();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { power: false } });
  resolve([lamp]); await discovery;
  expect(internal.powerEstimates.project(lamp)?.activePower).toBe(100);
});

test('optional energy storage failure cannot prevent native discovery or controls and recovers without fabricated totals', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
  const { platform, internal, store, session, dir } = await fixture({ one: { powerSpec: { activeWatts: 10 } } });
  const { estimatedEnergyOwner } = await import('../src/storage/estimatedEnergyStore.js');
  const account = 'unreadable-energy-account';
  const target = path.join(dir, 'hejhome', `estimated-energy-${estimatedEnergyOwner(account)}.json`);
  // A directory where the optional JSON file belongs deterministically causes EISDIR.
  await fs.mkdir(target);
  await store.save({ ...session, identifier: account });
  await internal.checkSessionAndInitialize();
  expect(mocks.clients).toHaveLength(2);
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
  await expect(platform.controlDevice('one', { power: false }, 'hap')).resolves.toBeUndefined();
  expect(internal.powerEstimates.project(mocks.devices[0]!)).toMatchObject({ activePower: null, cumulativeEnergyImported: null });
  await fs.rmdir(target);
  // The ordinary watcher retries only after its minute backoff.
  await internal.checkSessionAndInitialize();
  mocks.realtime[1]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBeNull();
  const wallTime = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
  try {
    await internal.checkSessionAndInitialize();
    mocks.realtime[1]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: true } });
    expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBe(10000);
  } finally {
    wallTime.mockRestore();
  }
});

test('a staged power report for a new device cannot cross a realtime disconnect during discovery', async () => {
  mocks.devices = [];
  const { internal } = await fixture({ lamp: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  const lamp: HejDevice = { id: 'lamp', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } };
  let resolve!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((done) => {
    resolve = done;
  }));
  const discovery = internal.discoverDevices();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { power: false } });
  mocks.realtime[0]!.events.onStatus?.('connect.closed');
  mocks.realtime[0]!.events.onStatus?.('connect.success');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { brightness: 80 } });
  resolve([lamp]); await discovery;
  expect(internal.powerEstimates.project(lamp)?.activePower).toBeNull();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { power: false } });
  expect(internal.powerEstimates.project(lamp)?.activePower).toBe(100);
});


test('a changed account publishes its own stored energy immediately on an existing reachable Matter light', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50,
    lightMode: 'COLOUR', hsvColor: { hue: 120, saturation: 50, brightness: 50 } } }];
  const visible = new Map<string, Record<string, unknown>>();
  const matter = { deviceTypes, status: MatterStatus, uuid: { generate: (value: string) => value },
    registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(),
    updateAccessoryState: vi.fn(async (_uuid, cluster, attributes) => {
      visible.set(cluster, attributes);
    }) } as unknown as MatterAPI;
  const { internal, store, session, dir } = await fixture({ one: { powerSpec: { activeWatts: 10 } } }, { mode: 'all' }, matter);
  expect(visible.get('electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: 0 });
  const { EstimatedEnergyStore } = await import('../src/storage/estimatedEnergyStore.js');
  await new EstimatedEnergyStore(dir).save('different-account', { one: 200 });
  await store.save({ ...session, identifier: 'different-account' });
  await internal.checkSessionAndInitialize();
  expect(visible.get('bridgedDeviceBasicInformation')?.reachable).toBe(true);
  expect(visible.get('electricalEnergyMeasurement')?.cumulativeEnergyImported).toEqual({ energy: 200 });
});


test('REST logging while MQTT connects does not invalidate a fresh startup discovery power report', async () => {
  mocks.connectDuringDiscovery = true;
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } }];
  const { internal } = await fixture({ one: { powerSpec: { activeWatts: 10 } } });
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBe(10000);
});


test('unresolved realtime hints coalesce and never repeatedly scan or starve a new device', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  const emit = (id: string) => mocks.realtime[0]!.events.onDeviceUpdate({ id, deviceState: { power: true } });
  for (let i = 0; i < 1000; i++) {
    emit('outside-scope');
  }
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 12; i++) {
    emit('outside-scope');
    await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  }
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(2);
  mocks.devices.push(device('new'));
  emit('new');
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toContain('new');
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(3);
});

test('unknown-ID floods are globally bounded and still discover the latest new device', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  for (let round = 0; round < 6; round++) {
    for (let id = 0; id < 1200; id++) {
      mocks.realtime[0]!.events.onDeviceUpdate({ id: `noise-${round}-${id}`, deviceState: { power: true } });
    }
    if (round === 5) {
      mocks.devices.push(device('genuine'));
      mocks.realtime[0]!.events.onDeviceUpdate({ id: 'genuine', deviceState: { power: true } });
    }
    await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  }
  expect(mocks.clients[0]!.getFamilies.mock.calls.length).toBeLessThanOrEqual(3);
  await vi.advanceTimersByTimeAsync(30000); await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toContain('genuine');
});

test('realtime hints cannot shorten discovery exponential backoff even when queued during a failing pass', async () => {
  const { internal } = await fixture();
  vi.useFakeTimers();
  mocks.clients[0]!.getFamilies!.mockRejectedValue(new Error('provider offline'));
  await internal.refreshDiscovery();
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning?.catch(() => undefined);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10000); await internal.discoveryRunning?.catch(() => undefined);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(4);
  let reject!: (error: Error) => void;
  mocks.clients[0]!.getFamilies!.mockImplementationOnce(() => new Promise((_resolve, fail) => {
    reject = fail;
  }));
  await vi.advanceTimersByTimeAsync(20000);
  expect(reject).toBeTypeOf('function');
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', deviceState: { power: true } });
  reject(new Error('provider offline')); await internal.discoveryRunning?.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(39999); await internal.discoveryRunning?.catch(() => undefined);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1); await internal.discoveryRunning?.catch(() => undefined);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(6);
});

test('cached but unverified realtime IDs require REST scope verification before control', async () => {
  const { platform, internal, api } = await fixture();
  const cached = new api.platformAccessory('Cached', api.hap.uuid.generate('cached'));
  cached.context.device = device('cached'); platform.configureAccessory(cached);
  vi.useFakeTimers();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'cached', deviceState: { power: false } });
  expect(platform.getDeviceHealth('cached').reachable).toBe(false);
  await expect(platform.controlDevice('cached', { power: true }, 'hap')).rejects.toThrow('no longer available');
  mocks.devices.push(device('cached'));
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect(platform.accessories.get(cached.UUID)).toBe(cached);
  await expect(platform.controlDevice('cached', { power: true }, 'hap')).resolves.toBeUndefined();
});

test('unknown realtime metadata cannot override REST identity or bypass configured publication preferences', async () => {
  const matter = { deviceTypes, status: MatterStatus, uuid: { generate: (value: string) => value },
    registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(),
    updateAccessoryState: vi.fn(async () => undefined) } as unknown as MatterAPI;
  const { platform, internal, api } = await fixture({ new: { name: 'Preferred name' }, hidden: { visibility: 'hidden' },
    hap: { visibility: 'homekit' }, matter: { visibility: 'matter' } }, { mode: 'all' }, matter);
  vi.useFakeTimers();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000);
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', name: 'Unverified', deviceType: 'UnknownRobot', modelName: 'unverified',
    deviceState: { power: false } });
  release([device('one'), { ...device('new'), modelName: 'confirmed' }, device('hidden'), device('hap'), device('matter')]);
  await internal.discoveryRunning;
  const added = platform.accessories.get(api.hap.uuid.generate('new'))!;
  expect(added).toBeDefined();
  expect(added.context.device).toMatchObject({ name: 'Preferred name', deviceType: 'ZigbeeSwitch1', modelName: 'confirmed' });
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id).sort()).toEqual(['hap', 'new', 'one']);
  const published = vi.mocked(matter.registerPlatformAccessories).mock.calls.flatMap((call) => call[2].map((entry) => entry.UUID));
  expect(published.sort()).toEqual(['hejhome:matter:matter', 'hejhome:matter:new', 'hejhome:matter:one']);
  await vi.advanceTimersByTimeAsync(60000); await internal.discoveryRunning;
  expect(vi.mocked(api.registerPlatformAccessories).mock.calls.flatMap((call) => call[2]).filter((entry) => entry.UUID === added.UUID)).toHaveLength(1);
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(2);
});

test('a slow discovery does not revive an old unverified power patch when another field updates later', async () => {
  mocks.devices = [];
  const { platform, internal } = await fixture({ lamp: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  vi.useFakeTimers();
  const lamp: HejDevice = { id: 'lamp', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power: true, brightness: 50 } };
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const discovery = internal.refreshDiscovery();
  await Promise.resolve();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { power: false } });
  await vi.advanceTimersByTimeAsync(6000);
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'lamp', deviceState: { brightness: 80 } });
  release([lamp]); await discovery;
  expect(internal.powerEstimates.project(lamp)?.activePower).toBe(10000);
  expect(platform.accessories.get(platform.api.hap.uuid.generate('lamp'))?.context.device.deviceState.power).toBe(true);
});

test('hint discovery honors family and room scope and leaves unsupported models diagnostic-only', async () => {
  const { platform, internal } = await fixture(undefined,
    { mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [11] } });
  vi.useFakeTimers();
  mocks.families.push({ familyId: 2, name: 'Outside family' });
  mocks.clients[0]!.getDevices!.mockImplementation(async (family: number, room: number) => family === 1 && room === 11
    ? [device('one'), { ...device('unsupported'), deviceType: 'UnknownRobot' }]
    : [device('outside')]);
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'outside', deviceType: 'ZigbeeSwitch1', deviceState: { power: true } });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'unsupported', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toEqual(['one']);
  expect(mocks.clients[0]!.getDevices!.mock.calls).toEqual([[1, 11], [1, 11]]);
  expect(platform.getDeviceHealth('unsupported').reachable).toBe(true);
  expect(platform.getDeviceHealth('outside').reachable).toBe(false);
});

test('hint discovery never applies a partial inventory to either HAP or Matter', async () => {
  const matter = { deviceTypes, status: MatterStatus, uuid: { generate: (value: string) => value },
    registerPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn(), unregisterPlatformAccessories: vi.fn(),
    updateAccessoryState: vi.fn(async () => undefined) } as unknown as MatterAPI;
  const { platform, internal, api } = await fixture(undefined, { mode: 'all' }, matter);
  vi.useFakeTimers();
  mocks.families.push({ familyId: 2, name: 'Unavailable family' });
  mocks.devices = [device('new')]; mocks.fail = true;
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'new', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning?.catch(() => undefined);
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toEqual(['one']);
  expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
  expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  mocks.fail = false;
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toEqual(['new']);
  expect(matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
});

test('a session switch clears both pending hints and prior-account suppression', async () => {
  const { internal, store, session, platform } = await fixture();
  vi.useFakeTimers();
  const emit = (id: string) => mocks.realtime.at(-1)!.events.onDeviceUpdate({ id, deviceState: { power: true } });
  emit('not-yet-visible');
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  emit('old-pending');
  await store.save({ ...session, identifier: 'other-account', accessToken: 'other-token' });
  await internal.checkSessionAndInitialize();
  await vi.advanceTimersByTimeAsync(35000); await internal.discoveryRunning;
  expect(mocks.clients[1]!.getFamilies).toHaveBeenCalledTimes(1);
  mocks.devices.push(device('not-yet-visible')); emit('not-yet-visible');
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  expect(mocks.clients[1]!.getFamilies).toHaveBeenCalledTimes(2);
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toContain('not-yet-visible');
});

test.each(['logout', 'shutdown'])('%s cancels queued unknown-device discovery', async (action) => {
  const { internal, store, shutdown } = await fixture();
  vi.useFakeTimers();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'pending', deviceState: { power: true } });
  if (action === 'logout') {
    await store.clear(); await internal.checkSessionAndInitialize();
  } else {
    await shutdown();
  }
  await vi.advanceTimersByTimeAsync(60000); await internal.discoveryRunning;
  expect(mocks.clients[0]!.getFamilies).toHaveBeenCalledTimes(1);
});

test('periodic inventory discovers a previously suppressed ID even without another realtime event', async () => {
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'eventual', deviceState: { power: true } });
  await vi.advanceTimersByTimeAsync(5000); await internal.discoveryRunning;
  mocks.devices.push(device('eventual'));
  vi.setSystemTime(Date.now() + 300001);
  await internal.checkSessionAndInitialize();
  await vi.advanceTimersByTimeAsync(1); await internal.discoveryRunning;
  expect([...platform.accessories.values()].map((entry) => entry.context.device.id)).toContain('eventual');
});

test('buffered unknown measurements stay unavailable until a verified realtime report arrives', async () => {
  mocks.devices = [];
  const { platform, internal } = await fixture();
  vi.useFakeTimers();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const discovery = internal.refreshDiscovery(); await Promise.resolve();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'sensor', deviceState: { temperature: 25 } });
  release([{ id: 'sensor', name: 'Sensor', deviceType: 'SensorTh', deviceState: { temperature: 22 } }]); await discovery;
  expect(platform.getMeasurementHealth('sensor', 'temperature')).toEqual({ reachable: false, reason: 'measurement-unknown' });
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'sensor', deviceState: { temperature: 26 } });
  expect(platform.getMeasurementHealth('sensor', 'temperature').reachable).toBe(true);
});

test('unknown realtime floods cannot evict a verified power report from an active discovery', async () => {
  mocks.devices = [{ id: 'one', name: 'Lamp', deviceType: 'LightRgbw5', online: true,
    deviceState: { power: true, brightness: 50 } }];
  const { platform, internal } = await fixture({ one: { powerSpec: { activeWatts: 10, standbyWatts: 0.1 } } });
  vi.useFakeTimers();
  let release!: (devices: HejDevice[]) => void;
  mocks.clients[0]!.getDevices!.mockImplementationOnce(() => new Promise<HejDevice[]>((resolve) => {
    release = resolve;
  }));
  const discovery = internal.refreshDiscovery(); await Promise.resolve();
  mocks.realtime[0]!.events.onDeviceUpdate({ id: 'one', deviceState: { power: false } });
  for (let index = 0; index < 1024; index++) {
    mocks.realtime[0]!.events.onDeviceUpdate({ id: `noise-${index}`, deviceState: { power: true } });
  }
  const staged = (platform as unknown as { discoveryPatches: Map<string, unknown> }).discoveryPatches;
  expect(staged.size).toBeLessThanOrEqual(257);
  expect(staged.has('noise-1023')).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  release(mocks.devices); await discovery;
  expect(internal.powerEstimates.project(mocks.devices[0]!)?.activePower).toBe(100);
  const accessory = platform.accessories.get(platform.api.hap.uuid.generate('one'))!;
  expect(accessory.context.device.deviceState.power).toBe(false);
  expect(await accessory.getService(platform.Service.Lightbulb)!.getCharacteristic(platform.Characteristic.On).handleGetRequest()).toBe(false);
});
