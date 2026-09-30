import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { API, Logging } from 'homebridge';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import type { HejDevice, HejSession } from '../src/types.js';
import type { HejRestLogEvent } from '../src/hej/rest.js';
import { sendRuntimeCommand } from '../src/runtime/commands.js';
import { loadRuntimeStatus } from '../src/runtime/status.js';
import type { HejRealtimeEvents } from '../src/hej/realtime.js';

const mocks = vi.hoisted(() => ({ clients: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  realtime: [] as Array<{ events: HejRealtimeEvents; disconnect: ReturnType<typeof vi.fn> }>,
  loggers: [] as Array<(event: HejRestLogEvent) => void>,
  families: [{ familyId: 1, name: 'Home' }], devices: [] as HejDevice[], fail: false }));
vi.mock('../src/hej/rest.js', () => ({ HejRestClient: class {
  getFamilies = vi.fn(async () => mocks.families);
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
vi.mock('../src/hej/realtime.js', () => ({ HejRealtimeClient: class {
  disconnect = vi.fn(); connect = vi.fn(() => this.events.onStatus?.('connect.success'));
  constructor(public session: HejSession, public events: HejRealtimeEvents) {
    mocks.realtime.push(this);
  }
} }));
import { HejhomePlatform } from '../src/platform.js';
import { SessionStore } from '../src/storage/sessionStore.js';

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  mocks.clients.length = 0; mocks.loggers.length = 0; mocks.realtime.length = 0; mocks.fail = false;
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
async function fixture(preferences?: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join('/tmp', 'hej-runtime-'));
  const store = new SessionStore(dir);
  const session: HejSession = { identifier: 'private', accessToken: 'secret-one', jsessionId: 'cookie',
    usernameCookie: 'user', autoLogin: true, expiresAt: Date.now() + 3600000 };
  await store.save(session);
  const host = new HomebridgeAPI(); const listeners = new Map<string, () => void>();
  const api = { hap: host.hap, platformAccessory: host.platformAccessory, user: { storagePath: () => dir },
    on: (e: string, fn: () => void) => listeners.set(e, fn), registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(), updatePlatformAccessories: vi.fn() } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;
  const platform = new HejhomePlatform(log, { platform: 'Hejhome', scope: { mode: 'all' },
    features: preferences ? { devices: preferences } : {} } as never, api);
  const internal = platform as unknown as { initialize(): Promise<void>; discoverDevices(): Promise<void>;
    discoveryRunning: Promise<void> | null; checkSessionAndInitialize(): Promise<void> };
  cleanup.push(async () => {
    listeners.get('shutdown')?.(); vi.useRealTimers(); await new Promise((r) => setTimeout(r, 40)); await fs.rm(dir, { recursive: true, force: true });
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
  expect([...platform.accessories.values()].map((accessory) => accessory.context.device.id)).toContain('new');
  await internal.discoveryRunning;
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
  expect(platform.getDeviceHealth('one').reachable).toBe(true);
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
    { id: 'air', name: 'Air purifier', deviceType: 'Airpurifier', deviceState: { power: true } },
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
