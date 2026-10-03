import fs from 'node:fs/promises';
import { unwatchFile } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The host process is external; auth, redaction and disk persistence stay real.
const bridge = vi.hoisted(() => ({ storage: '', config: '', instance: null as unknown,
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>() }));
vi.mock('@homebridge/plugin-ui-utils', () => ({
  RequestError: class extends Error {
    constructor(message: string, public requestError: unknown) {
      super(message);
    }
  },
  HomebridgePluginUiServer: class {
    homebridgeStoragePath = bridge.storage;
    homebridgeConfigPath = bridge.config;
    constructor() {
      bridge.instance = this;
    }
    onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
      bridge.handlers.set(name, handler);
    }
    ready() {}
    pushEvent() {}
  },
}));

let exitListeners: Set<(...args: unknown[]) => void>;
let consoleLines: string[];
beforeEach(async () => {
  exitListeners = new Set(process.rawListeners('exit'));
  vi.resetModules();
  bridge.handlers.clear();
  bridge.storage = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-auth-redaction-'));
  bridge.config = path.join(bridge.storage, 'config.json');
  await fs.writeFile(bridge.config, JSON.stringify({ platforms: [{ platform: 'Hejhome' }] }));
  consoleLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => consoleLines.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => consoleLines.push(args.join(' ')));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const listener of process.rawListeners('exit')) {
    if (!exitListeners.has(listener)) {
      process.removeListener('exit', listener);
    }
  }
  unwatchFile(path.join(bridge.storage, 'hejhome/session.json'));
  unwatchFile(path.join(bridge.storage, 'hejhome/runtime-status.json'));
  await fs.rm(bridge.storage, { recursive: true, force: true });
});

test.each([
  JSON.stringify({ error_description: JSON.stringify({ authCode: '654321', access_token: 'synthetic-access' }) }),
  'error_description=authCode%3D654321%26access_token%3Dsynthetic-access',
  'Set-Cookie: JSESSIONID="synthetic-session"; Path=/',
])('real verification failures protect console, persisted logs and UI error detail: %s', async (body) => {
  vi.stubGlobal('fetch', async () => new Response(body, { status: 401 }));
  await import('../homebridge-ui/server.js');
  const error = await bridge.handlers.get('/verify-code')!({ identifier: 'user@example.test', authCode: '654321' })
    .catch((caught: { requestError: { detail: string } }) => caught);
  const detail = (error as { requestError: { detail: string } }).requestError.detail;
  // Appending a sentinel waits behind the server's real LogStore queue.
  const server = bridge.instance as { logStore: { append(level: string, event: string): Promise<void> } };
  await server.logStore.append('info', 'test.flush');
  const persisted = await fs.readFile(path.join(bridge.storage, 'hejhome/hejhome.log'), 'utf8');
  expect(detail).toContain('HTTP 401');
  expect(persisted).toContain('ui.verify-code.error');
  expect(consoleLines.join('\n')).toContain('ui.verify-code.error');
  for (const output of [detail, persisted, consoleLines.join('\n')]) {
    for (const secret of ['654321', 'synthetic-access', 'synthetic-session']) {
      expect(output).not.toContain(secret);
    }
  }
});
