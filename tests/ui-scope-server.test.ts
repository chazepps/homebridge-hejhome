import fs from 'node:fs/promises';
import { unwatchFile } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SessionStore, sessionFingerprint } from '../src/storage/sessionStore.js';

const bridge = vi.hoisted(() => ({ storage: '', config: '', instance: null as unknown,
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>() }));
const vendor = vi.hoisted(() => ({ failFamilies: false, failRooms: new Set<number>() }));
vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {
    requestError: unknown;
    constructor(message: string, detail: unknown) {
      super(message);
      this.requestError = detail;
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
vi.mock('../dist/hej/rest.js', () => ({
  HejRestClient: class {
    async getFamilies() {
      if (vendor.failFamilies) {
        throw new Error('network unavailable');
      }
      return [{ familyId: 1, name: 'First' }, { familyId: 2, name: 'Second' }];
    }
    async getRooms(familyId: number) {
      if (vendor.failRooms.has(familyId)) {
        throw new Error('room request timed out');
      }
      return familyId === 1 ? [{ room_id: 12, name: 'Private room' }, { room_id: 13, name: 'Other room' }]
        : [{ room_id: 21, name: 'Second room' }];
    }
    dispose() {}
  },
}));
vi.mock('../dist/hej/auth.js', () => ({
  HejAuthClient: class {
    async sendVerificationCode() {}
    async verifyCode() {}
    async loginWithPassword(request: { identifier: string }) {
      return { identifier: request.identifier, autoLogin: true, accessToken: `renewed-${request.identifier}`,
        jsessionId: `renewed-sid-${request.identifier}`, usernameCookie: `cookie-${request.identifier}`,
        expiresAt: Date.now() + 3_600_000 };
    }
  },
}));

let directory: string;
let exitListenersBefore: Set<(...args: unknown[]) => void>;
const scope = () => bridge.handlers.get('/save-scope')!;
const status = () => bridge.handlers.get('/session-status')!({}) as Promise<{ scopeEditToken: string | null;
  scopeOptions?: { complete: boolean }; sessionCheckStatus: string }>;
const session = (identifier: string) => ({ identifier, accessToken: `token-${identifier}`,
  jsessionId: `sid-${identifier}`, usernameCookie: `cookie-${identifier}`,
  expiresAt: Date.now() + 3_600_000, autoLogin: true as const });

beforeEach(async () => {
  exitListenersBefore = new Set(process.rawListeners('exit'));
  vi.resetModules();
  vendor.failFamilies = false;
  vendor.failRooms.clear();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-scope-'));
  bridge.storage = directory;
  bridge.config = path.join(directory, 'config.json');
  bridge.handlers.clear();
  const owner = session('account-a@example.test');
  await new SessionStore(directory).save(owner);
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome', name: 'Hejhome',
    scope: { mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [12] } } }] }));
  await fs.writeFile(path.join(directory, 'hejhome', 'devices-snapshot.json'), JSON.stringify({
    ownerFingerprint: sessionFingerprint(owner), generatedAt: new Date().toISOString(), families: [
      { family: { familyId: 1, name: 'First' }, devices: [] },
    ],
  }));
  await import('../homebridge-ui/server.js');
});

