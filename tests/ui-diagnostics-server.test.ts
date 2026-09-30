import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

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

test('device settings preserve feature flags and reject unsupported role and sensor; export omits identities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-diag-'));
  bridge.storage = dir;
  bridge.config = path.join(dir, 'config.json');
  await fs.mkdir(path.join(dir, 'hejhome'));
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome', name: 'Hejhome',
    features: { matter: true, adaptiveLighting: true, meters: [] } }] }));
  await fs.writeFile(path.join(dir, 'hejhome', 'devices-snapshot.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
    families: [{ family: { familyId: 1, name: 'Private home' }, devices: [
      { id: 'plug-secret', name: 'Private plug', deviceType: 'Plug' },
      { id: 'sensor-secret', name: 'Private sensor', deviceType: 'SensorTh' },
      { id: 'hvac-secret', name: 'Private AC', deviceType: 'IrAirconditioner' },
    ] }] }));
  await fs.writeFile(path.join(dir, 'hejhome', 'runtime-status.json'), JSON.stringify({
    version: 1, updatedAt: new Date().toISOString(), controlsAvailable: true,
    connection: { session: 'valid', realtime: 'connected', accessToken: 'token-secret' },
    devices: [{ id: 'plug-secret', name: 'Private plug', deviceType: 'Plug', online: true,
      lastSeenAt: null, lastControlAt: null, lastControl: 'success', homekit: true, matter: false }],
  }));
  try {
    await import('../homebridge-ui/server.js');
    expect(bridge.handlers.get('/remote-command')).toBeDefined();
    expect(bridge.handlers.get('/air-conditioner-command')).toBeDefined();
    const save = bridge.handlers.get('/save-device-settings')!;
    expect(save).toBeDefined();
    await save({ deviceId: 'plug-secret', preference: { visibility: 'matter', name: 'My lamp', role: 'light' } });
    await save({ deviceId: 'hvac-secret', preference: { temperatureSensorId: 'sensor-secret' } });
    const stored = JSON.parse(await fs.readFile(bridge.config, 'utf8')).platforms[0].features;
    expect(stored).toMatchObject({ matter: true, adaptiveLighting: true, devices: {
      'plug-secret': { visibility: 'matter', name: 'My lamp', role: 'light' },
      'hvac-secret': { temperatureSensorId: 'sensor-secret' },
    } });
    await bridge.handlers.get('/save-features')!({ features: { matter: false, adaptiveLighting: true, meters: [] } });
    expect(JSON.parse(await fs.readFile(bridge.config, 'utf8')).platforms[0].features.devices)
      .toMatchObject(stored.devices);
    const beforeInvalid = await fs.readFile(bridge.config, 'utf8');
    await expect(bridge.handlers.get('/save-features')!({})).rejects.toThrow();
    await expect(bridge.handlers.get('/save-features')!({ features: { devices: {
      'sensor-secret': { role: 'light' },
    } } })).rejects.toThrow();
    expect(await fs.readFile(bridge.config, 'utf8')).toBe(beforeInvalid);
    await expect(save({ deviceId: 'sensor-secret', preference: { role: 'light' } })).rejects.toThrow();
    await expect(save({ deviceId: 'hvac-secret', preference: { temperatureSensorId: 'plug-secret' } })).rejects.toThrow();
    await expect(save({ deviceId: 'unknown', preference: { visibility: 'hidden' } })).rejects.toThrow();
    const exported = JSON.stringify(await bridge.handlers.get('/diagnostics-export')!({}));
    expect(exported).not.toContain('secret');
    expect(exported).not.toContain('Private');
    expect(exported).toContain('"session":"valid"');
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
