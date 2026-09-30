import fs from 'node:fs/promises';
import { unwatchFile } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SessionStore, sessionFingerprint } from '../src/storage/sessionStore.js';

const bridge = vi.hoisted(() => ({ storage: '', config: '', handlers: new Map<string, (p: unknown) => Promise<unknown>>() }));
vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {},
  HomebridgePluginUiServer: class {
    homebridgeStoragePath = bridge.storage;
    homebridgeConfigPath = bridge.config;
    onRequest(name: string, fn: (p: unknown) => Promise<unknown>) {
      bridge.handlers.set(name, fn);
    }
    pushEvent() {}
    ready() {}
  },
}));
vi.mock('../dist/storage/logStore.js', () => ({
  LogStore: class {
    async append() {}
  },
}));

describe('custom UI server device settings and diagnostics', () => {
  let dir: string;
  let ownerFingerprint: string;
  let save: (payload: unknown) => Promise<unknown>;
  const baseConfig = { platforms: [{ platform: 'Hejhome', name: 'Hejhome',
    features: { matter: true, adaptiveLighting: true, meters: [] } }] };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-diag-'));
    bridge.storage = dir;
    bridge.config = path.join(dir, 'config.json');
    await fs.mkdir(path.join(dir, 'hejhome'));
    const session = { identifier: 'test@example.test', accessToken: 'private-token', jsessionId: 'private-session',
      usernameCookie: 'private-cookie', expiresAt: Date.now() + 3600000, autoLogin: true as const };
    await new SessionStore(dir).save(session);
    ownerFingerprint = sessionFingerprint(session);
    await fs.writeFile(bridge.config, JSON.stringify(baseConfig));
    await fs.writeFile(path.join(dir, 'hejhome', 'devices-snapshot.json'), JSON.stringify({ ownerFingerprint,
      generatedAt: new Date().toISOString(),
      families: [{ family: { familyId: 1, name: 'Private home' }, devices: [
        { id: 'plug-secret', name: 'Private plug', deviceType: 'Plug' },
        { id: 'sensor-secret', name: 'Private sensor', deviceType: 'SensorTh' },
        { id: 'hvac-secret', name: 'Private AC', deviceType: 'IrAirconditioner' },
        { id: 'tv-secret', name: 'Private TV', deviceType: 'IrTv' },
        { id: 'purifier-secret', name: 'Private purifier', deviceType: 'Airpurifier' },
        { id: 'strip-secret', name: 'Private power strip', deviceType: 'PowerStrip' },
      ] }] }));
    await fs.writeFile(path.join(dir, 'hejhome', 'runtime-status.json'), JSON.stringify({
      version: 1, ownerFingerprint, updatedAt: new Date().toISOString(), controlsAvailable: true,
      connection: { session: 'valid', realtime: 'connected', accessToken: 'token-secret' },
      devices: [{ id: 'plug-secret', name: 'Private plug', deviceType: 'Plug', online: true,
        lastSeenAt: null, lastControlAt: null, lastControl: 'success', homekit: true, matter: false },
      { id: 'hvac-secret', name: 'Private AC', deviceType: 'IrAirconditioner', online: true,
        lastSeenAt: null, lastControlAt: null, lastControl: 'unknown', homekit: true, matter: false,
        hvacSettings: { power: true, targetTemperature: 23, mode: 'cool', fanSpeed: 'low' } },
      { id: 'purifier-secret', name: 'Private purifier', deviceType: 'Airpurifier', online: true,
        lastSeenAt: null, lastControlAt: null, lastControl: 'unknown', homekit: true, matter: false,
        purifierSettings: { power: true, mode: 'sleep' } }],
    }));
    await import('../homebridge-ui/server.js');
    expect(bridge.handlers.get('/remote-command')).toBeDefined();
    expect(bridge.handlers.get('/air-conditioner-command')).toBeDefined();
    save = bridge.handlers.get('/save-device-settings')!;
    expect(save).toBeDefined();
  });

  beforeEach(async () => {
    await fs.writeFile(bridge.config, JSON.stringify(baseConfig));
  });

  afterAll(async () => {
    unwatchFile(path.join(dir, 'hejhome', 'runtime-status.json'));
    unwatchFile(path.join(dir, 'hejhome', 'session.json'));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('saves allowed device options without losing feature flags or other device settings', async () => {
    await save({ deviceId: 'plug-secret', preference: { visibility: 'matter', name: 'My lamp', role: 'light' } });
    await save({ deviceId: 'hvac-secret', preference: { temperatureSensorId: 'sensor-secret' } });
    await save({ deviceId: 'sensor-secret', preference: { freshnessMinutes: 30 } });
    await save({ deviceId: 'tv-secret', preference: { remoteButtons: true } });
    await save({ deviceId: 'purifier-secret', preference: { pm25Multiplier: 0.5, freshnessMinutes: 30 } });
    await save({ deviceId: 'strip-secret', preference: { role: 'light' } });
    const stored = JSON.parse(await fs.readFile(bridge.config, 'utf8')).platforms[0].features;
    expect(stored).toMatchObject({ matter: true, adaptiveLighting: true, devices: {
      'plug-secret': { visibility: 'matter', name: 'My lamp', role: 'light' },
      'hvac-secret': { temperatureSensorId: 'sensor-secret' },
      'sensor-secret': { freshnessMinutes: 30 },
      'tv-secret': { remoteButtons: true },
      'purifier-secret': { pm25Multiplier: 0.5, freshnessMinutes: 30 },
      'strip-secret': { role: 'light' },
    } });
    await bridge.handlers.get('/save-features')!({ features: { matter: false, adaptiveLighting: true, meters: [] } });
    expect(JSON.parse(await fs.readFile(bridge.config, 'utf8')).platforms[0].features.devices)
      .toMatchObject(stored.devices);
  });

  test('rejects invalid feature and unsupported device settings without changing config', async () => {
    const beforeInvalid = await fs.readFile(bridge.config, 'utf8');
    await expect(bridge.handlers.get('/save-features')!({})).rejects.toThrow();
    await expect(bridge.handlers.get('/save-features')!({ features: { devices: {
      'sensor-secret': { role: 'light' },
    } } })).rejects.toThrow();
    expect(await fs.readFile(bridge.config, 'utf8')).toBe(beforeInvalid);
    await expect(save({ deviceId: 'sensor-secret', preference: { role: 'light' } })).rejects.toThrow();
    await expect(save({ deviceId: 'hvac-secret', preference: { temperatureSensorId: 'plug-secret' } })).rejects.toThrow();
    await expect(save({ deviceId: 'unknown', preference: { visibility: 'hidden' } })).rejects.toThrow();
    await expect(save({ deviceId: 'plug-secret', preference: { freshnessMinutes: 30 } })).rejects.toThrow();
    await expect(save({ deviceId: 'sensor-secret', preference: { remoteButtons: true } })).rejects.toThrow();
    await expect(save({ deviceId: 'tv-secret', preference: { visibility: 'matter', remoteButtons: true } })).rejects.toThrow();
    await expect(save({ deviceId: 'tv-secret', preference: { pm25Multiplier: 0.5 } })).rejects.toThrow();
    await expect(save({ deviceId: 'purifier-secret', preference: { freshnessMinutes: 30 } })).rejects.toThrow();
    await expect(save({ deviceId: 'purifier-secret', preference: { role: 'light' } })).rejects.toThrow();
    expect(await fs.readFile(bridge.config, 'utf8')).toBe(beforeInvalid);
  });

  test('exports anonymous diagnostics and validates live settings for owned devices', async () => {
    const exported = JSON.stringify(await bridge.handlers.get('/diagnostics-export')!({}));
    expect(exported).not.toContain('secret');
    expect(exported).not.toContain('Private');
    expect(exported).toContain('"session":"valid"');
    expect(exported).not.toContain(ownerFingerprint);
    const diagnostics = await bridge.handlers.get('/diagnostics')!({}) as { devices: Array<{ id: string,
      hvacSettings?: { targetTemperature: number }, purifierSettings?: { mode: string } }> };
    expect(diagnostics.devices.find((item) => item.id === 'hvac-secret')?.hvacSettings?.targetTemperature).toBe(23);
    expect(diagnostics.devices.find((item) => item.id === 'purifier-secret')?.purifierSettings?.mode).toBe('sleep');
    expect((diagnostics.devices.find((item) => item.id === 'purifier-secret') as { roleChangeSupported: boolean }).roleChangeSupported)
      .toBe(false);
  });
});