afterEach(async () => {
  for (const listener of process.rawListeners('exit')) {
    if (!exitListenersBefore.has(listener)) {
      process.removeListener('exit', listener);
    }
  }
  unwatchFile(path.join(directory, 'hejhome', 'runtime-status.json'));
  unwatchFile(path.join(directory, 'hejhome', 'session.json'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.rm(directory, { recursive: true, force: true });
});

test('partial or absent home/room lookup cannot overwrite a saved scope', async () => {
  const before = await fs.readFile(bridge.config, 'utf8');
  vendor.failRooms.add(2);
  const partial = await status();
  expect(partial.scopeOptions?.complete).toBe(false);
  expect(partial.scopeEditToken).toBeNull();
  await expect(scope()({ scope: { mode: 'all' }, scopeEditToken: partial.scopeEditToken }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-unavailable' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  vendor.failRooms.clear();
  vendor.failFamilies = true;
  const absent = await status();
  expect(absent.sessionCheckStatus).toBe('error');
  expect(absent.scopeEditToken).toBeNull();
  await expect(scope()({ scope: { mode: 'custom', includedFamilyIds: [] } }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-unavailable' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('complete current-owner scope token validates IDs and rotates after a successful save', async () => {
  const view = await status();
  expect(view.scopeOptions?.complete).toBe(true);
  expect(view.scopeEditToken).toMatch(/^[a-f0-9-]{36}$/);
  const token = view.scopeEditToken;
  const before = await fs.readFile(bridge.config, 'utf8');
  await expect(scope()({ scope: { mode: 'custom', includedFamilyIds: [999] }, scopeEditToken: token }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  await expect(scope()({ scope: { mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [999] } },
    scopeEditToken: token })).rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  const saved = await scope()({ scope: { mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [13] } },
    scopeEditToken: token }) as { scopeEditToken: string; scope: unknown };
  expect(saved.scopeEditToken).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved.scopeEditToken).not.toBe(token);
  expect(saved.scope).toEqual({ mode: 'custom', includedFamilyIds: [1], includedRoomsByFamilyId: { '1': [13] } });
  await expect(scope()({ scope: { mode: 'all' }, scopeEditToken: token }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(JSON.parse(await fs.readFile(bridge.config, 'utf8')).platforms[0].scope).toEqual(saved.scope);
});

test('account replacement and external scope change reject old edit tokens', async () => {
  const view = await status();
  const before = await fs.readFile(bridge.config, 'utf8');
  const accountB = session('account-b@example.test');
  await new SessionStore(directory).save(accountB);
  await fs.writeFile(path.join(directory, 'hejhome', 'devices-snapshot.json'), JSON.stringify({
    ownerFingerprint: sessionFingerprint(accountB), generatedAt: new Date().toISOString(), families: [
      { family: { familyId: 77, name: 'Private B home' }, devices: [{ id: 'private-b-device', name: 'Private B device' }] },
    ],
  }));
  let rejected: unknown;
  try {
    await scope()({ scope: { mode: 'all' }, scopeEditToken: view.scopeEditToken });
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(JSON.stringify(rejected)).not.toContain('private-b-device');
  expect(JSON.stringify(rejected)).not.toContain('Private B home');
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  await new SessionStore(directory).save(session('account-a@example.test'));
  const accountA = (await new SessionStore(directory).load())!;
  await fs.writeFile(path.join(directory, 'hejhome', 'devices-snapshot.json'), JSON.stringify({
    ownerFingerprint: sessionFingerprint(accountA), generatedAt: new Date().toISOString(), families: [
      { family: { familyId: 1, name: 'First' }, devices: [] },
    ],
  }));
  const next = await status();
  const config = JSON.parse(await fs.readFile(bridge.config, 'utf8'));
  config.platforms[0].scope = { mode: 'first-family' };
  await fs.writeFile(bridge.config, JSON.stringify(config));
  const changed = await fs.readFile(bridge.config, 'utf8');
  await expect(scope()({ scope: { mode: 'all' }, scopeEditToken: next.scopeEditToken }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(changed);
});

test('a partial refresh invalidates an earlier complete scope token without erasing the saved scope', async () => {
  const complete = await status();
  const before = await fs.readFile(bridge.config, 'utf8');
  vendor.failRooms.add(2);
  const partial = await status();
  expect(partial.scopeOptions?.complete).toBe(false);
  expect(partial.scopeEditToken).toBeNull();
  await expect(scope()({ scope: { mode: 'all' }, scopeEditToken: complete.scopeEditToken }))
    .rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('a queued scope save rechecks owner while unrelated feature saves keep its scope revision valid', async () => {
  const view = await status();
  const features = bridge.handlers.get('/save-features')!;
  await features({ features: { matter: true } });
  const valid = await scope()({ scope: { mode: 'first-family' }, scopeEditToken: view.scopeEditToken }) as { scopeEditToken: string };
  expect(valid.scopeEditToken).not.toBe(view.scopeEditToken);
  const next = await status();
  const server = bridge.instance as { configWrites: Promise<void> };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.configWrites = blocked;
  const before = await fs.readFile(bridge.config, 'utf8');
  const pending = scope()({ scope: { mode: 'all' }, scopeEditToken: next.scopeEditToken });
  await vi.waitFor(() => expect(server.configWrites).not.toBe(blocked));
  await new SessionStore(directory).save(session('account-b@example.test'));
  release();
  await expect(pending).rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
  expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
});

test('an account change during scope config write rejects before the atomic rename', async () => {
  const view = await status();
  const before = await fs.readFile(bridge.config, 'utf8');
  const originalWrite = fs.writeFile.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    if (String(file) === `${bridge.config}.hejhome.tmp`) {
      entered();
      await blocked;
    }
    return originalWrite(file, data, options);
  });
  try {
    const pending = scope()({ scope: { mode: 'all' }, scopeEditToken: view.scopeEditToken });
    await writing;
    await new SessionStore(directory).save(session('account-b@example.test'));
    release();
    await expect(pending).rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
    expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  } finally {
    release();
    spy.mockRestore();
  }
});

test('scope edit tokens are absent from UI logs and anonymous diagnostics', async () => {
  const view = await status() as { scopeEditToken: string; uiSessionRevision: string };
  await scope()({ scope: { mode: 'first-family' }, scopeEditToken: view.scopeEditToken });
  await bridge.handlers.get('/ui-event')!({ event: 'scope.edit', scopeEditToken: view.scopeEditToken,
    uiSessionRevision: view.uiSessionRevision, nested: { scopeEditToken: view.scopeEditToken } });
  const exported = await bridge.handlers.get('/diagnostics-export')!({});
  expect(JSON.stringify(exported)).not.toContain(view.scopeEditToken);
  expect(JSON.stringify(exported)).not.toContain(view.uiSessionRevision);
  await vi.waitFor(async () => {
    const log = await fs.readFile(path.join(directory, 'hejhome', 'hejhome.log'), 'utf8');
    expect(log).toContain('ui.scope.save.persisted');
    expect(log).toContain('ui.scope.edit');
    expect(log).not.toContain(view.scopeEditToken);
    expect(log).not.toContain(view.uiSessionRevision);
  });
});

test('an expired scope token preserves the existing configuration', async () => {
  const clock = vi.spyOn(Date, 'now');
  const started = Date.now();
  try {
    clock.mockReturnValue(started);
    const view = await status();
    const before = await fs.readFile(bridge.config, 'utf8');
    clock.mockReturnValue(started + (30 * 60_000) + 1);
    await expect(scope()({ scope: { mode: 'all' }, scopeEditToken: view.scopeEditToken }))
      .rejects.toMatchObject({ requestError: { code: 'scope-edit-stale' } });
    expect(await fs.readFile(bridge.config, 'utf8')).toBe(before);
  } finally {
    clock.mockRestore();
  }
});

test('opaque UI session revision follows account identity, not credential renewal or network failure', async () => {
  const first = await status() as { uiSessionRevision: string };
  expect(first.uiSessionRevision).toMatch(/^[a-f0-9-]{36}$/);
  const diagnostic = await bridge.handlers.get('/diagnostics')!({}) as { uiSessionRevision: string };
  expect(diagnostic.uiSessionRevision).toBe(first.uiSessionRevision);
  await new SessionStore(directory).save(session('account-a@example.test'));
  vendor.failFamilies = true;
  expect((await status() as { uiSessionRevision: string }).uiSessionRevision).toBe(first.uiSessionRevision);
  vendor.failFamilies = false;
  await new SessionStore(directory).save(session('account-b@example.test'));
  const changed = await status() as { uiSessionRevision: string };
  expect(changed.uiSessionRevision).toMatch(/^[a-f0-9-]{36}$/);
  expect(changed.uiSessionRevision).not.toBe(first.uiSessionRevision);
  await bridge.handlers.get('/logout')!({});
  const loggedOut = await status() as { uiSessionRevision: string };
  expect(loggedOut.uiSessionRevision).not.toBe(changed.uiSessionRevision);
  const exportText = JSON.stringify(await bridge.handlers.get('/diagnostics-export')!({}));
  expect(exportText).not.toContain(first.uiSessionRevision);
  expect(exportText).not.toContain(changed.uiSessionRevision);
});

test('logout and same-account re-login preserve old files while owner gates keep their state stale', async () => {
  const snapshotPath = path.join(directory, 'hejhome', 'devices-snapshot.json');
  const statusPath = path.join(directory, 'hejhome', 'runtime-status.json');
  const snapshotBefore = await fs.readFile(snapshotPath, 'utf8');
  const oldOwner = sessionFingerprint((await new SessionStore(directory).load())!);
  await fs.writeFile(statusPath, JSON.stringify({ version: 1, ownerFingerprint: oldOwner,
    updatedAt: new Date().toISOString(), connection: { session: 'valid', realtime: 'connected' }, devices: [] }));
  const statusBefore = await fs.readFile(statusPath, 'utf8');
  await bridge.handlers.get('/logout')!({});
  expect(await new SessionStore(directory).load()).toBeNull();
  expect(await fs.readFile(snapshotPath, 'utf8')).toBe(snapshotBefore);
  expect(await fs.readFile(statusPath, 'utf8')).toBe(statusBefore);
  const loggedOut = await bridge.handlers.get('/diagnostics')!({}) as { devices: unknown[] };
  expect(loggedOut.devices).toEqual([]);
  await bridge.handlers.get('/send-verification')!({ identifier: 'account-a@example.test' });
  await bridge.handlers.get('/verify-code')!({ identifier: 'account-a@example.test', authCode: '123456' });
  await bridge.handlers.get('/login')!({ identifier: 'account-a@example.test', password: 'private' });
  expect(await fs.readFile(snapshotPath, 'utf8')).toBe(snapshotBefore);
  expect(await fs.readFile(statusPath, 'utf8')).toBe(statusBefore);
  const relogged = await bridge.handlers.get('/diagnostics')!({}) as { devices: unknown[] };
  expect(relogged.devices).toEqual([]);
});

test.each(['/diagnostics', '/session-status'])(
  '%s cannot return an old account response after a newer account revision', async (route) => {
    const first = await status() as { uiSessionRevision: string };
    const server = bridge.instance as { loadPlatformConfig(): Promise<unknown>; loadOwnedState(): Promise<unknown> };
    const originalConfig = server.loadPlatformConfig.bind(server);
    const originalOwned = server.loadOwnedState.bind(server);
    let release!: () => void;
    let entered!: () => void;
    let owned!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const configEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ownedRead = new Promise<void>((resolve) => {
      owned = resolve;
    });
    let holdFirst = true;
    server.loadPlatformConfig = async () => {
      const value = await originalConfig();
      if (holdFirst) {
        holdFirst = false;
        entered();
        await blocked;
      }
      return value;
    };
    server.loadOwnedState = async () => {
      const value = await originalOwned();
      owned();
      return value;
    };
    try {
      const late = bridge.handlers.get(route)!({});
      await Promise.all([configEntered, ownedRead]);
      const accountB = session('account-b@example.test');
      await new SessionStore(directory).save(accountB);
      await fs.writeFile(path.join(directory, 'hejhome', 'devices-snapshot.json'), JSON.stringify({
        ownerFingerprint: sessionFingerprint(accountB), generatedAt: new Date().toISOString(), families: [
          { family: { familyId: 2, name: 'B home' }, devices: [{ id: 'device-b', name: 'B device', deviceType: 'Plug' }] },
        ],
      }));
      const newer = await status() as { uiSessionRevision: string };
      expect(newer.uiSessionRevision).not.toBe(first.uiSessionRevision);
      release();
      await expect(late).rejects.toThrow();
      const after = await bridge.handlers.get('/diagnostics')!({}) as { uiSessionRevision: string; devices: Array<{ id: string }> };
      expect(after.uiSessionRevision).toBe(newer.uiSessionRevision);
      expect(after.devices.map((device) => device.id)).toEqual(['device-b']);
    } finally {
      release();
      server.loadPlatformConfig = originalConfig;
      server.loadOwnedState = originalOwned;
    }
  });
