import fs from 'node:fs/promises';
import { unwatchFile, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sessionFingerprint } from '../src/storage/sessionStore.js';

const bridge = vi.hoisted(() => ({
  storage: '', config: '', replaceOnLoginEvent: false, familyCalls: 0,
  handlers: new Map<string, (payload?: unknown) => Promise<unknown>>(),
}));
const session = (identifier: string) => ({ identifier, accessToken: 'test-access', jsessionId: 'test-session',
  usernameCookie: identifier, autoLogin: true, expiresAt: Date.now() + 86400000 });

vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {},
  HomebridgePluginUiServer: class {
    homebridgeStoragePath = bridge.storage;
    homebridgeConfigPath = bridge.config;
    onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
      bridge.handlers.set(name, handler);
    }
    ready() {}
    pushEvent() {
      if (bridge.replaceOnLoginEvent) {
        bridge.replaceOnLoginEvent = false;
        writeFileSync(path.join(bridge.storage, 'hejhome/session.json'), JSON.stringify(session('other@example.test')));
      }
    }
  },
}));
vi.mock('../dist/hej/auth.js', () => ({ HejAuthClient: class {
  async verifyCode() {}
  async loginWithPassword({ identifier }: { identifier: string }) {
    return session(identifier);
  }
} }));
vi.mock('../dist/hej/rest.js', () => ({ HejRestClient: class {
  async getFamilies() {
    bridge.familyCalls++;
    return [];
  }
  dispose() {}
} }));
vi.mock('../dist/storage/logStore.js', () => ({ LogStore: class {
  async append() {}
} }));

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  bridge.handlers.clear();
  bridge.replaceOnLoginEvent = false;
  bridge.familyCalls = 0;
  bridge.storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-login-ack-'));
  bridge.config = path.join(bridge.storage, 'config.json');
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome' }] }));
  await import('../homebridge-ui/server.js');
});
afterEach(async () => {
  unwatchFile(path.join(bridge.storage, 'hejhome/session.json'));
  unwatchFile(path.join(bridge.storage, 'hejhome/runtime-status.json'));
  await fs.rm(bridge.storage, { recursive: true, force: true });
});

test('login ACK identifies the new session revision observed by status events', async () => {
  const status = bridge.handlers.get('/session-status')!;
  const before = await status() as { uiSessionRevision: string };
  await bridge.handlers.get('/verify-code')!({ identifier: 'user@example.test', authCode: '123456' });
  const ack = await bridge.handlers.get('/login')!({ identifier: 'user@example.test', password: 'test-password' }) as
    { ok: boolean; uiSessionRevision: string };
  const after = await status() as { uiSessionRevision: string };
  expect(ack.ok).toBe(true);
  expect(ack.uiSessionRevision).toBe(after.uiSessionRevision);
  expect(ack.uiSessionRevision).not.toBe(before.uiSessionRevision);
});

test('login cannot acknowledge a session replaced before its response is returned', async () => {
  await bridge.handlers.get('/verify-code')!({ identifier: 'user@example.test', authCode: '123456' });
  bridge.replaceOnLoginEvent = true;
  await expect(bridge.handlers.get('/login')!({ identifier: 'user@example.test', password: 'test-password' })).rejects.toThrow();
  const stored = JSON.parse(await fs.readFile(path.join(bridge.storage, 'hejhome/session.json'), 'utf8'));
  expect(stored.identifier).toBe('other@example.test');
});

test('local diagnostics detects settings changes without requesting cloud inventory', async () => {
  const dataDir = path.join(bridge.storage, 'hejhome');
  const current = session('user@example.test');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'session.json'), JSON.stringify(current));
  const runtime = { version: 1, ownerFingerprint: sessionFingerprint(current), updatedAt: '2026-10-02T01:00:00.000Z',
    connection: { session: 'valid', realtime: 'connected' }, devices: [] };
  await fs.writeFile(path.join(dataDir, 'runtime-status.json'), JSON.stringify(runtime));
  const status = bridge.handlers.get('/session-status')!;
  const diagnostics = bridge.handlers.get('/diagnostics')!;
  const initial = await status() as { settingsRevision: string };
  const first = await diagnostics() as { settingsRevision: string; updatedAt: string };
  expect(first.settingsRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(first.settingsRevision).toBe(initial.settingsRevision);
  await fs.writeFile(path.join(dataDir, 'runtime-status.json'), JSON.stringify({ ...runtime, updatedAt: '2026-10-02T01:00:02.000Z' }));
  const heartbeat = await diagnostics() as typeof first;
  expect(heartbeat.updatedAt).not.toBe(first.updatedAt);
  expect(heartbeat.settingsRevision).toBe(first.settingsRevision);
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome', features: { matter: true } }] }));
  const changed = await diagnostics() as typeof first;
  expect(changed.settingsRevision).not.toBe(first.settingsRevision);
  expect(bridge.familyCalls).toBe(1);
  expect((await status() as typeof initial).settingsRevision).toBe(changed.settingsRevision);
});
