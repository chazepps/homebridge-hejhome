import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { SessionStore } from '../src/storage/sessionStore.js';

describe('SessionStore', () => {
  test('persists sessions under the Homebridge storage path without password fields', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-session-'));
    const store = new SessionStore(storageRoot);

    await store.save({
      identifier: 'user@example.test',
      autoLogin: true,
      accessToken: 'access-token',
      jsessionId: 'session-id',
      usernameCookie: 'user%40example.test',
      expiresAt: 123,
    });

    const sessionFile = path.join(storageRoot, 'hejhome', 'session.json');
    const raw = fs.readFileSync(sessionFile, 'utf8');
    const loaded = await store.load();

    expect(sessionFile.startsWith(storageRoot)).toBe(true);
    expect(raw).not.toContain('password');
    expect(loaded?.autoLogin).toBe(true);
    expect(loaded?.accessToken).toBe('access-token');
  });

  test('returns null when no session exists', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-session-empty-'));
    const store = new SessionStore(storageRoot);

    await expect(store.load()).resolves.toBeNull();
  });
});
