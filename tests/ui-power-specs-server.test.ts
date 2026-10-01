import fs from 'node:fs/promises';
import { unwatchFile } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SessionStore, sessionFingerprint } from '../src/storage/sessionStore.js';

type Diagnostics = { uiSessionRevision: string; deviceListAvailable: boolean;
  devices: { id: string; preference: { powerSpec?: { activeWatts?: number; standbyWatts?: number } }; meterProfileApplied: boolean }[] };
const bridge = vi.hoisted(() => ({ storage: '', config: '', instance: null as unknown,
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>() }));
vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {
    requestError: unknown;
    constructor(message: string, detail: unknown) {
      super(message); this.requestError = detail;
    }
  },
  HomebridgePluginUiServer: class {
    homebridgeStoragePath = bridge.storage;
    homebridgeConfigPath = bridge.config;
    constructor() {
      bridge.instance = this;
    }
    onRequest(name: string, fn: (payload: unknown) => Promise<unknown>) {
      bridge.handlers.set(name, fn);
    }
    pushEvent() {}
    ready() {}
  },
}));
vi.mock('../dist/storage/logStore.js', () => ({ LogStore: class {
  async append() {}
} }));

let directory: string;
let exitListeners: Set<(...args: unknown[]) => void>;
let revision: string;
const session = (identifier: string) => ({ identifier, accessToken: `token-${identifier}`, jsessionId: `sid-${identifier}`,
  usernameCookie: `cookie-${identifier}`, expiresAt: 2_000_000_000_000, autoLogin: true as const });
const ownerSession = session('a@example.test');
const baseConfig = () => ({ bridge: { name: 'Main' }, platforms: [{ platform: 'Other', arbitrary: true }, {
  platform: 'Hejhome', name: 'Hejhome', auth: { sessionConfigured: true }, scope: { mode: 'first-family' },
  _bridge: { username: 'AA:BB:CC:DD:EE:FF' }, features: { matter: true, adaptiveLighting: true,
    meters: [{ model: 'Same model', power: { field: 'curPower', multiplier: 0.1 } }], devices: {
      first: { name: 'First alias', role: 'outlet' }, second: { visibility: 'homekit' },
      unseen: { name: 'Unseen' },
    } },
} ] });
const row = (deviceId: string, activeWatts: number | null = 20, standbyWatts: number | null = null,
  expected = { activeWatts: null as number | null, standbyWatts: null as number | null }) =>
  ({ deviceId, activeWatts, standbyWatts, expected });
const read = async () => JSON.parse(await fs.readFile(bridge.config, 'utf8'));
const save = (updates: unknown[], uiSessionRevision = revision) => {
  const handler = bridge.handlers.get('/save-power-specs');
  expect(handler, 'manual power specifications must have a save endpoint').toBeDefined();
  return handler!({ uiSessionRevision, updates });
};

beforeEach(async () => {
  exitListeners = new Set(process.rawListeners('exit'));
  vi.resetModules();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-power-specs-'));
  bridge.storage = directory;
  bridge.config = path.join(directory, 'config.json');
  bridge.handlers.clear();
  await new SessionStore(directory).save(ownerSession);
  await fs.writeFile(bridge.config, JSON.stringify(baseConfig()));
  await fs.writeFile(path.join(directory, 'hejhome', 'devices-snapshot.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), ownerFingerprint: sessionFingerprint(ownerSession),
    discoveryScope: { mode: 'first-family' }, families: [
      { family: { familyId: 1, name: 'First' }, devices: [
        { id: 'first', name: 'First', deviceType: 'Plug', modelName: 'Same model', roomId: 12 },
        { id: 'second', name: 'Second', deviceType: 'Plug', modelName: 'Same model', roomId: 13 },
      ] },
    ],
  }));
  await import('../homebridge-ui/server.js');
  // Ask diagnostics for the same account revision consumed by the UI.
  revision = (await bridge.handlers.get('/diagnostics')!({}) as Diagnostics).uiSessionRevision;
});

