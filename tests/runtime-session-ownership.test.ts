import fs from 'node:fs/promises';
import { expect, test } from 'vitest';
import { SessionStore, sessionFingerprint } from '../src/storage/sessionStore.js';
import { DeviceSnapshotStore } from '../src/storage/deviceSnapshotStore.js';
import { RuntimeStatusStore, loadRuntimeStatus } from '../src/runtime/status.js';
import type { HejSession } from '../src/types.js';

const session: HejSession = { identifier: 'account-example', accessToken: 'private-token-example', jsessionId: 'private-cookie-example',
  usernameCookie: 'private-user-example', autoLogin: true, expiresAt: 123456789 };

test('ownership fingerprints depend on effective session data rather than property order', async () => {
  const fingerprint = sessionFingerprint(session);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(sessionFingerprint({ expiresAt: session.expiresAt, autoLogin: true, usernameCookie: session.usernameCookie,
    jsessionId: session.jsessionId, accessToken: session.accessToken, identifier: session.identifier })).toBe(fingerprint);
  expect(sessionFingerprint({ ...session, accessToken: 'new-account-token' })).not.toBe(fingerprint);
  const storage = await fs.mkdtemp('/tmp/hej-owner-session-');
  try {
    const store = new SessionStore(storage); await store.save(session);
    expect(sessionFingerprint((await store.load())!)).toBe(fingerprint);
  } finally {
    await fs.rm(storage, { recursive: true, force: true });
  }
});

test('snapshot and status retain a private owner marker without including authentication values', async () => {
  const storage = await fs.mkdtemp('/tmp/hej-owner-files-');
  try {
    const ownerFingerprint = sessionFingerprint(session);
    const snapshots = new DeviceSnapshotStore(storage);
    await snapshots.save([{ family: { familyId: 1, name: 'Home' }, devices: [] }], ownerFingerprint);
    const statusStore = new RuntimeStatusStore(storage);
    await statusStore.save({ version: 1, ownerFingerprint, updatedAt: 'now', connection: { session: 'valid', realtime: 'connected' }, devices: [] });
    expect((await snapshots.load())?.ownerFingerprint).toBe(ownerFingerprint);
    expect((await loadRuntimeStatus(storage))?.ownerFingerprint).toBe(ownerFingerprint);
    const snapshotRaw = await fs.readFile(snapshots.path, 'utf8');
    const statusRaw = JSON.stringify(await loadRuntimeStatus(storage));
    for (const privateValue of [session.accessToken, session.jsessionId, session.usernameCookie, session.identifier]) {
      expect(snapshotRaw).not.toContain(privateValue);
      expect(statusRaw).not.toContain(privateValue);
    }
  } finally {
    await fs.rm(storage, { recursive: true, force: true });
  }
});
