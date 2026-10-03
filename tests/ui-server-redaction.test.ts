import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RequestError } from '@homebridge/plugin-ui-utils';

import type { LogStore } from '../src/storage/logStore.js';

type Handler = (payload: unknown) => Promise<unknown>;
const host = vi.hoisted(() => ({
  storagePath: '',
  handlers: new Map<string, Handler>(),
  server: undefined as { logStore: LogStore } | undefined,
}));

// Only replace the external Homebridge IPC host. Auth, error conversion,
// redaction, and the filesystem LogStore are the production implementation.
vi.mock('@homebridge/plugin-ui-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@homebridge/plugin-ui-utils')>();
  return {
    ...actual,
    HomebridgePluginUiServer: class {
      homebridgeStoragePath = host.storagePath;
      homebridgeConfigPath = '';

      constructor() {
        host.server = this as unknown as { logStore: LogStore };
      }

      onRequest(name: string, handler: Handler) {
        host.handlers.set(name, handler);
      }

      ready() {}
    },
  };
});

describe('UI authentication diagnostic redaction', () => {
  beforeEach(async () => {
    vi.resetModules();
    host.handlers.clear();
    host.storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'hejhome-ui-redaction-'));
  });

  afterEach(async () => {
    if (host.server) {
      await host.server.logStore.append('debug', 'test.flush');
    }
    vi.unstubAllGlobals();
    await fs.rm(host.storagePath, { recursive: true, force: true });
    host.server = undefined;
  });

  test.each([
    { name: 'nested JSON', body: JSON.stringify({ error_description: JSON.stringify({ authCode: '654321', access_token: 'synthetic-access' }) }) },
    { name: 'encoded form', body: 'error_description=authCode%3D654321%26access_token%3Dsynthetic-access' },
    { name: 'quoted cookie', body: 'Set-Cookie: JSESSIONID="synthetic-session"; Path=/' },
  ].flatMap((fixture) => ['response', 'transport'].map((mode) => ({ ...fixture, mode }))))(
    'keeps $name $mode credentials out of /verify-code console, disk, and RequestError detail',
    async ({ body, mode }) => {
      const consoleLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line) => consoleLines.push(String(line)));
      vi.spyOn(console, 'error').mockImplementation((line) => consoleLines.push(String(line)));
      vi.stubGlobal('fetch', async () => {
        if (mode === 'transport') {
          throw new Error(`HTTP 401 ${body}`);
        }
        return new Response(body, { status: 401 });
      });
      await import('../homebridge-ui/server.js');

      const handler = host.handlers.get('/verify-code');
      expect(handler).toBeTypeOf('function');
      const error = await handler!({ identifier: 'user@example.test', authCode: '654321' }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RequestError);
      const detail = (error as RequestError).requestError as { detail: string };
      expect(detail.detail).toContain('HTTP 401');
      await host.server!.logStore.append('debug', 'test.flush');
      const disk = await fs.readFile(host.server!.logStore.path, 'utf8');

      for (const diagnostic of [consoleLines.join('\n'), disk, JSON.stringify(detail)]) {
        expect(diagnostic).toContain('401');
        for (const secret of ['654321', 'synthetic-access', 'synthetic-session', 'user@example.test']) {
          expect.soft(diagnostic).not.toContain(secret);
        }
      }
      expect(disk).toContain('ui.verify-code.error');
      expect(disk).toContain('auth.2fa.verify');
    },
  );
});
