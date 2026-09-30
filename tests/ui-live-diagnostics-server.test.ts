import fs from 'node:fs/promises';
import { unwatchFile } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import { RuntimeCommandServer } from '../src/runtime/commands.js';
import { RuntimeStatusStore } from '../src/runtime/status.js';
import { sessionFingerprint } from '../src/storage/sessionStore.js';

const bridge = vi.hoisted(() => ({ storage: '', config: '', events: [] as string[],
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>() }));
vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {},
  HomebridgePluginUiServer: class {
    homebridgeStoragePath = bridge.storage;
    homebridgeConfigPath = bridge.config;
    onRequest(name: string, fn: (payload: unknown) => Promise<unknown>) {
      bridge.handlers.set(name, fn);
    }
    pushEvent(name: string) {
      bridge.events.push(name);
    }
    ready() {}
  },
}));
vi.mock('../dist/hej/rest.js', () => ({
  HejRestClient: class {
    async getFamilies() {
      return [{ familyId: 1, name: 'Current home' }];
    }
    async getRooms() {
      return [];
    }
  },
}));

test('owned files, push events and Unix command socket reject old account state across replacement and logout', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-live-'));
  const dataDir = path.join(dir, 'hejhome');
  bridge.storage = dir;
  bridge.config = path.join(dir, 'config.json');
  bridge.events.length = 0;
  await fs.mkdir(dataDir);
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome', name: 'Hejhome',
    features: { matter: false, adaptiveLighting: false, meters: [] } }] }));
  const session = (identifier: string) => ({ identifier, accessToken: `token-${identifier}`,
    jsessionId: `session-${identifier}`, usernameCookie: `cookie-${identifier}`,
    expiresAt: Date.now() + 3600000, autoLogin: true });
  const accountA = session('account-a@example.test');
  const accountB = session('account-b@example.test');
  const writeSession = (value: typeof accountA) => fs.writeFile(path.join(dataDir, 'session.json'), JSON.stringify(value));
  const writeSnapshot = (ownerFingerprint: string, id: string, deviceType = 'IrTv') => fs.writeFile(path.join(dataDir, 'devices-snapshot.json'),
    JSON.stringify({ ownerFingerprint, generatedAt: new Date().toISOString(), families: [
      { family: { familyId: 1, name: 'Home' }, devices: [{ id, name: id, deviceType }] },
    ] }));
  const store = new RuntimeStatusStore(dir);
  const writeStatus = (ownerFingerprint: string, id: string, realtime: 'connected' | 'disconnected') =>
    store.save({ version: 1, ownerFingerprint, updatedAt: new Date().toISOString(), controlsAvailable: true,
      connection: { session: 'valid', realtime }, devices: [{ id, name: id, deviceType: 'IrTv', online: true,
        lastSeenAt: null, lastControlAt: null, lastControl: 'unknown', homekit: true, matter: false }] });
  const sent: string[] = [];
  const socket = new RuntimeCommandServer(dir, async (request) => {
    sent.push(request.deviceId);
  });
  try {
    await writeSession(accountA);
    await writeSnapshot(sessionFingerprint(accountA), 'old-tv');
    await writeStatus(sessionFingerprint(accountA), 'old-tv', 'connected');
    await import('../homebridge-ui/server.js');
    const diagnostics = bridge.handlers.get('/diagnostics')!;
    const remote = bridge.handlers.get('/remote-command')!;
    expect((await diagnostics({}) as { devices: Array<{ id: string }> }).devices.map((device) => device.id)).toEqual(['old-tv']);
    expect(await socket.start()).toBe(true);
    await remote({ deviceId: 'old-tv', command: { type: 'volume', direction: 'up' } });
    expect(sent).toEqual(['old-tv']);

    bridge.events.length = 0;
    await writeSession(accountB);
    await expect.poll(() => bridge.events, { timeout: 5000, interval: 100 }).toContain('hejhome-status-changed');
    await writeSnapshot(sessionFingerprint(accountA), 'old-tv'); // late old-account discovery write
    await writeStatus(sessionFingerprint(accountA), 'old-tv', 'disconnected');
    const replaced = await diagnostics({}) as { devices: unknown[], connection: { session: string } };
    expect(replaced.devices).toEqual([]);
    expect(replaced.connection.session).not.toBe('valid');
    const status = await bridge.handlers.get('/session-status')!({}) as { deviceSummary: { registeredCount: number } };
    expect(status.deviceSummary.registeredCount).toBe(0);
    await expect(bridge.handlers.get('/save-device-settings')!({ deviceId: 'old-tv', preference: { name: 'Old' } })).rejects.toThrow();
    await expect(remote({ deviceId: 'old-tv', command: { type: 'volume', direction: 'up' } })).rejects.toThrow();
    expect(sent).toEqual(['old-tv']);

    await fs.writeFile(path.join(dataDir, 'devices-snapshot.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), families: [{ family: { familyId: 1, name: 'Legacy home' },
        devices: [{ id: 'legacy-tv', name: 'legacy-tv', deviceType: 'IrTv' }] }],
    }));
    expect((await diagnostics({}) as { devices: unknown[] }).devices).toEqual([]);

    await writeSnapshot(sessionFingerprint(accountB), 'new-tv');
    await writeStatus(sessionFingerprint(accountB), 'new-tv', 'connected');
    expect((await diagnostics({}) as { devices: Array<{ id: string }> }).devices.map((device) => device.id)).toEqual(['new-tv']);
    await expect.poll(() => bridge.events, { timeout: 5000, interval: 100 }).toContain('hejhome-status-changed');

    await writeSnapshot(sessionFingerprint(accountB), 'purifier-1', 'Airpurifier');
    await bridge.handlers.get('/purifier-command')!({ deviceId: 'purifier-1', command: { mode: 'manual' } });
    expect(sent).toEqual(['old-tv', 'purifier-1']);

    bridge.events.length = 0;
    await fs.rm(path.join(dataDir, 'session.json'));
    await expect.poll(() => bridge.events, { timeout: 5000, interval: 100 }).toContain('hejhome-status-changed');
    await writeSnapshot(sessionFingerprint(accountB), 'new-tv'); // late write after logout
    expect((await diagnostics({}) as { devices: unknown[] }).devices).toEqual([]);
    const loggedOut = await bridge.handlers.get('/session-status')!({}) as { deviceSummary: { registeredCount: number } };
    expect(loggedOut.deviceSummary.registeredCount).toBe(0);
    await expect(remote({ deviceId: 'new-tv', command: { type: 'volume', direction: 'up' } })).rejects.toThrow();
    expect(sent).toEqual(['old-tv', 'purifier-1']);
  } finally {
    await socket.stop();
    unwatchFile(path.join(dataDir, 'runtime-status.json'));
    unwatchFile(path.join(dataDir, 'session.json'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 12000);
