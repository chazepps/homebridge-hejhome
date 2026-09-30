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
    ready() {}
  },
}));

test('saving feature opt-ins preserves login, scope and child bridge configuration; invalid profiles do not write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-ui-features-'));
  bridge.storage = dir;
  bridge.config = path.join(dir, 'config.json');
  const original = { bridge: { name: 'Main' }, platforms: [{ platform: 'Other' }, { platform: 'Hejhome', auth: { sessionConfigured: true },
    scope: { mode: 'all' }, _bridge: { username: 'AA:BB:CC:DD:EE:FF', matter: { enabled: true } } }] };
  await fs.writeFile(bridge.config, JSON.stringify(original));
  try {
    await import('../homebridge-ui/server.js');
    const save = bridge.handlers.get('/save-features')!;
    expect(save).toBeDefined();
    await save({ features: { matter: true, adaptiveLighting: true } });
    const stored = JSON.parse(await fs.readFile(bridge.config, 'utf8'));
    expect(stored.platforms[1]).toEqual({ ...original.platforms[1], features: { matter: true, adaptiveLighting: true, meters: [] } });
    expect(stored.platforms[0]).toEqual(original.platforms[0]);
    expect(stored.bridge).toEqual(original.bridge);
    await expect(save({ features: { meters: [{ model: 'x', power: { field: 'curPower' } }] } })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(bridge.config, 'utf8'))).toEqual(stored);
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