afterEach(async () => {
  for (const listener of process.rawListeners('exit')) {
    if (!exitListeners.has(listener)) {
      process.removeListener('exit', listener);
    }
  }
  unwatchFile(path.join(directory, 'hejhome', 'runtime-status.json'));
  unwatchFile(path.join(directory, 'hejhome', 'session.json'));
  await fs.rm(directory, { recursive: true, force: true });
});

test('saves and retrieves independent specs for two devices with the same model while preserving other configuration', async () => {
  const initial = baseConfig();
  Object.assign(initial.platforms[1].features!.devices.unseen, { powerSpec: { activeWatts: 19 } });
  await fs.writeFile(bridge.config, JSON.stringify(initial));
  const response = await save([row('first', 0, 0.125), row('second', 45.5)]);
  expect(response).toEqual({ ok: true, uiSessionRevision: revision, powerSpecs: [
    { deviceId: 'first', activeWatts: 0, standbyWatts: 0.125 },
    { deviceId: 'second', activeWatts: 45.5, standbyWatts: null },
  ] });
  const expected = baseConfig();
  Object.assign(expected.platforms[1].features!.devices.unseen, { powerSpec: { activeWatts: 19 } });
  Object.assign(expected.platforms[1].features!.devices.first, { powerSpec: { activeWatts: 0, standbyWatts: 0.125 } });
  Object.assign(expected.platforms[1].features!.devices.second, { powerSpec: { activeWatts: 45.5 } });
  expect(await read()).toEqual(expected);
  const diagnostics = await bridge.handlers.get('/diagnostics')!({}) as Diagnostics;
  expect(diagnostics.deviceListAvailable).toBe(true);
  expect(diagnostics.devices.find((item) => item.id === 'first')!.preference.powerSpec)
    .toEqual({ activeWatts: 0, standbyWatts: 0.125 });
  expect(diagnostics.devices.find((item) => item.id === 'first')!.meterProfileApplied).toBe(true);
});

test('null clears one field or only powerSpec, preserving zero and other preferences', async () => {
  await save([row('first', 20, 1)]);
  await save([row('first', null, 0, { activeWatts: 20, standbyWatts: 1 })]);
  expect((await read()).platforms[1].features.devices.first).toEqual({ name: 'First alias', role: 'outlet', powerSpec: { standbyWatts: 0 } });
  await save([row('first', null, null, { activeWatts: null, standbyWatts: 0 })]);
  expect((await read()).platforms[1].features.devices.first).toEqual({ name: 'First alias', role: 'outlet' });
  const config = await read();
  delete config.platforms[1].features.devices.second;
  await fs.writeFile(bridge.config, JSON.stringify(config));
  await save([row('second', 3)]);
  await save([row('second', null, null, { activeWatts: 3, standbyWatts: null })]);
  expect((await read()).platforms[1].features.devices).not.toHaveProperty('second');
});

