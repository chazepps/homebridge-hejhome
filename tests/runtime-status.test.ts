import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { loadRuntimeStatus, runtimeStatusPath, RuntimeStatusStore, type RuntimeStatus } from '../src/runtime/status.js';

test('runtime status is atomic, ordered, private and exposes no session secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-status-'));
  try {
    expect(await loadRuntimeStatus(dir)).toBeNull();
    const store = new RuntimeStatusStore(dir);
    const first: RuntimeStatus = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', connection: { session: 'expired', realtime: 'connected' }, devices: [] };
    const last: RuntimeStatus = { ...first, updatedAt: '2026-01-01T00:00:01.000Z', connection: { session: 'valid', realtime: 'connected' } };
    await Promise.all([store.save(first), store.save(last)]);
    expect(await loadRuntimeStatus(dir)).toEqual(last);
    expect((await fs.stat(runtimeStatusPath(dir))).mode & 0o777).toBe(0o600);
    await fs.writeFile(runtimeStatusPath(dir), '{broken');
    expect(await loadRuntimeStatus(dir)).toBeNull();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a burst stores only the in-flight and latest pending status, and flush waits for both', async () => {
  const { vi } = await import('vitest');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-status-burst-'));
  const original = fs.writeFile.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
    await gate; return original(...args);
  });
  try {
    const store = new RuntimeStatusStore(dir);
    const base: RuntimeStatus = { version: 1, updatedAt: '0', connection: { session: 'valid', realtime: 'connected' }, devices: [] };
    const first = store.save(base);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const burst = Array.from({ length: 100 }, (_, i) => store.save({ ...base, updatedAt: String(i + 1) }));
    release(); await Promise.all([first, ...burst]);
    await store.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect((await loadRuntimeStatus(dir))?.updatedAt).toBe('100');
  } finally {
    write.mockRestore(); await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed status write does not poison later writes', async () => {
  const { vi } = await import('vitest');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-status-recovery-'));
  const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
  try {
    const store = new RuntimeStatusStore(dir);
    const status: RuntimeStatus = { version: 1, updatedAt: 'recovered', connection: { session: 'valid', realtime: 'connected' }, devices: [] };
    await expect(store.save(status)).rejects.toThrow('disk unavailable');
    await store.save(status);
    expect(await loadRuntimeStatus(dir)).toEqual(status);
  } finally {
    write.mockRestore(); await fs.rm(dir, { recursive: true, force: true });
  }
});
