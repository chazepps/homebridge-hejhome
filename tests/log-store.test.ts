import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { LogStore } from '../src/storage/logStore.js';

describe('LogStore', () => {
  test('redacts nested encoded error diagnostics before writing them to disk', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-log-nested-'));
    const store = new LogStore(storageRoot);
    const diagnostics = {
      status: 401,
      message: JSON.stringify({ error_description: JSON.stringify({ authCode: '654321', access_token: 'synthetic-access' }) }),
      body: 'error_description=authCode%3D654321%26access_token%3Dsynthetic-access',
      cookieHeader: 'Set-Cookie: JSESSIONID="synthetic-session"; Path=/',
    };
    const original = structuredClone(diagnostics);

    try {
      await store.append('error', 'ui.verify-code.error', diagnostics);
      const raw = fs.readFileSync(store.path, 'utf8');
      expect(raw).toContain('"status":401');
      for (const secret of ['654321', 'synthetic-access', 'synthetic-session']) {
        expect.soft(raw).not.toContain(secret);
      }
      expect(diagnostics).toEqual(original);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  test('appends redacted plugin diagnostics under the Homebridge storage path', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-log-'));
    const store = new LogStore(storageRoot);

    await store.append('info', 'ui.login', {
      identifier: 'user@example.test',
      password: 'secret-password',
      authorization: `Bearer${' '}access-token`,
      ok: true,
    });

    const raw = fs.readFileSync(store.path, 'utf8');
    const stat = fs.statSync(store.path);

    expect(store.path).toBe(path.join(storageRoot, 'hejhome', 'hejhome.log'));
    expect(raw).toContain('INFO ui.login');
    expect(raw).toContain('"ok":true');
    expect(raw).not.toContain('user@example.test');
    expect(raw).not.toContain('secret-password');
    expect(raw).not.toContain('access-token');
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('preserves append call order when writes are queued without awaiting each call', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-log-order-'));
    const store = new LogStore(storageRoot);

    const first = store.append('info', 'platform.session.loaded');
    const second = store.append('info', 'platform.accessory-load.start');
    const third = store.append('info', 'platform.snapshot.saved');
    await Promise.all([third, second, first]);

    const raw = fs.readFileSync(store.path, 'utf8');

    expect(raw.indexOf('platform.session.loaded')).toBeLessThan(raw.indexOf('platform.accessory-load.start'));
    expect(raw.indexOf('platform.accessory-load.start')).toBeLessThan(raw.indexOf('platform.snapshot.saved'));
  });
});