test.each([-1, NaN, Infinity, -Infinity, '20', '', true, {}, []])('rejects invalid numeric values atomically: %j', async (value) => {
  const before = await fs.readFile(bridge.config, 'utf8');
  for (const field of ['activeWatts', 'standbyWatts']) {
    await expect(save([row('first'), { ...row('second'), [field]: value }])).rejects.toThrow();
  }
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('rejects unknown keys, missing fields, invalid expected values, and duplicate, unknown or out-of-scope IDs atomically', async () => {
  const before = await fs.readFile(bridge.config, 'utf8');
  const invalid = [
    { ...row('second'), arbitrary: 1 }, { ...row('second'), expected: { activeWatts: null, standbyWatts: null, voltage: 0 } },
    { deviceId: 'second', activeWatts: 3, expected: { activeWatts: null, standbyWatts: null } },
    { ...row('second'), expected: { activeWatts: '0', standbyWatts: null } },
    row('first'), row('unknown'), row('out-of-scope'), { ...row('second'), deviceId: 123 },
  ];
  for (const bad of invalid) {
    await expect(save([row('first'), bad])).rejects.toThrow();
  }
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('rejects stale base values without overwriting a prior save and allows retry using the fresh base', async () => {
  await save([row('first', 10)]);
  const before = await fs.readFile(bridge.config, 'utf8');
  await expect(save([row('second', 9), row('first', 20)])).rejects.toMatchObject({ requestError: { code: 'power-specs-conflict' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  await save([row('first', 20, null, { activeWatts: 10, standbyWatts: null })]);
  expect((await read()).platforms[1].features.devices.first.powerSpec).toEqual({ activeWatts: 20 });
});

test('generic preference and feature saves preserve powerSpec but cannot write it through their routes', async () => {
  await save([row('first', 0, 0.2)]);
  const savePreference = bridge.handlers.get('/save-device-settings')!;
  await savePreference({ deviceId: 'first', preference: { name: 'Renamed', visibility: 'matter' } });
  expect((await read()).platforms[1].features.devices.first).toEqual({ name: 'Renamed', visibility: 'matter',
    powerSpec: { activeWatts: 0, standbyWatts: 0.2 } });
  await savePreference({ deviceId: 'first', preference: {} });
  expect((await read()).platforms[1].features.devices.first).toEqual({ powerSpec: { activeWatts: 0, standbyWatts: 0.2 } });
  const before = await fs.readFile(bridge.config, 'utf8');
  await expect(savePreference({ deviceId: 'first', preference: { powerSpec: { activeWatts: 500 } } })).rejects.toThrow();
  await expect(bridge.handlers.get('/save-features')!({ features: { devices: { first: { powerSpec: { activeWatts: 500 } } } } })).rejects.toThrow();
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  await bridge.handlers.get('/save-features')!({ features: { adaptiveLighting: false } });
  expect((await read()).platforms[1].features.devices.first.powerSpec).toEqual({ activeWatts: 0, standbyWatts: 0.2 });
});

test('requires the current account revision and a snapshot owned by the current login', async () => {
  const before = await fs.readFile(bridge.config, 'utf8');
  for (const stale of ['', 'stale']) {
    await expect(save([row('first')], stale)).rejects.toThrow();
  }
  await expect(bridge.handlers.get('/save-power-specs')!({ updates: [row('first')] })).rejects.toThrow();
  await new SessionStore(directory).save(session('b@example.test'));
  await expect(save([row('first')])).rejects.toThrow();
  const diagnostics = await bridge.handlers.get('/diagnostics')!({}) as Diagnostics;
  expect(diagnostics.deviceListAvailable).toBe(false);
  expect(diagnostics.devices).toEqual([]);
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('serialized saves preserve different rows and reject two writes with the same stale base', async () => {
  const differentRows = await Promise.allSettled([save([row('first', 10)]), save([row('second', 40)])]);
  expect(differentRows.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((await read()).platforms[1].features.devices).toMatchObject({
    first: { powerSpec: { activeWatts: 10 } }, second: { powerSpec: { activeWatts: 40 } },
  });
  const sameRow = await Promise.allSettled([
    save([row('first', 20, null, { activeWatts: 10, standbyWatts: null })]),
    save([row('first', 30, null, { activeWatts: 10, standbyWatts: null })]),
  ]);
  expect(sameRow.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(sameRow.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect([20, 30]).toContain((await read()).platforms[1].features.devices.first.powerSpec.activeWatts);
  expect((await read()).platforms[1].features.devices.second.powerSpec).toEqual({ activeWatts: 40 });
});

test('latest room scope and device registration are checked when the queued save begins', async () => {
  const config = await read();
  config.platforms[1].scope = { mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [12] } };
  await fs.writeFile(bridge.config, JSON.stringify(config));
  const before = await fs.readFile(bridge.config, 'utf8');
  await expect(save([row('first'), row('second')])).rejects.toThrow();
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  const snapshotPath = path.join(directory, 'hejhome', 'devices-snapshot.json');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  snapshot.families[0].devices = [];
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  await expect(save([row('first')])).rejects.toThrow();
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test.each(['owner', 'scope', 'other-config', 'device'])('rejects %s change before atomic rename and retains the latest file', async (change) => {
  const before = await fs.readFile(bridge.config, 'utf8');
  let expectedConfig = before;
  const write = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    await write(file, data, options);
    if (String(file).includes('config.json.hejhome')) {
      if (change === 'owner') {
        await new SessionStore(directory).save(session('b@example.test'));
      }
      if (change === 'scope' || change === 'other-config') {
        const config = JSON.parse(before);
        if (change === 'scope') {
          config.platforms[1].scope = { mode: 'custom', includedFamilyIds: [] };
        } else {
          config.bridge.name = 'External edit';
        }
        expectedConfig = JSON.stringify(config);
        await write(bridge.config, expectedConfig);
      }
      if (change === 'device') {
        const snapshotPath = path.join(directory, 'hejhome', 'devices-snapshot.json');
        const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
        snapshot.families[0].devices = [];
        await write(snapshotPath, JSON.stringify(snapshot));
      }
    }
  });
  await expect(save([row('first')])).rejects.toThrow();
  spy.mockRestore();
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(expectedConfig);
  expect((await fs.readdir(directory)).filter((name) => name.includes('.hejhome'))).toEqual([]);
});

test('a filtered second-family snapshot cannot authorize first-family power specs after scope changes', async () => {
  const snapshotPath = path.join(directory, 'hejhome', 'devices-snapshot.json');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  snapshot.discoveryScope = { mode: 'custom', includedFamilyIds: [2] };
  snapshot.families = [{ family: { familyId: 2, name: 'Second' }, devices: [
    { id: 'second-family-device', name: 'Second family device', deviceType: 'Plug', roomId: 21 },
  ] }];
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  const before = await fs.readFile(bridge.config, 'utf8');
  const diagnostics = await bridge.handlers.get('/diagnostics')!({}) as Diagnostics;
  expect(diagnostics.deviceListAvailable).toBe(false);
  await expect(save([row('second-family-device', 7)])).rejects.toMatchObject({ requestError: { code: 'power-specs-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);

  const config = await read();
  config.platforms[1].scope = { mode: 'custom', includedFamilyIds: [2] };
  await fs.writeFile(bridge.config, JSON.stringify(config));
  expect((await bridge.handlers.get('/diagnostics')!({}) as Diagnostics).deviceListAvailable).toBe(true);
  await save([row('second-family-device', 7)]);
  expect((await read()).platforms[1].features.devices['second-family-device'].powerSpec).toEqual({ activeWatts: 7 });
});

test('a legacy snapshot without scope provenance cannot authorize manual specifications', async () => {
  const snapshotPath = path.join(directory, 'hejhome', 'devices-snapshot.json');
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  delete snapshot.discoveryScope;
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  const before = await fs.readFile(bridge.config, 'utf8');
  expect((await bridge.handlers.get('/diagnostics')!({}) as Diagnostics).deviceListAvailable).toBe(false);
  await expect(save([row('first')])).rejects.toMatchObject({ requestError: { code: 'power-specs-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('account replacement during the final config read is checked before atomic rename', async () => {
  const before = await fs.readFile(bridge.config, 'utf8');
  const instance = bridge.instance as { loadHomebridgeConfig(): Promise<unknown> };
  const load = instance.loadHomebridgeConfig.bind(instance);
  let reads = 0;
  const spy = vi.spyOn(instance, 'loadHomebridgeConfig').mockImplementation(async () => {
    const config = await load();
    reads += 1;
    if (reads === 3) {
      await new SessionStore(directory).save(session('b@example.test'));
    }
    return config;
  });
  await expect(save([row('first', 7)])).rejects.toMatchObject({ requestError: { code: 'power-specs-stale' } });
  spy.mockRestore();
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  expect((await fs.readdir(directory)).filter((name) => name.includes('.hejhome'))).toEqual([]);
});
